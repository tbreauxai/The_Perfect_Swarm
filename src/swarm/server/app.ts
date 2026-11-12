import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { getOrCreateDefaultCortex } from '../engine/index.ts';
import { createTelemetryMiddleware } from '../telemetry.ts';
import { initBenchmarker } from '../benchmark.ts';
import type { SwarmServerOptions, SwarmServerApp } from './types.ts';
import { restoreLearningState } from './learningState.ts';
import { ensureCatalogProbeFresh, probeAllProviders } from './modelsProvider.ts';
import { createAppAuthMiddleware } from './appAuth.ts';
import { createCorsMiddleware } from './cors.ts';
import { initFeedbackDedupe } from './feedbackDedupe.ts';
import {
    type ServerRouteContext,
    handleServerError,
    registerAnalyzeRoutes,
    registerFeedbackRoutes,
    registerMorningRoutes,
    registerModelsRoutes
} from './routes/index.ts';

// Re-export all route helpers for 100% backward compatibility
export * from './routes/helpers.ts';
export * from './routes/types.ts';

export function chicagoParts(now: Date | number): { dateKey: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(now instanceof Date ? now : new Date(now));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return {
        dateKey: `${values.year}-${values.month}-${values.day}`,
        hour: Number(values.hour)
    };
}

export function scheduledChicagoProbeDateKey(now: Date | number, lastProbeDateKey: string): string | null {
    const parts = chicagoParts(now);
    return parts.hour === 3 && parts.dateKey !== lastProbeDateKey ? parts.dateKey : null;
}

/**
 * Creates a standalone, zero-external-dependency Hono app for headless swarm deployments.
 * Supports both Edge runtimes (Cloudflare Pages/Workers) and Node.js (`server.listen()`).
 */
export function createSwarmServer(options: SwarmServerOptions = {}): SwarmServerApp {
    const app = new Hono() as SwarmServerApp;
    const defaultSettings = options.defaultSettings || {};
    const defaultAi = options.defaultAi;
    const defaultCortex = options.defaultCortex || getOrCreateDefaultCortex(defaultSettings.appId || 'perfect-swarm', defaultAi);
    let nodeServer: ServerType | null = null;

    if (typeof process !== 'undefined' && process.env) {
        initBenchmarker(process.env);
    }

    // Initialize persistent dedupe (if RENDER_DISK_PATH is set)
    initFeedbackDedupe();

    // Restore durable learning state in the background: never blocks boot or requests.
    restoreLearningState().catch((err) =>
        console.warn('[SwarmServer] Background learning-state restore failed:', err?.message || err)
    );

    const serverEnv = typeof process !== 'undefined' ? (process.env as Record<string, any>) : {};
    if (serverEnv.SWARM_STARTUP_PROBE === '1' || serverEnv.SWARM_STARTUP_BENCHMARK === '1') {
        probeAllProviders(serverEnv).catch((err) =>
            console.warn('[catalog] Background catalog warming failed:', err?.message || err)
        );
    }

    // Catch up in the background because the free Render instance may sleep through the scheduled hour.
    ensureCatalogProbeFresh(serverEnv).catch((err) =>
        console.warn('[catalog] startup catch-up failed:', err?.message || err)
    );

    // The free Render instance may sleep through 3 AM; probe once per Chicago date when awake.
    if (typeof setInterval !== 'undefined') {
        let lastProbeDateKey = '';
        setInterval(() => {
            const dateKey = scheduledChicagoProbeDateKey(new Date(), lastProbeDateKey);
            if (!dateKey) return;
            lastProbeDateKey = dateKey;
            const env = typeof process !== 'undefined' ? process.env : {};
            probeAllProviders(env as Record<string, any>).catch((err) =>
                console.warn('[catalog] scheduled probe failed:', err?.message || err)
            );
        }, 15 * 60 * 1000);
    }

    app.listen = function (portOrOpts?: any, hostnameOrCb?: any, cb?: any): any {
        let port = typeof portOrOpts === 'number' ? portOrOpts : (options.port ?? 3000);
        let hostname = typeof hostnameOrCb === 'string' ? hostnameOrCb : (options.host ?? '0.0.0.0');
        let callback = typeof hostnameOrCb === 'function' ? hostnameOrCb : (typeof cb === 'function' ? cb : undefined);

        if (typeof portOrOpts === 'function') {
            callback = portOrOpts;
            port = options.port ?? 3000;
        }

        if (!nodeServer) {
            nodeServer = createAdaptorServer({ fetch: app.fetch });
        }
        return nodeServer.listen(port, hostname, callback);
    };

    app.address = function (): any {
        return nodeServer?.address() || { port: options.port ?? 3000 };
    };

    app.close = function (cb?: (err?: Error) => void): any {
        if (nodeServer) {
            return nodeServer.close(cb);
        }
        if (cb) cb();
    };

    // Apply security headers to every response
    app.use('*', async (c, next) => {
        c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://the-perfect-swarm.onrender.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        c.header('X-Frame-Options', 'DENY');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        await next();
    });

    if (options.cors !== false) {
        app.use('*', createCorsMiddleware());
    }

    // Caller token identifies the app. It does not restrict sibling memory reads.
    // /api/health stays open for the keep-awake ping.
    app.use('*', async (c, next) => {
        if ((c as any).get('callerAppId')) return next();
        return createAppAuthMiddleware()(c, next);
    });

    // Apply telemetry middleware to track request latency across all endpoints
    app.use('*', createTelemetryMiddleware());

    app.onError((err, c) => {
        return handleServerError('Unhandled', err, c);
    });

    app.get('/api/health', (c) => {
        return c.json({ status: 'ok', edge: true });
    });

    const swarmBodyLimit = bodyLimit({
        maxSize: 10 * 1024 * 1024, // Expanded to 10MB to support high-volume datasets
        onError: (c) => c.json({ error: 'Payload Too Large' }, 413)
    });

    const routeCtx: ServerRouteContext = {
        defaultSettings,
        defaultAi,
        defaultCortex,
        swarmBodyLimit
    };

    // Register modular route controllers
    registerFeedbackRoutes(app, routeCtx);
    registerMorningRoutes(app, routeCtx);
    registerModelsRoutes(app, routeCtx);
    registerAnalyzeRoutes(app, routeCtx);

    app.all('/api/*', (c) => {
        return c.json({ error: 'Not found' }, 404);
    });

    return app;
}
