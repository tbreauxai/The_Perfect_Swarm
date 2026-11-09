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
import { isSlimSwarmRequest, validateSlimSwarmRequest, slimIdsStubData, isSeedManifestRequest, validateSeedManifestRequest, seedManifestStubData, type SeedManifest } from '../slimPayload.ts';
import { globalToolRegistry, type ToolRegistry } from '../../tools/index.ts';
import { resolveTrustedRetrievalScope, type TrustedRetrievalScope } from '../../engine/historyScope.ts';
import {
    getSupabaseReadOnlyConfig,
    readGameContextFromStore,
    verifyAndAttachJudgmentProvenance,
    type GameContextStoreReadResult
} from '../../morning/gameContext.ts';

function emitHistoryContextObservabilityLog(
    route: 'analyze' | 'stream',
    scope: TrustedRetrievalScope,
    storeRead: GameContextStoreReadResult
): void {
    const summary: Record<string, unknown> = {
        route,
        callerAppId: scope.callerAppId,
        requestId: scope.requestId || null,
        purpose: scope.purpose || null,
        asOf: scope.asOf,
        groupCount: scope.groups.length,
        eventCount: scope.eventIds.length,
        storeStatus: storeRead.status
    };
    if (storeRead.status === 'ok') {
        summary.readyCount = storeRead.results.filter((r) => r.status === 'ready').length;
        summary.partialCount = storeRead.results.filter((r) => r.status === 'partial').length;
        summary.unavailableCount = storeRead.results.filter((r) => r.status === 'unavailable').length;
        summary.allReadyForSlim = storeRead.allReadyForSlim;
    } else {
        summary.reason = 'reason' in storeRead ? storeRead.reason : storeRead.error;
    }
    console.info('[HistoryContextReader]', JSON.stringify(summary));
}

/** Slim-v1: pull by eventIds before workflow; 422 slim_pull_* for DuelOdds fallback/proxy retry. */
async function resolveSlimOrReject(
    body: any,
    scope?: TrustedRetrievalScope,
    env?: Record<string, any>,
    fetchFn: typeof fetch = fetch,
    routeName: 'analyze' | 'stream' = 'analyze'
): Promise<
    | {
          ok: true;
          task: string;
          data: string;
          eventIds: string[];
          date: string;
          sport: string;
          storeRead?: GameContextStoreReadResult;
      }
    | { ok: false; status: 400 | 422; error: string; reason?: string }
> {
    if (isSeedManifestRequest(body)) {
        const manifestErr = validateSeedManifestRequest(body);
        if (manifestErr) {
            return { ok: false, status: 400, error: manifestErr, reason: 'invalid_seed_manifest' };
        }
        return {
            ok: true,
            task: body.task || `Analyze candidate ${body.candidate_id} for ${body.market_type || 'game'}`,
            data: seedManifestStubData(body),
            eventIds: [body.game_id],
            date: '',
            sport: body.sport
        };
    }
    const useStoreForSlim = Boolean(
        scope &&
            (scope.purpose === 'parlay' ||
                scope.purpose === 'bet-chat' ||
                scope.requiredContext.length > 0 ||
                scope.snapshotRefs.length > 0 ||
                (scope.hasExplicitRetrievalContext && scope.purpose !== 'morning'))
    );

    if (useStoreForSlim && scope) {
        const readCfg = getSupabaseReadOnlyConfig(env);
        const storeRead = await readGameContextFromStore(readCfg, scope, fetchFn);
        emitHistoryContextObservabilityLog(routeName, scope, storeRead);

        if (storeRead.status === 'invalid_scope') {
            return {
                ok: false,
                status: 400,
                error: storeRead.error,
                reason: 'invalid_retrieval_scope'
            };
        }

        if (
            storeRead.status !== 'ok' ||
            !storeRead.allReadyForSlim ||
            Object.keys(storeRead.missingRequiredSectionsByEvent).length > 0
        ) {
            return {
                ok: false,
                status: 422,
                error: 'slim_pull_failed',
                reason: 'slim_context_ineligible'
            };
        }

        const effectiveDate = scope.date || scope.groups[0]?.date || String(body.date || '');
        const effectiveSport = scope.sport || scope.groups[0]?.sport || String(body.sport || '');
        let data = slimIdsStubData({
            payload: 'slim-v1',
            task: body.task,
            date: effectiveDate,
            sport: effectiveSport,
            eventIds: scope.eventIds
        });
        if (storeRead.formattedBlock) {
            data = `${data}\n\n${storeRead.formattedBlock}`;
        }
        return {
            ok: true,
            task: body.task,
            data,
            eventIds: scope.eventIds,
            date: effectiveDate,
            sport: effectiveSport,
            storeRead
        };
    }

    const bad = validateSlimSwarmRequest(body);
    if (bad) return { ok: false, status: 422, error: bad.startsWith('slim_pull_') ? bad : `slim_pull_failed: ${bad}` };
    const eventIds = body.eventIds.map((id: string) => String(id).trim()).filter(Boolean);
    const cfg = getSupabaseConfig();
    const hasExplicitAsOf =
        body?.asOf !== undefined || body?.retrievalContext?.asOf !== undefined;
    const pull = await fetchOnDemandSupabaseContext(
        cfg,
        {
            task: body.task,
            eventIds,
            gameDate: body.date,
            sport: body.sport,
            ...(hasExplicitAsOf && scope?.asOf ? { asOf: scope.asOf } : {}),
            limit: Math.min(25, Math.max(eventIds.length * 2, 8)),
            requireHits: true
        },
        fetchFn
    );
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
    const hitIds = new Set<string>(
        [
            ...pull.judgments.map((j: any) => String(j?.event_id || '')),
            ...pull.lineSnapshots.map((r: any) => String(r?.event_id || ''))
        ].filter(Boolean)
    );
    const missing = eventIds.filter((id: string) => !hitIds.has(id));
    if (missing.length) {
        console.warn(`[SlimV1] slim_pull_empty: missing evidence for ${missing.join(',')}`);
        return { ok: false, status: 422, error: 'slim_pull_empty' };
    }
    let data = slimIdsStubData(body);
    if (pull.formattedBlock) {
        data = `${data}\n\n${pull.formattedBlock}`;
    }
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
                const isSeedManifest = isSeedManifestRequest(body);
                if (isSeedManifest) {
                    const manifestErr = validateSeedManifestRequest(body);
                    if (manifestErr) {
                        return c.json({ error: manifestErr, reason: 'invalid_seed_manifest' }, 400);
                    }
                    (c as any).set?.('candidate_id', body.candidate_id);
                    if (body.game_id) {
                        (c as any).set?.('event_id', body.game_id);
                    }
                }
                const hasExplicitScopeFields =
                    body.retrievalContext !== undefined ||
                    body.snapshotRefs !== undefined ||
                    body.asOf !== undefined ||
                    body.entityIds !== undefined;
                if (hasExplicitScopeFields) {
                    const earlyScope = resolveTrustedRetrievalScope({
                        body,
                        callerAppId,
                        defaultAppId: defaultSettings.appId
                    });
                    if (!earlyScope.ok) {
                        return c.json({ error: earlyScope.error, reason: earlyScope.reason }, earlyScope.status);
                    }
                }
                let task = body.task;
                let data = body.data;
                let slimMeta: { eventIds?: string[]; date?: string; sport?: string } = {};
                const isSlimRequest = isSlimSwarmRequest(body) || body?.payload === 'slim-v1';
                if (isSeedManifest) {
                    task = body.task || `Analyze candidate ${body.candidate_id} for ${body.market_type || 'game'}`;
                    data = seedManifestStubData(body);
                    slimMeta = { eventIds: [body.game_id], sport: body.sport };
                } else if (isSlimRequest) {
                    const slimScope = resolveTrustedRetrievalScope({
                        body,
                        callerAppId,
                        defaultAppId: defaultSettings.appId
                    });
                    const candidateSlim = slimScope.ok
                        ? {
                              ...body,
                              date: body.date ?? slimScope.scope.date ?? slimScope.scope.groups[0]?.date,
                              sport: body.sport ?? slimScope.scope.sport ?? slimScope.scope.groups[0]?.sport,
                              eventIds: body.eventIds ?? slimScope.scope.eventIds
                          }
                        : body;
                    if (!isSlimSwarmRequest(candidateSlim)) {
                        if (!slimScope.ok) {
                            return c.json({ error: slimScope.error, reason: slimScope.reason }, slimScope.status);
                        }
                        return c.json({ error: 'slim_pull_failed', payload: 'slim-v1' }, 422);
                    }
                    const slim = await resolveSlimOrReject(
                        candidateSlim,
                        slimScope.ok ? slimScope.scope : undefined,
                        env,
                        fetch,
                        'stream'
                    );
                    if (slim.ok === false) {
                        if (slim.status === 400) {
                            return c.json(
                                { error: slim.error, ...(slim.reason ? { reason: slim.reason } : {}) },
                                400
                            );
                        }
                        return c.json(
                            {
                                error: slim.error,
                                payload: 'slim-v1',
                                ...(slim.reason ? { reason: slim.reason } : {})
                            },
                            slim.status
                        );
                    }
                    task = slim.task;
                    data = slim.data;
                    slimMeta = { eventIds: slim.eventIds, date: slim.date, sport: slim.sport };
                } else if (!body.task || body.data === undefined) {
                    return c.json({ error: 'Missing required parameter: task and data' }, 400);
                }
                const scopeCheck = resolveTrustedRetrievalScope({
                    body:
                        body.retrievalContext !== undefined
                            ? body
                            : {
                                  ...body,
                                  ...(isSeedManifest
                                      ? {
                                            eventIds: [body.game_id],
                                            sport: body.sport
                                        }
                                      : {}),
                                  ...(slimMeta.eventIds && !body.eventIds ? { eventIds: slimMeta.eventIds } : {}),
                                  ...(slimMeta.date && !body.date ? { date: slimMeta.date } : {}),
                                  ...(slimMeta.sport && !body.sport ? { sport: slimMeta.sport } : {})
                              },
                    callerAppId,
                    defaultAppId: defaultSettings.appId
                });
                if (!scopeCheck.ok) {
                    return c.json({ error: scopeCheck.error, reason: scopeCheck.reason }, scopeCheck.status);
                }

                if (!isSlimRequest && scopeCheck.scope.usesContextStore) {
                    const storeRead = await readGameContextFromStore(
                        getSupabaseReadOnlyConfig(env),
                        scopeCheck.scope
                    );
                    emitHistoryContextObservabilityLog('stream', scopeCheck.scope, storeRead);

                    if (storeRead.status === 'invalid_scope') {
                        return c.json(
                            {
                                error: storeRead.error,
                                reason: 'invalid_retrieval_scope',
                                detail: storeRead.detail
                            },
                            400
                        );
                    }
                    if (scopeCheck.scope.requiredContext.length > 0) {
                        if (storeRead.status === 'outage') {
                            return c.json(
                                { error: 'history_context_read_failed', detail: storeRead.detail },
                                503
                            );
                        }
                        if (storeRead.status === 'store_not_ready') {
                            return c.json(
                                {
                                    error: 'history_context_unavailable',
                                    reason: storeRead.reason,
                                    detail: storeRead.detail
                                },
                                422
                            );
                        }
                        if (
                            storeRead.status === 'ok' &&
                            Object.keys(storeRead.missingRequiredSectionsByEvent).length > 0
                        ) {
                            return c.json(
                                {
                                    error: 'history_context_unavailable',
                                    missingRequiredSections: storeRead.missingRequiredSectionsByEvent
                                },
                                422
                            );
                        }
                    }
                    if (
                        storeRead.status === 'ok' &&
                        storeRead.formattedBlock &&
                        typeof data === 'string' &&
                        body.settings?.disableMemoryRetrieval
                    ) {
                        data = `${data}\n\n${storeRead.formattedBlock}`;
                    }
                }

                if (body.metadata) {
                    console.log('[SwarmServer Stream Metadata]:', body.metadata);
                }
                const sanitizedSettings = sanitizeClientSettings(body.settings, edgeSettings, defaultSettings);
                sanitizedSettings.appId = originApp;
                delete sanitizedSettings.userId;
                delete sanitizedSettings.ownerId;
                delete sanitizedSettings.visibility;
                delete sanitizedSettings.ownership;
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
                    tools: isSeedManifest ? globalToolRegistry.scoped(body.available_tools || []) : body.tools,
                    enableDeepAnalysis: body.enableDeepAnalysis,
                    forceFullSwarm: body.forceFullSwarm,
                    speculativeParallel: body.speculativeParallel,
                    maxSpeculativeConcurrency: body.maxSpeculativeConcurrency,
                    complexityOverride: body.complexityOverride,
                    bypassCache: body.bypassCache,
                    scorecardMode: body.scorecardMode === true,
                    eventIds: isSeedManifest ? [body.game_id] : (scopeCheck.scope.eventIds.length > 0 ? scopeCheck.scope.eventIds : slimMeta.eventIds),
                    date: scopeCheck.scope.date ?? slimMeta.date,
                    sport: isSeedManifest ? body.sport : (scopeCheck.scope.sport ?? slimMeta.sport),
                    entityIds: scopeCheck.scope.entityIds.length > 0 ? scopeCheck.scope.entityIds : undefined,
                    retrievalContext: scopeCheck.retrievalContext,
                    snapshotRefs: scopeCheck.snapshotRefs,
                    retrievalScope: scopeCheck.scope,
                    ...(isSeedManifest
                        ? {
                              seedManifest: body,
                              candidateId: body.candidate_id,
                              marketType: body.market_type,
                              pricing: body.pricing,
                              flags: body.flags
                          }
                        : {})
                } as SwarmWorkflowParams;
            } else if (c.req.method === 'GET') {
                const url = new URL(c.req.url);
                const task = url.searchParams.get('task') || '';
                const data = url.searchParams.get('data');
                if (!task || data === null) {
                    return c.json({ error: 'Missing required parameter: task and data' }, 400);
                }
                const domain = url.searchParams.get('domain') || undefined;
                const getScope = resolveTrustedRetrievalScope({
                    body: {},
                    callerAppId,
                    defaultAppId: defaultSettings.appId
                });
                const getSettings = sanitizeClientSettings({ domain }, edgeSettings, defaultSettings);
                getSettings.appId = originApp;
                hydrateAppOutcomes(originApp);
                params = {
                    task,
                    data: prependCalibrationToData(data, originApp),
                    originApp,
                    callerAppId,
                    domain,
                    settings: getSettings,
                    defaultAi,
                    cortex: defaultCortex,
                    ...(getScope.ok ? { retrievalScope: getScope.scope } : {})
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
            const env = resolveEnvironment(c);
            const edgeSettings = buildEdgeSettings(env);
            const body = await c.req.json().catch(() => ({}));
            const { callerAppId, originApp } = resolveAppIds(c, defaultSettings);
            const isSeedManifest = isSeedManifestRequest(body);
            if (isSeedManifest) {
                const manifestErr = validateSeedManifestRequest(body);
                if (manifestErr) {
                    return c.json({ error: manifestErr, reason: 'invalid_seed_manifest' }, 400);
                }
                (c as any).set?.('candidate_id', body.candidate_id);
                if (body.game_id) {
                    (c as any).set?.('event_id', body.game_id);
                }
            }
            const hasExplicitScopeFields =
                body.retrievalContext !== undefined ||
                body.snapshotRefs !== undefined ||
                body.asOf !== undefined ||
                body.entityIds !== undefined;
            if (hasExplicitScopeFields) {
                const earlyScope = resolveTrustedRetrievalScope({
                    body,
                    callerAppId,
                    defaultAppId: defaultSettings.appId
                });
                if (!earlyScope.ok) {
                    return c.json({ error: earlyScope.error, reason: earlyScope.reason }, earlyScope.status);
                }
            }
            let task = body.task;
            let data = body.data;
            let slimMeta: { eventIds?: string[]; date?: string; sport?: string } = {};
            let preloadedGameContext: GameContextStoreReadResult | undefined;
            const isSlimRequest = isSlimSwarmRequest(body) || body?.payload === 'slim-v1';
            if (isSeedManifest) {
                task = body.task || `Analyze candidate ${body.candidate_id} for ${body.market_type || 'game'}`;
                data = seedManifestStubData(body);
                slimMeta = { eventIds: [body.game_id], sport: body.sport };
            } else if (isSlimRequest) {
                const slimScope = resolveTrustedRetrievalScope({
                    body,
                    callerAppId,
                    defaultAppId: defaultSettings.appId
                });
                const candidateSlim = slimScope.ok
                    ? {
                          ...body,
                          date: body.date ?? slimScope.scope.date ?? slimScope.scope.groups[0]?.date,
                          sport: body.sport ?? slimScope.scope.sport ?? slimScope.scope.groups[0]?.sport,
                          eventIds: body.eventIds ?? slimScope.scope.eventIds
                      }
                    : body;
                if (!isSlimSwarmRequest(candidateSlim)) {
                    if (!slimScope.ok) {
                        return c.json({ error: slimScope.error, reason: slimScope.reason }, slimScope.status);
                    }
                    return c.json({ error: 'slim_pull_failed', payload: 'slim-v1' }, 422);
                }
                const slim = await resolveSlimOrReject(
                    candidateSlim,
                    slimScope.ok ? slimScope.scope : undefined,
                    env,
                    fetch,
                    'analyze'
                );
                if (slim.ok === false) {
                    if (slim.status === 400) {
                        return c.json(
                            { error: slim.error, ...(slim.reason ? { reason: slim.reason } : {}) },
                            400
                        );
                    }
                    return c.json(
                        {
                            error: slim.error,
                            payload: 'slim-v1',
                            ...(slim.reason ? { reason: slim.reason } : {})
                        },
                        slim.status
                    );
                }
                task = slim.task;
                data = slim.data;
                slimMeta = { eventIds: slim.eventIds, date: slim.date, sport: slim.sport };
                preloadedGameContext = slim.storeRead;
            } else if (!body.task || body.data === undefined) {
                return c.json({ error: 'Missing required parameter: task and data' }, 400);
            }
            const scopeCheck = resolveTrustedRetrievalScope({
                body:
                    body.retrievalContext !== undefined
                        ? body
                        : {
                              ...body,
                              ...(isSeedManifest
                                  ? {
                                        eventIds: [body.game_id],
                                        sport: body.sport
                                    }
                                  : {}),
                              ...(slimMeta.eventIds && !body.eventIds ? { eventIds: slimMeta.eventIds } : {}),
                              ...(slimMeta.date && !body.date ? { date: slimMeta.date } : {}),
                              ...(slimMeta.sport && !body.sport ? { sport: slimMeta.sport } : {})
                          },
                callerAppId,
                defaultAppId: defaultSettings.appId
            });
            if (!scopeCheck.ok) {
                return c.json({ error: scopeCheck.error, reason: scopeCheck.reason }, scopeCheck.status);
            }

            if (!isSlimRequest && scopeCheck.scope.usesContextStore) {
                const storeRead = await readGameContextFromStore(
                    getSupabaseReadOnlyConfig(env),
                    scopeCheck.scope
                );
                preloadedGameContext = storeRead;
                emitHistoryContextObservabilityLog('analyze', scopeCheck.scope, storeRead);

                if (storeRead.status === 'invalid_scope') {
                    return c.json(
                        {
                            error: storeRead.error,
                            reason: 'invalid_retrieval_scope',
                            detail: storeRead.detail
                        },
                        400
                    );
                }
                if (scopeCheck.scope.requiredContext.length > 0) {
                    if (storeRead.status === 'outage') {
                        return c.json(
                            { error: 'history_context_read_failed', detail: storeRead.detail },
                            503
                        );
                    }
                    if (storeRead.status === 'store_not_ready') {
                        return c.json(
                            {
                                error: 'history_context_unavailable',
                                reason: storeRead.reason,
                                detail: storeRead.detail
                            },
                            422
                        );
                    }
                    if (
                        storeRead.status === 'ok' &&
                        Object.keys(storeRead.missingRequiredSectionsByEvent).length > 0
                    ) {
                        return c.json(
                            {
                                error: 'history_context_unavailable',
                                missingRequiredSections: storeRead.missingRequiredSectionsByEvent
                            },
                            422
                        );
                    }
                }
                if (
                    storeRead.status === 'ok' &&
                    storeRead.formattedBlock &&
                    typeof data === 'string' &&
                    body.settings?.disableMemoryRetrieval
                ) {
                    data = `${data}\n\n${storeRead.formattedBlock}`;
                }
            }

            if (body.metadata) {
                console.log('[SwarmServer Analyze Metadata]:', body.metadata);
            }

            const sanitizedSettings = sanitizeClientSettings(body.settings, edgeSettings, defaultSettings);
            sanitizedSettings.appId = originApp;
            delete sanitizedSettings.userId;
            delete sanitizedSettings.ownerId;
            delete sanitizedSettings.visibility;
            delete sanitizedSettings.ownership;
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
                tools: isSeedManifest ? globalToolRegistry.scoped(body.available_tools || []) : body.tools,
                enableDeepAnalysis: body.enableDeepAnalysis,
                forceFullSwarm: body.forceFullSwarm,
                speculativeParallel: body.speculativeParallel,
                maxSpeculativeConcurrency: body.maxSpeculativeConcurrency,
                complexityOverride: body.complexityOverride,
                bypassCache: body.bypassCache,
                scorecardMode: body.scorecardMode === true,
                eventIds: isSeedManifest ? [body.game_id] : (scopeCheck.scope.eventIds.length > 0 ? scopeCheck.scope.eventIds : slimMeta.eventIds),
                date: scopeCheck.scope.date ?? slimMeta.date,
                sport: isSeedManifest ? body.sport : (scopeCheck.scope.sport ?? slimMeta.sport),
                entityIds: scopeCheck.scope.entityIds.length > 0 ? scopeCheck.scope.entityIds : undefined,
                retrievalContext: scopeCheck.retrievalContext,
                snapshotRefs: scopeCheck.snapshotRefs,
                retrievalScope: scopeCheck.scope,
                ...(isSeedManifest
                    ? {
                          seedManifest: body,
                          candidateId: body.candidate_id,
                          marketType: body.market_type,
                          pricing: body.pricing,
                          flags: body.flags
                      }
                    : {})
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

            if (
                preloadedGameContext?.status === 'ok' &&
                result?.finalAnalysis &&
                typeof result.finalAnalysis === 'object' &&
                preloadedGameContext.results.length === 1
            ) {
                const singleEventId = preloadedGameContext.results[0].event_id;
                const analysisObj = result.finalAnalysis as Record<string, unknown>;
                const prov = verifyAndAttachJudgmentProvenance(
                    {
                        event_id:
                            typeof analysisObj.event_id === 'string' && analysisObj.event_id.trim()
                                ? analysisObj.event_id
                                : singleEventId,
                        ...analysisObj
                    },
                    preloadedGameContext.byEventId
                );
                if (!prov.ok) {
                    return c.json({ error: prov.reason, detail: prov.message }, 422);
                }
                result.finalAnalysis = prov.judgment;
            }

            if (isSeedManifest && result?.finalAnalysis && typeof result.finalAnalysis === 'object') {
                if (!result.finalAnalysis.candidate_id) {
                    result.finalAnalysis.candidate_id = body.candidate_id;
                }
                if (!result.finalAnalysis.tools_called) {
                    result.finalAnalysis.tools_called = Array.isArray(result.tools_called) ? result.tools_called : [];
                }
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
