import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { executeSwarmWorkflow, getOrCreateDefaultCortex, SwarmEngine, type SwarmWorkflowParams } from '../engine/index.ts';
import { MemoryCortex } from '../memory/index.ts';
import { globalTelemetryCollector, createTelemetryMiddleware } from '../telemetry.ts';
import { globalPayloadCache, globalSemanticCache } from '../cache.ts';
import { globalTieredCache } from '../tieredCache.ts';
import { globalActionPlanCache } from '../actionPlanCache.ts';
import { DEFAULT_PROVIDER_MODELS } from '../agent.ts';
import { initBenchmarker } from '../benchmark.ts';
import { globalFeedbackEngine, analystLedger } from '../feedback.ts';
import {
  outcomeToScore,
  recordProbabilityObservation,
  hydrateFromOutcomeRecords,
  prependCalibrationToData,
  fitCalibration,
  observationsForApp
} from '../feedback/probabilityCalibration.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import type { SwarmServerOptions, SwarmServerApp } from './types.ts';
import { restoreLearningState } from './learningState.ts';
import { handleSwarmSse } from './streaming.ts';
import { fetchProviderModels, probeAllProviders } from './modelsProvider.ts';
import { buildCortexDiagnostics } from './cortexDiagnostics.ts';
import { createAppAuthMiddleware } from './appAuth.ts';
import { createCorsMiddleware } from './cors.ts';
import {
    runMorningSlate,
    tryAcquireMorningLock,
    releaseMorningLock,
    morningClaims
} from '../morning/index.ts';
import {
    initFeedbackDedupe,
    generateDedupeKey,
    isFeedbackInFlight,
    setFeedbackInFlight,
    removeFeedbackInFlight,
    isFeedbackProcessed,
    markFeedbackProcessed
} from './feedbackDedupe.ts';

export const FORBIDDEN_CLIENT_SECRET_KEYS = [
    'geminiApiKey',
    'openRouterApiKey',
    'groqApiKey',
    'mistralApiKey',
    'cloudflareApiToken',
    'nvidiaApiKey',
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

    // Initialize persistent dedupe (if RENDER_DISK_PATH is set)
    initFeedbackDedupe();

    // Restore durable learning state in the background: never blocks boot or requests.
    restoreLearningState().catch((err) =>
        console.warn('[SwarmServer] Background learning-state restore failed:', err?.message || err)
    );

    const serverEnv = typeof process !== 'undefined' ? (process.env as Record<string, any>) : {};
    probeAllProviders(serverEnv).catch((err) =>
        console.warn('[catalog] Background catalog warming failed:', err?.message || err)
    );

    // Catalog probe runs at 6 AM and 10 PM CT, not on every picker open.
    // Seats read the cache. A probe never competes with a live analysis.
    if (typeof setInterval !== 'undefined') {
        const CT_OFFSET_MS = 5 * 60 * 60 * 1000;
        const PROBE_HOURS = new Set([6, 22]);
        let lastProbeKey = '';
        setInterval(() => {
            const ct = new Date(Date.now() - CT_OFFSET_MS);
            const hour = ct.getUTCHours();
            const key = `${ct.toISOString().slice(0, 10)}-${hour}`;
            if (!PROBE_HOURS.has(hour) || key === lastProbeKey) return;
            lastProbeKey = key;
            const env = typeof process !== 'undefined' ? process.env : {};
            probeAllProviders(env as Record<string, any>).catch((err) =>
                console.warn('[catalog] scheduled probe failed:', err?.message || err)
            );
        }, 30 * 60 * 1000);
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

    app.get('/api/health', (c) => {
        return c.json({ status: 'ok', edge: true });
    });

    app.post('/api/swarm/feedback', async (c) => {
        const callerAppId = (c as any).get('callerAppId') as string | undefined;
        let dedupKey: string | undefined = undefined;

        try {
            const body = await c.req.json().catch(() => ({}));
            const { workflowId, outcome, gradedAt, predictedProbability, sportKey, market } = body;

            if (!workflowId || !['win', 'loss', 'push'].includes(outcome)) {
                return c.json({ error: 'Invalid workflowId or outcome' }, 400);
            }

            if (!callerAppId) {
                return c.json({ error: 'Unauthorized: missing callerAppId' }, 401);
            }
            const originApp = callerAppId;
            const pickId = body.pickId || body.pick_id;

            dedupKey = generateDedupeKey(callerAppId, workflowId, pickId, outcome, body);

            if (isFeedbackInFlight(dedupKey)) {
                return c.json({ error: 'Conflict: Feedback processing in progress, retry later' }, 409);
            }

            if (await isFeedbackProcessed(dedupKey)) {
                return c.json({ ok: true, duplicate: true, message: 'Feedback already processed', workflowId, pickId }, 200);
            }

            setFeedbackInFlight(dedupKey);

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

            if (!gradeResult.found) {
                // Unknown workflowId: not present in this app's store. Previously only
                // another app's workflowId got a 404 here; anything else fell through
                // and recorded feedback against a nonexistent workflow.
                return c.json({ error: 'Workflow not found' }, 404);
            }
            // 2. Query in-memory knowledge repository (scoped to originApp, without defaulting missing appId to perfect-swarm)
            const allWorkflowRecords = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes().filter((o: any) => o.workflowId === workflowId);
            const workflowRecords = allWorkflowRecords.filter((o: any) => {
                const recordApp = o.appId || o.originApp;
                return Boolean(recordApp && recordApp === originApp);
            });

            // 3. Handle idempotency
            if (gradeResult.alreadyProcessed || workflowRecords.some((o: any) => o.feedbackProcessed)) {
                return c.json({ ok: true, duplicate: true, message: 'Feedback already processed', workflowId, alreadyProcessed: true });
            }

            const accuracyScore = outcome === 'win' ? 1.0 : outcome === 'loss' ? 0.0 : 0.5;
            const score = outcomeToScore(outcome);
            const statedProbability = Number(predictedProbability);
            if (score != null && Number.isFinite(statedProbability) && statedProbability > 0 && statedProbability < 1) {
                recordProbabilityObservation({
                    workflowId,
                    appId: originApp,
                    predictedProbability: statedProbability,
                    outcome: score,
                    sportKey: typeof sportKey === 'string' ? sportKey : undefined,
                    market: typeof market === 'string' ? market : undefined,
                    gradedAt: typeof gradedAt === 'string' ? gradedAt : new Date().toISOString()
                });
            }

            // 4. Update in-memory feedback engine & profiler if workflow record exists
            let compositeReward: number | undefined = undefined;
            let components: any = undefined;

            if (workflowRecords.length > 0) {
                const workflowRecord = workflowRecords[0];

                compositeReward = accuracyScore;
                components = { accuracyReward: accuracyScore };

                const roles = ((workflowRecord as any).agentRoles || []).filter(Boolean);
                for (const role of roles) {
                    analystLedger.recordOutcome(originApp, role, outcome);
                    globalSpecialistProfiler.recordAccuracy(role, outcome);
                }

                for (const r of workflowRecords) {
                    (r as any).feedbackProcessed = true;
                    (r as any).gradedAt = gradedAt || Date.now();
                    if (!(r as any).metrics) {
                        (r as any).metrics = {};
                    }
                    (r as any).metrics.accuracyScore = accuracyScore;
                    (r as any).outcome = outcome;
                    if (Number.isFinite(statedProbability)) (r as any).predictedProbability = statedProbability;
                    if (sportKey) (r as any).sportKey = sportKey;
                    if (market) (r as any).market = market;
                    globalFeedbackEngine.getKnowledgeRepository().persistOutcome(r as any);
                }
            }

            markFeedbackProcessed(dedupKey);

            return c.json({
                ok: true,
                workflowId,
                outcome,
                accuracyScore,
                compositeReward: compositeReward ?? accuracyScore,
                components: components ?? { accuracyReward: accuracyScore },
                calibration: fitCalibration(observationsForApp(originApp))
            });
        } catch (err: any) {
            console.error('[SwarmServer Feedback Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        } finally {
            if (dedupKey) {
                removeFeedbackInFlight(dedupKey);
            }
        }
    });

    app.post('/api/swarm/morning', async (c) => {
        // R3-S1: single-flight. A second call while a run is in flight returns 202 and does no work.
        if (!tryAcquireMorningLock()) {
            return c.json({ status: 'already_running' }, 202);
        }
        try {
            const body = await c.req.json().catch(() => ({}));
            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {}) as Record<string, any>;
            const result = await runMorningSlate({
                dateInput: body?.date,
                env,
                claims: morningClaims
            });
            return c.json(result, 200);
        } catch (err: any) {
            console.error('[SwarmServer Morning Slate Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        } finally {
            releaseMorningLock();
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

    const swarmBodyLimit = bodyLimit({
        maxSize: 2 * 1024 * 1024,
        onError: (c) => c.json({ error: 'Payload Too Large' }, 413)
    });

    app.all('/api/swarm/stream', swarmBodyLimit, async (c) => {
        let params: SwarmWorkflowParams;
        try {
            const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {}) as Record<string, any>;
            const edgeSettings = {
                geminiApiKey: env.GEMINI_API_KEY,
                groqApiKey: env.GROQ_API_KEY,
                openRouterApiKey: env.OPENROUTER_API_KEY,
                mistralApiKey: env.MISTRAL_API_KEY,
                cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN,
                cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID,
                nvidiaApiKey: env.NVIDIA_API_KEY,
                githubToken: env.GITHUB_TOKEN,
                qdrantUrl: env.QDRANT_URL,
                qdrantApiKey: env.QDRANT_API_KEY
            };

            const callerAppId = (c as any).get('callerAppId') as string | undefined;
            const serverDefaultAppId = defaultSettings.appId || 'perfect-swarm';
            const originApp = callerAppId || serverDefaultAppId;

            if (c.req.method === 'POST') {
                const body = await c.req.json().catch(() => ({}));
                if (!body.task || body.data === undefined) {
                    return c.json({ error: 'Missing required parameter: task and data' }, 400);
                }
                if (body.metadata) {
                    console.log('[SwarmServer Stream Metadata]:', body.metadata);
                }
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
                hydrateFromOutcomeRecords(originApp, globalFeedbackEngine.getKnowledgeRepository().queryOutcomes({ appId: originApp, limit: 500 }) as any);

                params = {
                    task: body.task,
                    data: prependCalibrationToData(body.data, originApp),
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
                    bypassCache: body.bypassCache,
                    scorecardMode: body.scorecardMode === true
                };
            } else if (c.req.method === 'GET') {
                const url = new URL(c.req.url);
                const task = url.searchParams.get('task') || '';
                const data = url.searchParams.get('data');
                if (!task || data === null) {
                    return c.json({ error: 'Missing required parameter: task and data' }, 400);
                }
                const appId = url.searchParams.get('appId') || defaultSettings.appId || 'default';
                const domain = url.searchParams.get('domain') || undefined;
                hydrateFromOutcomeRecords(originApp, globalFeedbackEngine.getKnowledgeRepository().queryOutcomes({ appId: originApp, limit: 500 }) as any);
                params = {
                    task,
                    data: prependCalibrationToData(data, originApp),
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

            return handleSwarmSse(c, params);
        } catch (err: any) {
            console.error('[SwarmServer Stream Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.post('/api/swarm/analyze', swarmBodyLimit, async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            if (!body.task || body.data === undefined) {
                return c.json({ error: 'Missing required parameter: task and data' }, 400);
            }
            if (body.metadata) {
                console.log('[SwarmServer Analyze Metadata]:', body.metadata);
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
                cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN,
                cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID,
                nvidiaApiKey: env.NVIDIA_API_KEY,
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

            hydrateFromOutcomeRecords(originApp, globalFeedbackEngine.getKnowledgeRepository().queryOutcomes({ appId: originApp, limit: 500 }) as any);

            let result: any;
            try {
                result = await executeSwarmWorkflow({
                    task: body.task,
                    data: prependCalibrationToData(body.data, originApp),
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
                    bypassCache: body.bypassCache,
                    scorecardMode: body.scorecardMode === true
                });
            } catch (workflowErr: any) {
                console.error('[SwarmServer Analyze Workflow Error]:', workflowErr);
                return c.json({ error: workflowErr.message || 'Swarm workflow execution failed' }, 500);
            }

            try {
                if (result.workflowId) {
                    result.workflowId = String(result.workflowId);
                } else {
                    delete result.workflowId;
                }
                // PS1: partial runs return 200 with status:'partial' (and keep workflowId); degraded = seat ids with no backup left.
                result.status = result.status || 'complete';
                result.degraded = Array.isArray(result.degraded) ? result.degraded : [];

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

    app.post('/api/swarm/backtest', swarmBodyLimit, async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const slate = Array.isArray(body)
                ? body
                : (Array.isArray(body.slate)
                    ? body.slate
                    : (Array.isArray(body.games) ? body.games : null));

            if (!slate || slate.length === 0) {
                return c.json({ error: 'Missing or empty slate array in request body' }, 400);
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
                cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN,
                cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID,
                nvidiaApiKey: env.NVIDIA_API_KEY,
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

            // Create sandboxed in-memory cortex with isolatedStore to prevent polluting live memory or Qdrant
            const sandboxedCortex = new MemoryCortex({
                defaultAppId: originApp,
                isolatedStore: true
            });

            const engine = new SwarmEngine(
                sanitizedSettings,
                body.defaultAi || defaultAi,
                sandboxedCortex
            );

            const results: any[] = [];

            for (const item of slate) {
                const gameId = item.gameId || item.id || `game-${results.length + 1}`;
                const task = item.task || body.task || `Historical backtest analysis for ${gameId}`;
                const data = item.data !== undefined ? (typeof item.data === 'string' ? item.data : JSON.stringify(item.data)) : '';

                const gameSettings = item.settings ? sanitizeClientSettings(item.settings, edgeSettings, sanitizedSettings) : sanitizedSettings;
                if (Array.isArray(item.agents)) {
                    const forbidden = new Set<string>(FORBIDDEN_CLIENT_SECRET_KEYS);
                    gameSettings.agents = item.agents.map((agent: any) => {
                        if (!agent || typeof agent !== 'object') return agent;
                        const cleanAgent: Record<string, any> = {};
                        for (const [k, v] of Object.entries(agent)) {
                            if (!forbidden.has(k)) cleanAgent[k] = v;
                        }
                        return cleanAgent;
                    });
                }

                try {
                    const runResult = await engine.execute({
                        task,
                        data,
                        originApp,
                        callerAppId,
                        domain: item.domain || body.domain || gameSettings.domain,
                        settings: gameSettings,
                        cortex: sandboxedCortex,
                        memoryCortex: sandboxedCortex,
                        tools: item.tools || body.tools,
                        enableDeepAnalysis: item.enableDeepAnalysis ?? body.enableDeepAnalysis,
                        forceFullSwarm: item.forceFullSwarm ?? body.forceFullSwarm,
                        speculativeParallel: item.speculativeParallel ?? body.speculativeParallel,
                        maxSpeculativeConcurrency: item.maxSpeculativeConcurrency ?? body.maxSpeculativeConcurrency,
                        complexityOverride: item.complexityOverride ?? body.complexityOverride,
                        bypassCache: item.bypassCache ?? body.bypassCache ?? true,
                        scorecardMode: (item.scorecardMode ?? body.scorecardMode) === true
                    });

                    const closingLine = item.closingLine ?? item.closing_line;
                    const actualOutcome = item.actualOutcome ?? item.outcome;
                    let grading: any = undefined;

                    if (actualOutcome || closingLine !== undefined) {
                        grading = {
                            closingLine,
                            actualOutcome,
                            simulatedAt: new Date().toISOString()
                        };
                    }

                    results.push({
                        gameId,
                        status: runResult.status || 'complete',
                        workflowId: runResult.workflowId ? String(runResult.workflowId) : undefined,
                        finalAnalysis: runResult.finalAnalysis,
                        grading,
                        metrics: runResult.metrics,
                        degraded: runResult.degraded || []
                    });
                } catch (itemErr: any) {
                    results.push({
                        gameId,
                        status: 'error',
                        error: itemErr.message || String(itemErr)
                    });
                }
            }

            return c.json({
                ok: true,
                simulatedCount: results.length,
                results
            }, 200);
        } catch (err: any) {
            console.error('[SwarmServer Backtest Error]:', err);
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
            const models = await fetchProviderModels(provider, undefined, env, { boundedWaitMs: 8000 });
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
