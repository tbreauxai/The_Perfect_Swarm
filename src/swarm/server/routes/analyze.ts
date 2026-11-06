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
import { SwarmContext } from '../../context.ts';
import { globalAsyncJobs, wantsAsync, newJobId } from '../asyncJobs.ts';
import { getSupabaseConfig, fetchOnDemandSupabaseContext } from '../../morning/supabase.ts';
import { isSlimSwarmRequest, validateSlimSwarmRequest, slimIdsStubData } from '../slimPayload.ts';


/** Slim-v1: pull by eventIds before workflow; 422 slim_pull_* for DuelOdds fallback/proxy retry. */
async function resolveSlimOrReject(
  body: any,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; task: string; data: string; eventIds: string[]; date: string; sport: string } | { ok: false; status: 422; error: string }> {
  const bad = validateSlimSwarmRequest(body);
  if (bad) return { ok: false, status: 422, error: bad.startsWith('slim_pull_') ? bad : `slim_pull_failed: ${bad}` };
  const eventIds = body.eventIds.map((id: string) => String(id).trim()).filter(Boolean);
  const cfg = getSupabaseConfig();
  const pull = await fetchOnDemandSupabaseContext(cfg, {
    task: body.task,
    eventIds,
    gameDate: body.date,
    sport: body.sport,
    limit: Math.min(25, Math.max(eventIds.length * 2, 8)),
    requireHits: true
  }, fetchFn);
  if (pull.error === 'slim_pull_empty') {
    return { ok: false, status: 422, error: 'slim_pull_empty' };
  }
  if (pull.error) {
    // supabase_not_configured | unfiltered_refused | slim_pull_failed → agreed failed token
    return { ok: false, status: 422, error: 'slim_pull_failed' };
  }
  if (!pull.formattedBlock && pull.judgments.length === 0 && pull.lineSnapshots.length === 0) {
    return { ok: false, status: 422, error: 'slim_pull_empty' };
  }
  // Fail-closed: every requested ID needs judgment OR snapshot grounding (never ungrounded success).
  const hitIds = new Set<string>([
    ...pull.judgments.map((j: any) => String(j?.event_id || '')),
    ...pull.lineSnapshots.map((r: any) => String(r?.event_id || ''))
  ].filter(Boolean));
  const missing = eventIds.filter((id: string) => !hitIds.has(id));
  if (missing.length) {
    console.warn(`[SlimV1] slim_pull_empty: missing evidence for ${missing.join(',')}`);
    return { ok: false, status: 422, error: 'slim_pull_empty' };
  }
  let data = slimIdsStubData(body);
  if (pull.formattedBlock) data = `${data}

${pull.formattedBlock}`;
  return { ok: true, task: body.task, data, eventIds, date: body.date, sport: body.sport };
}

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
                let task = body.task;
                let data = body.data;
                let slimMeta: { eventIds?: string[]; date?: string; sport?: string } = {};
                if (isSlimSwarmRequest(body)) {
                    const slim = await resolveSlimOrReject(body);
                    if (slim.ok === false) return c.json({ error: slim.error, payload: 'slim-v1' }, slim.status);
                    task = slim.task;
                    data = slim.data;
                    slimMeta = { eventIds: slim.eventIds, date: slim.date, sport: slim.sport };
                } else if (!body.task || body.data === undefined) {
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
                    task,
                    data: prependCalibrationToData(data, originApp),
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
                    scorecardMode: body.scorecardMode === true,
                    eventIds: slimMeta.eventIds,
                    date: slimMeta.date,
                    sport: slimMeta.sport
                } as SwarmWorkflowParams;
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
            let task = body.task;
            let data = body.data;
            let slimMeta: { eventIds?: string[]; date?: string; sport?: string } = {};
            if (isSlimSwarmRequest(body)) {
                const slim = await resolveSlimOrReject(body);
                if (slim.ok === false) return c.json({ error: slim.error, payload: 'slim-v1' }, slim.status);
                task = slim.task;
                data = slim.data;
                slimMeta = { eventIds: slim.eventIds, date: slim.date, sport: slim.sport };
            } else if (!body.task || body.data === undefined) {
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

            const asyncMode = wantsAsync(c);
            const context = new SwarmContext();
            if (asyncMode) {
                // Pre-assign the engine's workflowId so the 202 id equals result.workflowId.
                (context as any).id = newJobId('wf', Date.now());
            }
            const workflowParams: SwarmWorkflowParams = {
                context,
                task,
                data: prependCalibrationToData(data, originApp),
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
                scorecardMode: body.scorecardMode === true,
                eventIds: slimMeta.eventIds,
                date: slimMeta.date,
                sport: slimMeta.sport
            } as SwarmWorkflowParams;

            if (asyncMode) {
                const workflowId = (context as any).id as string;
                globalAsyncJobs.start(workflowId, originApp, async () => {
                    const result = await executeSwarmWorkflow(workflowParams);
                    // Same body the sync path would send (serializeSwarmResult normalizes status/degraded/bigint).
                    const shim = {
                        newResponse: (b: string) => new Response(b),
                        json: (o: unknown) => new Response(JSON.stringify(o))
                    };
                    return await serializeSwarmResult(shim, result).json();
                });
                c.header('Preference-Applied', 'respond-async');
                c.header('Location', `/api/swarm/analyze/status/${workflowId}`);
                return c.json({ workflowId, status: 'pending' }, 202);
            }

            let result: any;
            try {
                result = await executeSwarmWorkflow(workflowParams);
            } catch (workflowErr: any) {
                console.error('[SwarmServer Analyze Workflow Error]:', workflowErr);
                return c.json({ error: workflowErr.message || 'Swarm workflow execution failed' }, 500);
            }

            return serializeSwarmResult(c, result);
        } catch (err: any) {
            return handleServerError('Analyze', err, c);
        }
    });

    // Async poll for Prefer: respond-async jobs (analyze and morning). Same auth as every /api route.
    app.get('/api/swarm/analyze/status/:workflowId', (c) => {
        const { originApp } = resolveAppIds(c, defaultSettings);
        const job = globalAsyncJobs.get(c.req.param('workflowId'), originApp);
        if (!job) return c.json({ error: 'Unknown workflowId' }, 404);
        if (job.status === 'done') return c.json({ status: 'done', result: job.result }, 200);
        if (job.status === 'error') return c.json({ status: 'error', error: job.error }, 200);
        return c.json({ status: 'pending' }, 200);
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
