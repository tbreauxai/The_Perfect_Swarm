import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { executeSwarmWorkflow, type SwarmWorkflowParams, type SwarmWorkflowResult } from './engine/index.ts';
import type { SwarmEvent } from './types.ts';
import type { GoogleGenAI } from '@google/genai';
import type { MemoryCortex } from './memory.ts';
import { globalMetricsCollector } from './profiler.ts';
import { globalTelemetryCollector, createTelemetryMiddleware } from './telemetry.ts';
import { globalPayloadCache, globalSemanticCache } from './cache.ts';
import { globalTieredCache } from './tieredCache.ts';
import { globalActionPlanCache } from './actionPlanCache.ts';
import { DEFAULT_PROVIDER_MODELS } from './agent.ts';

export interface SwarmServerOptions {
    port?: number;
    host?: string;
    defaultSettings?: any;
    defaultAi?: GoogleGenAI;
    defaultCortex?: MemoryCortex;
    cors?: boolean;
}

/**
 * Handles Server-Sent Events (SSE) streaming for swarm execution using Hono.
 * Edge-compatible (Cloudflare Workers, Deno, Bun, Node.js).
 */
export async function handleSwarmSse(
    c: Context,
    params: SwarmWorkflowParams
) {
    return streamSSE(c, async (stream) => {
        const sendEvent = async (eventType: string, data: any) => {
            try {
                await stream.writeSSE({
                    event: eventType,
                    data: JSON.stringify(data),
                });
            } catch (err) {
                console.error(`[SSE Write Error]:`, err);
            }
        };

        try {
            const result = await executeSwarmWorkflow({
                ...params,
                onEvent: async (event: SwarmEvent) => {
                    await sendEvent('swarm_event', event);
                    if (params.onEvent) {
                        params.onEvent(event);
                    }
                },
                onStage: async (stagePayload) => {
                    await sendEvent('swarm_stage', stagePayload);
                    if (params.onStage) {
                        params.onStage(stagePayload);
                    }
                },
                onPartialResult: async (partialResult) => {
                    await sendEvent('swarm_partial', partialResult);
                    if (params.onPartialResult) {
                        params.onPartialResult(partialResult);
                    }
                }
            });

            await sendEvent('swarm_complete', result);
        } catch (err: any) {
            await sendEvent('swarm_error', { error: err.stack || err.message || String(err) });
        }
    });
}

export interface SwarmServerApp extends Hono {
    listen(port?: number | ((...args: any[]) => void), hostnameOrCb?: string | ((...args: any[]) => void), cb?: (...args: any[]) => void): ServerType;
    address(): any;
    close(cb?: (err?: Error) => void): any;
}

/**
 * Parses JSON body from an incoming request stream or Hono context.
 */
export async function parseJsonBody<T = any>(req: any): Promise<T> {
    if (req?.json && typeof req.json === 'function') {
        return req.json().catch(() => ({}));
    }
    if (req?.req?.json && typeof req.req.json === 'function') {
        return req.req.json().catch(() => ({}));
    }
    if (typeof req?.on === 'function') {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk: any) => { body += chunk; });
            req.on('end', () => {
                try { resolve(body ? JSON.parse(body) : ({} as T)); } catch (e) { reject(e); }
            });
            req.on('error', reject);
        });
    }
    return {} as T;
}

/**
 * Creates a standalone, zero-external-dependency Hono app for headless swarm deployments.
 * Supports both Edge runtimes (Cloudflare Pages/Workers) and Node.js (`server.listen()`).
 */
export function createSwarmServer(options: SwarmServerOptions = {}): SwarmServerApp {
    const app = new Hono() as SwarmServerApp;
    const defaultSettings = options.defaultSettings || {};
    const defaultAi = options.defaultAi;
    const defaultCortex = options.defaultCortex;
    let nodeServer: ServerType | null = null;

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

    if (options.cors !== false) {
        app.use('*', async (c, next) => {
            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, (c.env as Record<string, any>) || {}) as Record<string, any>;
            const allowedOriginsStr = env.CORS_ALLOWED_ORIGINS;
            const reqOrigin = c.req.header('origin');

            if (allowedOriginsStr) {
                const allowedOrigins = allowedOriginsStr.split(',').map((o: string) => o.trim());
                if (reqOrigin && allowedOrigins.includes(reqOrigin)) {
                    c.header('Access-Control-Allow-Origin', reqOrigin);
                } else if (allowedOrigins.length > 0) {
                    c.header('Access-Control-Allow-Origin', allowedOrigins[0]);
                } else {
                    c.header('Access-Control-Allow-Origin', '*');
                }
            } else {
                c.header('Access-Control-Allow-Origin', '*');
            }

            c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (c.req.method === 'OPTIONS') {
                return c.body(null, 204);
            }
            await next();
        });
    }

    // Apply telemetry middleware to track request latency across all endpoints
    app.use('*', createTelemetryMiddleware());

    app.get('/api/health', (c) => {
        return c.json({ status: 'ok', edge: true });
    });

    app.get('/api/swarm/metrics', (c) => {
        // Sync cache metrics from cache layers
        const payloadStats = globalPayloadCache.getStats();
        const semanticStats = globalSemanticCache.getStats();
        const tieredMetrics = globalTieredCache.getMetrics();
        const actionPlanStats = globalActionPlanCache.getStats();
        
        const totalHits = payloadStats.hits + semanticStats.hits + tieredMetrics.l1Hits + tieredMetrics.l2Hits + tieredMetrics.l3Hits + actionPlanStats.hits;
        const totalMisses = payloadStats.misses + semanticStats.misses + tieredMetrics.misses + actionPlanStats.misses;
        globalTelemetryCollector.syncCacheMetrics(totalHits, totalMisses);

        return c.json(globalTelemetryCollector.getSnapshot());
    });

    app.get('/api/swarm/config', (c) => {
        return c.json({ defaultModels: DEFAULT_PROVIDER_MODELS });
    });

    app.get('/api/swarm/cortex/diagnostics', async (c) => {
        try {
            const cortex = defaultCortex;
            if (!cortex) {
                return c.json({ error: 'Cortex not initialized' }, 503);
            }
            const diagnostics = await cortex.getDiagnostics();
            return c.json(diagnostics);
        } catch (err: any) {
            console.error('[SwarmServer Cortex Diagnostics Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.all('/api/swarm/stream', async (c) => {
        let params: SwarmWorkflowParams;
        try {
            // Cloudflare Pages/Workers injects env variables into `c.env`.
            // We merge them with process.env so it works correctly on Node.js (Render) too.
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

            if (c.req.method === 'POST') {
                const body = await c.req.json().catch(() => ({}));
                const cleanBodySettings = Object.fromEntries(
                    Object.entries(body.settings || {}).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
                );
                params = {
                    task: body.task,
                    data: body.data,
                    settings: { ...edgeSettings, ...defaultSettings, ...cleanBodySettings },
                    defaultAi: body.defaultAi || defaultAi,
                    cortex: body.cortex || defaultCortex,
                    enableDeepAnalysis: body.enableDeepAnalysis,
                    complexityOverride: body.complexityOverride
                };
            } else if (c.req.method === 'GET') {
                const url = new URL(c.req.url);
                const task = url.searchParams.get('task') || '';
                const data = url.searchParams.get('data') || '';
                const appId = url.searchParams.get('appId') || defaultSettings.appId || 'default';
                params = {
                    task,
                    data,
                    settings: { ...edgeSettings, ...defaultSettings, appId },
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

            const cleanBodySettings = Object.fromEntries(
                Object.entries(body.settings || {}).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
            );

            const result = await executeSwarmWorkflow({
                task: body.task,
                data: body.data,
                settings: { ...edgeSettings, ...defaultSettings, ...cleanBodySettings },
                defaultAi: body.defaultAi || defaultAi,
                cortex: body.cortex || defaultCortex,
                enableDeepAnalysis: body.enableDeepAnalysis,
                complexityOverride: body.complexityOverride
            });

            return c.json(result);
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
            const clientKey = c.req.header('x-provider-key');
            
            switch (provider.toLowerCase()) {
                case 'simulated': {
                    return c.json([
                        { id: 'simulated-swarm-v1', name: 'Simulated Swarm Model', free: true }
                    ]);
                }
                case 'openrouter': {
                    const res = await fetch('https://openrouter.ai/api/v1/models');
                    if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
                    const data = await res.json();
                    return c.json((data.data || []).map((m: any) => ({
                        id: m.id,
                        name: m.name || m.id,
                        context_length: m.context_length,
                        free: m.pricing?.prompt === "0" && m.pricing?.completion === "0"
                    })));
                }
                case 'groq': {
                    const apiKey = clientKey || env.GROQ_API_KEY;
                    if (!apiKey) return c.json([]);
                    const res = await fetch('https://api.groq.com/openai/v1/models', {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    if (!res.ok) throw new Error('Failed to fetch Groq models');
                    const data = await res.json();
                    return c.json((data.data || []).map((m: any) => ({
                        id: m.id,
                        name: m.id,
                        free: true
                    })));
                }
                case 'gemini': {
                    const apiKey = clientKey || env.GEMINI_API_KEY;
                    if (!apiKey) return c.json([]);
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                    if (!res.ok) throw new Error('Failed to fetch Gemini models');
                    const data = await res.json();
                    const models = (data.models || [])
                        .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                        .map((m: any) => ({
                            id: (m.name || '').replace('models/', ''),
                            name: m.displayName || m.name,
                            free: true
                        }));
                    return c.json(models);
                }
                case 'mistral': {
                    const apiKey = clientKey || env.MISTRAL_API_KEY;
                    if (!apiKey) return c.json([]);
                    const res = await fetch('https://api.mistral.ai/v1/models', {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    if (!res.ok) throw new Error('Failed to fetch Mistral models');
                    const data = await res.json();
                    return c.json((data.data || []).map((m: any) => ({
                        id: m.id,
                        name: m.id,
                        free: typeof m.id === 'string' && (m.id.includes('free') || m.id.includes('open'))
                    })));
                }
                case 'github': {
                    const apiKey = clientKey || env.GITHUB_TOKEN;
                    if (!apiKey) return c.json([]);
                    const res = await fetch('https://models.inference.ai.azure.com/models', {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    if (!res.ok) throw new Error('Failed to fetch GitHub models');
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (data.data || []);
                    return c.json(list.map((m: any) => ({
                        id: m.name,
                        name: m.friendly_name || m.name,
                        free: true
                    })));
                }
                default:
                    return c.json([]);
            }
        } catch (err: any) {
            console.error(`[SwarmServer Models Error]:`, err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    return app;
}
