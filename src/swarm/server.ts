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
import { globalBenchmarker, initBenchmarker } from './benchmark.ts';
import { globalFeedbackEngine, analystLedger } from './feedback.ts';
import { globalLoadBalancer, globalSpecialistProfiler } from './loadBalancer.ts';
import { QdrantLearningStore } from './learning-persistence.ts';

/**
 * Restores the swarm's durable learning state (outcome records, analyst ledger,
 * specialist accuracy profiles, policy genealogy) from Qdrant into the in-memory
 * singletons. Safe to call on every boot: restores are idempotent merges.
 *
 * If Qdrant is unconfigured or unreachable, this logs a warning and the system
 * keeps its in-memory-only behavior. Never rejects.
 */
export async function restoreLearningState(store?: QdrantLearningStore): Promise<{
    restored: boolean;
    outcomes: number;
    ledgerEntries: number;
    profiles: number;
}> {
    const empty = { restored: false, outcomes: 0, ledgerEntries: 0, profiles: 0 };
    try {
        const s = store || new QdrantLearningStore();
        const ready = await s.whenReady();
        if (!ready) {
            console.warn('[SwarmServer] Learning persistence disabled (no Qdrant) — learning state is in-memory only and will not survive redeploys.');
            return empty;
        }
        const repo = globalFeedbackEngine.getKnowledgeRepository();
        repo.setLearningStore(s);
        analystLedger.setLearningStore(s);
        globalSpecialistProfiler.setLearningStore(s);

        const [outcomes, ledgerEntries, profiles] = await Promise.all([
            repo.restoreFromLearningStore(),
            analystLedger.restoreFromLearningStore(),
            globalSpecialistProfiler.restoreFromLearningStore()
        ]);
        console.log(`[SwarmServer] Learning state restored from durable store: ${outcomes} outcome records, ${ledgerEntries} ledger entries, ${profiles} specialist profiles.`);
        return { restored: true, outcomes, ledgerEntries, profiles };
    } catch (err: any) {
        console.warn('[SwarmServer] Learning-state restore failed (continuing in-memory):', err?.message || err);
        return empty;
    }
}

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

            await sendEvent('swarm_complete', {
                ...result,
                workflowId: result.workflowId
            });
        } catch (err: any) {
            await sendEvent('swarm_error', { error: err.message || String(err) });
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

    if (options.cors !== false) {
        app.use('*', async (c, next) => {
            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, (c.env as Record<string, any>) || {}) as Record<string, any>;
            const allowedOriginsStr = env.CORS_ALLOWED_ORIGINS;
            const reqOrigin = c.req.header('origin');

            if (allowedOriginsStr) {
                const allowedOrigins = allowedOriginsStr.split(',').map((o: string) => o.trim());
                if (allowedOrigins.includes('*')) {
                    c.header('Access-Control-Allow-Origin', '*');
                } else if (reqOrigin) {
                    if (allowedOrigins.includes(reqOrigin)) {
                        c.header('Access-Control-Allow-Origin', reqOrigin);
                    } else {
                        return c.text('Forbidden: Origin not allowed', 403);
                    }
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

    app.post('/api/swarm/feedback', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { workflowId, outcome, stake, profit, gradedAt, appId = 'perfect-swarm' } = body;

            if (!workflowId || !['win', 'loss', 'push'].includes(outcome)) {
                return c.json({ error: 'Invalid workflowId or outcome' }, 400);
            }

            const workflowRecords = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes().filter((o: any) => o.workflowId === workflowId);
            if (workflowRecords.length === 0) {
                return c.json({ error: 'Workflow not found' }, 404);
            }

            if (workflowRecords.some((o: any) => o.feedbackProcessed)) {
                // Idempotency support
                return c.json({ ok: true, message: 'Feedback already processed', workflowId });
            }

            const workflowRecord = workflowRecords[0];
            const accuracyScore = outcome === 'win' ? 1.0 : outcome === 'loss' ? 0.0 : 0.5;

            const fbResult = await globalFeedbackEngine.processFeedback({
                workflowId,
                task: workflowRecord.task,
                appId: workflowRecord.appId,
                durationMs: workflowRecord.metrics.durationMs,
                targetTier: workflowRecord.metrics.targetTier,
                tokenSavings: workflowRecord.metrics.tokenSavings,
                tokensConsumed: workflowRecord.metrics.tokensConsumed,
                qualityScore: workflowRecord.metrics.qualityScore,
                accuracyScore,
                errorCount: workflowRecord.metrics.errorCount,
                hardErrorCount: workflowRecord.metrics.hardErrorCount,
                failoverCount: workflowRecord.metrics.failoverCount,
                agentRoles: (workflowRecord as any).agentRoles
            });

            // Update per-analyst ledger and specialist profiler with REAL analyst roles from the workflow record
            const targetAppId = workflowRecord.appId || appId || 'perfect-swarm';
            const roles = ((workflowRecord as any).agentRoles || []).filter(Boolean);
            for (const role of roles) {
                analystLedger.recordOutcome(targetAppId, role, outcome);
                globalSpecialistProfiler.recordAccuracy(role, outcome);
            }

            for (const r of workflowRecords) {
                (r as any).feedbackProcessed = true;
                (r as any).gradedAt = gradedAt || Date.now();
                // Re-persist the mutated record so grading survives redeploys (idempotent upsert).
                globalFeedbackEngine.getKnowledgeRepository().persistOutcome(r as any);
            }

            return c.json({
                ok: true,
                workflowId,
                outcome,
                accuracyScore,
                compositeReward: fbResult.reward.compositeReward,
                components: fbResult.reward.components
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
        // Sync cache metrics from cache layers
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
            const diagnostics = await cortex.getDiagnostics(appId);
            
            // Generate structured role recommendations based on app's actual roles and benchmarks
            const bestModels = globalBenchmarker.getBestModels();
            const telemetry = globalTelemetryCollector.getSnapshot();

            diagnostics.latencyStats = telemetry.overallLatency;
            diagnostics.cacheHitRatio = telemetry.cacheHitRatio;

            diagnostics.roleRecommendations = [];

            if (bestModels && Object.keys(diagnostics.storageByRole).length > 0) {
                for (const [role, count] of Object.entries(diagnostics.storageByRole)) {
                    const roleLower = role.toLowerCase();

                    if (roleLower.includes('router') || roleLower.includes('classif')) {
                        if (bestModels.bestRouter) {
                            diagnostics.roleRecommendations.push({
                                role,
                                recommendedProvider: bestModels.bestRouter.provider,
                                recommendedModel: bestModels.bestRouter.modelName,
                                reason: `Fastest routing performance (${bestModels.bestRouter.routingLatency}ms). Ideal for high-volume classifier roles.`
                            });
                        }
                    } else if (roleLower.includes('manager') || roleLower.includes('critic') || roleLower.includes('synthesiz') || roleLower.includes('review')) {
                        if (bestModels.bestReasoning) {
                            diagnostics.roleRecommendations.push({
                                role,
                                recommendedProvider: bestModels.bestReasoning.provider,
                                recommendedModel: bestModels.bestReasoning.modelName,
                                reason: `High reasoning capability (passed logic tests). Critical for synthesis and verification roles.`
                            });
                        }
                    } else {
                        // General Analyst/Worker role
                        if (bestModels.bestRouter) {
                            diagnostics.roleRecommendations.push({
                                role,
                                recommendedProvider: bestModels.bestRouter.provider,
                                recommendedModel: bestModels.bestRouter.modelName,
                                reason: `Excellent balance of speed and efficiency. Suitable for general extraction and analysis tasks.`
                            });
                        }
                    }
                }
            }

            // Fallback backward-compatible model suggestions HTML
            if (bestModels) {
                let suggestionsHtml = '<ul class="space-y-1.5 list-disc list-inside">\n';
                if (bestModels.bestRouter) {
                    suggestionsHtml += `<li><strong>Speed & Cost:</strong> ${bestModels.bestRouter.provider} (${bestModels.bestRouter.modelName}) is currently fastest at ${bestModels.bestRouter.routingLatency}ms.</li>\n`;
                }
                if (bestModels.bestReasoning) {
                    suggestionsHtml += `<li><strong>Deep Reasoning:</strong> ${bestModels.bestReasoning.provider} (${bestModels.bestReasoning.modelName}) passed logic tests in ${bestModels.bestReasoning.reasoningLatency}ms.</li>\n`;
                }
                suggestionsHtml += `<li><strong>Current Cache Hit Ratio:</strong> ${diagnostics.cacheHitRatio !== undefined ? `${(diagnostics.cacheHitRatio * 100).toFixed(1)}%` : 'N/A'}. A higher ratio speeds up analysis and lowers cost.</li>\n`;
                suggestionsHtml += `<li><strong>Throughput:</strong> p95 latency is ${diagnostics.latencyStats?.p95 !== undefined ? `${diagnostics.latencyStats.p95}ms` : 'N/A'}, p99 is ${diagnostics.latencyStats?.p99 !== undefined ? `${diagnostics.latencyStats.p99}ms` : 'N/A'}.</li>\n`;
                suggestionsHtml += '</ul>';
                diagnostics.modelSuggestions = suggestionsHtml;
            }

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

            let result: any;
            try {
                result = await executeSwarmWorkflow({
                    task: body.task,
                    data: body.data,
                    settings: { ...edgeSettings, ...defaultSettings, ...cleanBodySettings },
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

            // Safe post-execution serialization to prevent socket drops on success
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
                        free: true
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
