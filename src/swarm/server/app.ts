import { Hono } from 'hono';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { executeSwarmWorkflow, getOrCreateDefaultCortex, type SwarmWorkflowParams } from '../engine/index.ts';
import { globalTelemetryCollector, createTelemetryMiddleware } from '../telemetry.ts';
import { globalPayloadCache, globalSemanticCache } from '../cache.ts';
import { globalTieredCache } from '../tieredCache.ts';
import { globalActionPlanCache } from '../actionPlanCache.ts';
import { DEFAULT_PROVIDER_MODELS } from '../agent.ts';
import { initBenchmarker } from '../benchmark.ts';
import { globalFeedbackEngine, analystLedger } from '../feedback.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import type { SwarmServerOptions, SwarmServerApp } from './types.ts';
import { restoreLearningState } from './learningState.ts';
import { handleSwarmSse } from './streaming.ts';
import { fetchProviderModels } from './modelsProvider.ts';
import { buildCortexDiagnostics } from './cortexDiagnostics.ts';
import { createAppAuthMiddleware } from './appAuth.ts';

export const FORBIDDEN_CLIENT_SECRET_KEYS = [
    'geminiApiKey',
    'openRouterApiKey',
    'groqApiKey',
    'mistralApiKey',
    'githubToken',
    'qdrantUrl',
    'qdrantApiKey',
    'apiKey'
] as const;

export function sanitizeClientSettings(
    rawSettings: any,
    edgeSettings: Record<string, any> = {},
    defaultSettings: Record<string, any> = {}
): Record<string, any> {
    const forbidden = new Set<string>(FORBIDDEN_CLIENT_SECRET_KEYS);
    const cleanSettings: Record<string, any> = {};

    if (rawSettings && typeof rawSettings === 'object') {
        for (const [key, value] of Object.entries(rawSettings)) {
            if (!forbidden.has(key) && value !== "" && value !== null && value !== undefined) {
                cleanSettings[key] = value;
            }
        }
    }

    const sanitizeAgent = (agent: any) => {
        if (!agent || typeof agent !== 'object') return agent;
        const cleanAgent: Record<string, any> = {};
        for (const [k, v] of Object.entries(agent)) {
            if (!forbidden.has(k)) {
                cleanAgent[k] = v;
            }
        }
        return cleanAgent;
    };

    if (Array.isArray(cleanSettings.agents)) {
        cleanSettings.agents = cleanSettings.agents.map(sanitizeAgent);
    }
    if (cleanSettings.critic && typeof cleanSettings.critic === 'object') {
        cleanSettings.critic = sanitizeAgent(cleanSettings.critic);
    }

    const merged = {
        ...defaultSettings,
        ...cleanSettings,
        ...edgeSettings
    };

    for (const key of FORBIDDEN_CLIENT_SECRET_KEYS) {
        if (edgeSettings[key] !== undefined && edgeSettings[key] !== '') {
            merged[key] = edgeSettings[key];
        } else {
            delete merged[key];
        }
    }

    return merged;
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

    // Restore durable learning state in the background: never blocks boot or requests.
    restoreLearningState().catch((err) =>
        console.warn('[SwarmServer] Background learning-state restore failed:', err?.message || err)
    );

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
        c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://the-perfect-swarm.onrender.com https://duelodds.pages.dev; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        c.header('X-Frame-Options', 'DENY');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        await next();
    });

    const DEFAULT_ALLOWED_ORIGINS = [
        'https://the-perfect-swarm.onrender.com',
        'https://duelodds.pages.dev',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
    ];

    const getAllowedOrigins = (allowedOriginsStr?: string): Set<string> => {
        const origins = new Set<string>(DEFAULT_ALLOWED_ORIGINS);
        if (allowedOriginsStr) {
            for (const item of allowedOriginsStr.split(',')) {
                const trimmed = item.trim();
                if (trimmed && trimmed !== '*') {
                    origins.add(trimmed);
                }
            }
        }
        return origins;
    };

    if (options.cors !== false) {
        app.use('*', async (c, next) => {
            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, (c.env as Record<string, any>) || {}) as Record<string, any>;
            const allowedOrigins = getAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
            const reqOrigin = c.req.header('origin');
            const isOriginAllowed = reqOrigin ? allowedOrigins.has(reqOrigin) : false;

            if (c.req.method === 'OPTIONS') {
                if (reqOrigin && !isOriginAllowed) {
                    return c.text('Forbidden: Origin not allowed', 403);
                }
                if (isOriginAllowed) {
                    c.header('Access-Control-Allow-Origin', reqOrigin!);
                    c.header('Vary', 'Origin');
                }
                c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                return c.body(null, 204);
            }

            if (isOriginAllowed) {
                c.header('Access-Control-Allow-Origin', reqOrigin!);
                c.header('Vary', 'Origin');
                c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            }

            await next();
        });
    }

    // Caller token identifies the app. It does not restrict sibling memory reads.
    // /api/health stays open for the keep-awake ping.
    app.use('*', createAppAuthMiddleware());

    // Apply telemetry middleware to track request latency across all endpoints
    app.use('*', createTelemetryMiddleware());

    app.get('/api/health', (c) => {
        return c.json({ status: 'ok', edge: true });
    });

    app.post('/api/swarm/feedback', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { workflowId, outcome, gradedAt } = body;

            if (!workflowId || !['win', 'loss', 'push'].includes(outcome)) {
                return c.json({ error: 'Invalid workflowId or outcome' }, 400);
            }

            const callerAppId = (c as any).get('callerAppId') as string | undefined;
            const allWorkflowRecords = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes().filter((o: any) => o.workflowId === workflowId);
            const serverDefaultAppId = defaultSettings.appId || 'perfect-swarm';
            const originApp = callerAppId || (allWorkflowRecords[0] as any)?.appId || body.appId || serverDefaultAppId;

            // 1. Grade the point in MemoryCortex
            let gradeResult = { found: false, alreadyProcessed: false };
            if (defaultCortex) {
                gradeResult = await defaultCortex.gradeMemoryByWorkflowId({
                    workflowId,
                    originApp,
                    outcome,
                    gradedAt
                });
            }

            // 2. Query in-memory knowledge repository (scoped to originApp)
            const workflowRecords = allWorkflowRecords.filter((o: any) => (o.appId || o.originApp || 'perfect-swarm') === originApp);

            if (!gradeResult.found && workflowRecords.length === 0) {
                return c.json({ error: 'Workflow not found' }, 404);
            }

            // 3. Handle idempotency
            if (gradeResult.alreadyProcessed || workflowRecords.some((o: any) => o.feedbackProcessed)) {
                return c.json({ ok: true, message: 'Feedback already processed', workflowId, alreadyProcessed: true });
            }

            const accuracyScore = outcome === 'win' ? 1.0 : outcome === 'loss' ? 0.0 : 0.5;

            // 4. Update in-memory feedback engine & profiler if workflow record exists
            let compositeReward: number | undefined = undefined;
            let components: any = undefined;

            if (workflowRecords.length > 0) {
                const workflowRecord = workflowRecords[0];
                const fbResult = await globalFeedbackEngine.processFeedback({
                    workflowId,
                    task: workflowRecord.task,
                    appId: originApp,
                    durationMs: workflowRecord.metrics?.durationMs || 0,
                    targetTier: workflowRecord.metrics?.targetTier || 'instant',
                    tokenSavings: workflowRecord.metrics?.tokenSavings || 0,
                    tokensConsumed: workflowRecord.metrics?.tokensConsumed || 100,
                    qualityScore: workflowRecord.metrics?.qualityScore || 0.85,
                    accuracyScore,
                    errorCount: workflowRecord.metrics?.errorCount || 0,
                    hardErrorCount: workflowRecord.metrics?.hardErrorCount || 0,
                    failoverCount: workflowRecord.metrics?.failoverCount || 0,
                    agentRoles: (workflowRecord as any).agentRoles
                });

                compositeReward = fbResult.reward?.compositeReward;
                components = fbResult.reward?.components;

                const roles = ((workflowRecord as any).agentRoles || []).filter(Boolean);
                for (const role of roles) {
                    analystLedger.recordOutcome(originApp, role, outcome);
                    globalSpecialistProfiler.recordAccuracy(role, outcome);
                }

                for (const r of workflowRecords) {
                    (r as any).feedbackProcessed = true;
                    (r as any).gradedAt = gradedAt || Date.now();
                    globalFeedbackEngine.getKnowledgeRepository().persistOutcome(r as any);
                }
            }

            return c.json({
                ok: true,
                workflowId,
                outcome,
                accuracyScore,
                compositeReward: compositeReward ?? accuracyScore,
                components: components ?? { accuracyReward: accuracyScore }
            });
        } catch (err: any) {
            console.error('[SwarmServer Feedback Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.post('/api/swarm/calibrate', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { appId, observations, iterations = 400, autoApply = true, minSamples = 2 } = body;

            let result;
            if (Array.isArray(observations) && observations.length > 0) {
                result = globalFeedbackEngine.calibrateRewardWeights(observations, { iterations, autoApply });
            } else {
                result = globalFeedbackEngine.calibrateFromKnowledgeRepository({ appId, minSamples, iterations, autoApply });
                if (!result) {
                    return c.json({
                        ok: false,
                        error: `Insufficient graded samples in knowledge repository (minimum required: ${minSamples})`,
                        currentWeights: globalFeedbackEngine.getRewardWeights()
                    }, 400);
                }
            }

            return c.json({
                ok: true,
                ...result,
                currentWeights: globalFeedbackEngine.getRewardWeights()
            });
        } catch (err: any) {
            console.error('[SwarmServer Calibrate Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.get('/api/swarm/calibrate', (c) => {
        const appId = c.req.query('appId');
        const allOutcomes = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes({ appId, limit: 1000 });
        const gradedCount = allOutcomes.filter((o: any) => o.feedbackProcessed).length;
        return c.json({
            currentWeights: globalFeedbackEngine.getRewardWeights(),
            totalGradedOutcomes: gradedCount
        });
    });

    app.get('/api/swarm/metrics', (c) => {
        const payloadStats = globalPayloadCache.getStats();
        const semanticStats = globalSemanticCache.getStats();
        const tieredMetrics = globalTieredCache.getMetrics();
        const actionPlanStats = globalActionPlanCache.getStats();

        const totalHits = payloadStats.hits + semanticStats.hits + tieredMetrics.l1Hits + tieredMetrics.l2Hits + tieredMetrics.l3Hits + actionPlanStats.hits;
        const totalMisses = payloadStats.misses + semanticStats.misses + tieredMetrics.misses + actionPlanStats.misses;
        globalTelemetryCollector.syncCacheMetrics(totalHits, totalMisses);

        const snapshot = globalTelemetryCollector.getSnapshot();
        return c.json({
            ...snapshot,
            analystAccuracy: analystLedger.getMetrics(),
            specialistProfiles: globalSpecialistProfiler.getAllProfiles()
        });
    });

    app.get('/api/swarm/config', (c) => {
        return c.json({ defaultModels: DEFAULT_PROVIDER_MODELS });
    });

    app.get('/api/swarm/cortex/diagnostics', async (c) => {
        try {
            const appId = c.req.query('appId');
            const cortex = defaultCortex;
            if (!cortex) {
                return c.json({ error: 'Cortex not initialized' }, 503);
            }
            const diagnostics = await buildCortexDiagnostics(cortex, appId);
            return c.json(diagnostics);
        } catch (err: any) {
            console.error('[SwarmServer Cortex Diagnostics Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.all('/api/swarm/stream', async (c) => {
        let params: SwarmWorkflowParams;
        try {
            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {}) as Record<string, any>;
            const edgeSettings = {
                geminiApiKey: env.GEMINI_API_KEY,
                groqApiKey: env.GROQ_API_KEY,
                openRouterApiKey: env.OPENROUTER_API_KEY,
                mistralApiKey: env.MISTRAL_API_KEY,
                githubToken: env.GITHUB_TOKEN,
                qdrantUrl: env.QDRANT_URL,
                qdrantApiKey: env.QDRANT_API_KEY
            };

            const callerAppId = (c as any).get('callerAppId') as string | undefined;
            const serverDefaultAppId = defaultSettings.appId || 'perfect-swarm';
            const originApp = callerAppId || serverDefaultAppId;

            if (c.req.method === 'POST') {
                const body = await c.req.json().catch(() => ({}));
                const sanitizedSettings = sanitizeClientSettings(body.settings, edgeSettings, defaultSettings);
                if (Array.isArray(body.agents)) {
                    const forbidden = new Set<string>(FORBIDDEN_CLIENT_SECRET_KEYS);
                    sanitizedSettings.agents = body.agents.map((agent: any) => {
                        if (!agent || typeof agent !== 'object') return agent;
                        const cleanAgent: Record<string, any> = {};
                        for (const [k, v] of Object.entries(agent)) {
                            if (!forbidden.has(k)) cleanAgent[k] = v;
                        }
                        return cleanAgent;
                    });
                }

                params = {
                    task: body.task,
                    data: body.data,
                    originApp,
                    callerAppId,
                    domain: body.domain || body.settings?.domain,
                    settings: sanitizedSettings,
                    defaultAi: body.defaultAi || defaultAi,
                    cortex: body.cortex || body.memoryCortex || defaultCortex,
                    memoryCortex: body.memoryCortex || body.cortex || defaultCortex,
                    tools: body.tools,
                    enableDeepAnalysis: body.enableDeepAnalysis,
                    forceFullSwarm: body.forceFullSwarm,
                    speculativeParallel: body.speculativeParallel,
                    maxSpeculativeConcurrency: body.maxSpeculativeConcurrency,
                    complexityOverride: body.complexityOverride,
                    bypassCache: body.bypassCache
                };
            } else if (c.req.method === 'GET') {
                const url = new URL(c.req.url);
                const task = url.searchParams.get('task') || '';
                const data = url.searchParams.get('data') || '';
                const appId = url.searchParams.get('appId') || defaultSettings.appId || 'default';
                const domain = url.searchParams.get('domain') || undefined;
                params = {
                    task,
                    data,
                    originApp,
                    callerAppId,
                    domain,
                    settings: sanitizeClientSettings({ appId, domain }, edgeSettings, defaultSettings),
                    defaultAi,
                    cortex: defaultCortex
                };
            } else {
                return c.json({ error: 'Method Not Allowed' }, 405);
            }

            if (!params.task) {
                return c.json({ error: 'Missing required parameter: task' }, 400);
            }

            return handleSwarmSse(c, params);
        } catch (err: any) {
            console.error('[SwarmServer Stream Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.post('/api/swarm/analyze', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            if (!body.task) {
                return c.json({ error: 'Missing required parameter: task' }, 400);
            }

            const callerAppId = (c as any).get('callerAppId') as string | undefined;
            const serverDefaultAppId = defaultSettings.appId || 'perfect-swarm';
            const originApp = callerAppId || serverDefaultAppId;

            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {}) as Record<string, any>;
            const edgeSettings = {
                geminiApiKey: env.GEMINI_API_KEY,
                groqApiKey: env.GROQ_API_KEY,
                openRouterApiKey: env.OPENROUTER_API_KEY,
                mistralApiKey: env.MISTRAL_API_KEY,
                githubToken: env.GITHUB_TOKEN,
                qdrantUrl: env.QDRANT_URL,
                qdrantApiKey: env.QDRANT_API_KEY
            };

            const sanitizedSettings = sanitizeClientSettings(body.settings, edgeSettings, defaultSettings);
            if (Array.isArray(body.agents)) {
                const forbidden = new Set<string>(FORBIDDEN_CLIENT_SECRET_KEYS);
                sanitizedSettings.agents = body.agents.map((agent: any) => {
                    if (!agent || typeof agent !== 'object') return agent;
                    const cleanAgent: Record<string, any> = {};
                    for (const [k, v] of Object.entries(agent)) {
                        if (!forbidden.has(k)) cleanAgent[k] = v;
                    }
                    return cleanAgent;
                });
            }

            let result: any;
            try {
                result = await executeSwarmWorkflow({
                    task: body.task,
                    data: body.data,
                    originApp,
                    callerAppId,
                    domain: body.domain || body.settings?.domain,
                    settings: sanitizedSettings,
                    defaultAi: body.defaultAi || defaultAi,
                    cortex: body.cortex || body.memoryCortex || defaultCortex,
                    memoryCortex: body.memoryCortex || body.cortex || defaultCortex,
                    tools: body.tools,
                    enableDeepAnalysis: body.enableDeepAnalysis,
                    forceFullSwarm: body.forceFullSwarm,
                    speculativeParallel: body.speculativeParallel,
                    maxSpeculativeConcurrency: body.maxSpeculativeConcurrency,
                    complexityOverride: body.complexityOverride,
                    bypassCache: body.bypassCache
                });
            } catch (workflowErr: any) {
                console.error('[SwarmServer Analyze Workflow Error]:', workflowErr);
                return c.json({ error: workflowErr.message || 'Swarm workflow execution failed' }, 500);
            }

            try {
                const seen = new WeakSet();
                const safeReplacer = (_key: string, value: any) => {
                    if (typeof value === 'bigint') return value.toString();
                    if (typeof value === 'object' && value !== null) {
                        if (seen.has(value)) {
                            return '[Circular]';
                        }
                        seen.add(value);
                    }
                    return value;
                };

                const serialized = JSON.stringify(result, safeReplacer);
                return c.newResponse(serialized, 200, {
                    'Content-Type': 'application/json; charset=utf-8'
                });
            } catch (serializationErr: any) {
                console.error('[SwarmServer Analyze Serialization Error]:', serializationErr);
                const safeFallback = {
                    finalAnalysis: result?.finalAnalysis || 'Analysis completed successfully (fallback serialization)',
                    events: Array.isArray(result?.events) ? result.events.slice(-10) : [],
                    metrics: result?.metrics || null,
                    serializationWarning: serializationErr.message || String(serializationErr)
                };
                return c.json(safeFallback, 200);
            }
        } catch (err: any) {
            console.error('[SwarmServer Analyze Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.get('/api/swarm/models', async (c) => {
        try {
            const provider = c.req.query('provider');
            if (!provider) {
                return c.json({ error: 'Missing required query parameter: provider' }, 400);
            }

            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {}) as Record<string, any>;
            // Model listing uses server secrets only; ignore x-provider-key
            const models = await fetchProviderModels(provider, undefined, env);
            return c.json(models);
        } catch (err: any) {
            console.error(`[SwarmServer Models Error]:`, err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.all('/api/*', (c) => {
        return c.json({ error: 'Not found' }, 404);
    });

    return app;
}
