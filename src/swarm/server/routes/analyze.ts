import type { Hono } from 'hono';
import { executeSwarmWorkflow, SwarmEngine, type SwarmWorkflowParams } from '../../engine/index.ts';
import { MemoryCortex } from '../../memory/index.ts';
import { prependCalibrationToData } from '../../feedback/probabilityCalibration.ts';
import { handleSwarmSse } from '../streaming.ts';
import type { ServerRouteContext } from './types.ts';
import {
    resolveEnvironment,
    buildEdgeSettings,
    resolveAppIds,
    hydrateAppOutcomes,
    sanitizeClientSettings,
    sanitizeAgent,
    serializeSwarmResult,
    handleServerError
} from './helpers.ts';

export function registerAnalyzeRoutes(app: Hono, ctx: ServerRouteContext): void {
    const { defaultSettings, defaultAi, defaultCortex, swarmBodyLimit } = ctx;

    app.all('/api/swarm/stream', swarmBodyLimit, async (c) => {
        let params: SwarmWorkflowParams;
        try {
            const env = resolveEnvironment(c);
            const edgeSettings = buildEdgeSettings(env);

            const { callerAppId, originApp } = resolveAppIds(c, defaultSettings);

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
                    sanitizedSettings.agents = body.agents.map(sanitizeAgent);
                }
                hydrateAppOutcomes(originApp);

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
                hydrateAppOutcomes(originApp);
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
            return handleServerError('Stream', err, c);
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

            const { callerAppId, originApp } = resolveAppIds(c, defaultSettings);

            const env = resolveEnvironment(c);
            const edgeSettings = buildEdgeSettings(env);

            const sanitizedSettings = sanitizeClientSettings(body.settings, edgeSettings, defaultSettings);
            if (Array.isArray(body.agents)) {
                sanitizedSettings.agents = body.agents.map(sanitizeAgent);
            }

            hydrateAppOutcomes(originApp);

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

            return serializeSwarmResult(c, result);
        } catch (err: any) {
            return handleServerError('Analyze', err, c);
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

            const { callerAppId, originApp } = resolveAppIds(c, defaultSettings);

            const env = resolveEnvironment(c);
            const edgeSettings = buildEdgeSettings(env);

            const sanitizedSettings = sanitizeClientSettings(body.settings, edgeSettings, defaultSettings);
            if (Array.isArray(body.agents)) {
                sanitizedSettings.agents = body.agents.map(sanitizeAgent);
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
                    gameSettings.agents = item.agents.map(sanitizeAgent);
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
            return handleServerError('Backtest', err, c);
        }
    });
}
