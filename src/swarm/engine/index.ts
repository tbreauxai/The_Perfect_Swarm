import { sanitizeApiKey, validateProviderKey, resolveProvider, type ProviderResolution } from "./utils.ts";
export { sanitizeApiKey, validateProviderKey, resolveProvider, type ProviderResolution };
import { ANALYST_SYSTEM_INSTRUCTION, MANAGER_SYSTEM_INSTRUCTION } from "./constants.ts";
export { ANALYST_SYSTEM_INSTRUCTION, MANAGER_SYSTEM_INSTRUCTION };
import { defaultCortexRegistry, getOrCreateDefaultCortex } from "./cortex.ts";
export { defaultCortexRegistry, getOrCreateDefaultCortex };
import type { SwarmStagePayload, SwarmWorkflowParams, SwarmWorkflowResult, SwarmFeedbackReport } from "./types.ts";
export type { SwarmStagePayload, SwarmWorkflowParams, SwarmWorkflowResult, SwarmFeedbackReport };
import { SwarmEngine } from "./SwarmEngine.ts";
export { SwarmEngine };
export * from "./toolExecutionHelper.ts";
import { executeFastPath } from "./fastPath.ts";
import { checkSubComputationCache, resolveEarlyCacheHit } from "./cachingPipeline.ts";
import { runDataProfilingPipeline } from "./profilingPipeline.ts";
import { extractAnalystConsensus, renderPromptConsensusBlock, type AnalystConsensusDigest } from "./consensusPipeline.ts";
export { extractAnalystConsensus, renderPromptConsensusBlock, type AnalystConsensusDigest };
import { runDeterministicMathGrounding, type QuantitativeGroundingReport } from "./mathGrounding.ts";
export { runDeterministicMathGrounding, type QuantitativeGroundingReport };
import { computeCalibratedEnsemble, countVerifiedCitations, type CalibratedEnsembleDigest } from "./predictionEnsemble.ts";
export { computeCalibratedEnsemble, countVerifiedCitations, type CalibratedEnsembleDigest };
import { bindCortexAndTools } from "./cortexBinding.ts";
import { resolveExperimentVariant, resolveSwarmAgents } from "./agentResolution.ts";
import { resolveMemoryGrounding } from "./memoryGrounding.ts";
import { runClusterPipeline } from "./clusterPipeline.ts";
import { compileSynthesisPrompt, executeManagerSynthesis } from "./synthesisPipeline.ts";
import {
    recordDegraded,
    getDegraded,
    countAnalystOutputs,
    pickBestAnalystOutput,
    buildPartialFinalAnalysis,
    type SwarmRunStatus
} from "./partialResult.ts";
import { pickMatchesVetoedTarget, runDeepAnalysisVerification } from "./verificationPipeline.ts";
import { runLearningPipeline } from "./learningPipeline.ts";
import { reconcileFinalVerdictAndPicks } from "../tools/criticAudit.ts";
import { isScorecardMode } from "./scorecard.ts";
import { buildBlackboard } from "./blackboard.ts";
import {
  executeScorecardSynthesis,
  emptySynthesisResult,
} from "./scorecardManager.ts";
import { parseGameHeaders, filterPicksByCoverage } from "../context/gameHeaders.ts";
import { buildVerifierEvidence } from "./verifierEvidence.ts";
import { collectSuccessfulEvidenceItems } from "../tools/criticEvidence.ts";
import { dedupeVetoMessages, extractVetoedLegTargets, mergeVetoedClaims, mergeVetoedLegTargets, type VetoedLegTarget } from "../tools/claimGrounding.ts";
import { extractRowOptions } from "../tools/marketRowBinding.ts";
import { mergeToolCallTraceEntries, type ToolCallTraceEntry } from "../tools/pullBeforePass.ts";
import { isDataRequest } from "../parser/responseGuards.ts";
import { planTriage, type TriagePlan } from "./triagePlanner.ts";
import { executeTriage, type CuratedDossier } from "./triageExecutor.ts";
import { globalGameQueryCache } from "../cache/gameQueryCache.ts";
import {
    fetchTwoHopSlateDossier,
    toSerializableCuratedDossier,
    type UnifiedSlateDossier
} from "./unifiedDossier.ts";
export { planTriage, executeTriage, globalGameQueryCache };
export type { TriagePlan, CuratedDossier };

import { SwarmContext } from '../context.ts';
import { globalMetricsCollector } from '../profiler.ts';
import { ModelRouter, type TaskComplexity } from '../router.ts';
import { PayloadCache } from '../cache.ts';
import { globalKnowledgeGraph } from '../knowledgeGraph.ts';
import { globalLearningRateManager, globalHypothesisLayer } from '../coordination.ts';
import { globalTieredCache } from '../tieredCache.ts';
import { globalFeedbackEngine } from '../feedback.ts';
import { isRunDebugPersistEnabled, persistRunDebugRecord } from './runDebugPersist.ts';
import { recordRunDebugAgreement } from './runDebugRecord.ts';
import { buildCompactRunDiagnostics, type CompactRunDiagnostics } from './runDiagnostics.ts';
export { buildCompactRunDiagnostics, type CompactRunDiagnostics };

export async function executeSwarmWorkflow(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
    const workflowStartTime = Date.now();
    const { task, data, settings, defaultAi, enableDeepAnalysis, complexityOverride, onEvent } = params;
    const context = params.context || new SwarmContext();
    if (!(context as any).id) {
        (context as any).id = `wf-${Date.now()}`;
    }
    console.log(`[Swarm] workflow ${(context as any).id} start`);
    const unsubscribe = onEvent ? context.subscribe(onEvent) : undefined;
    // R2: opt-in scorecard + blackboard flow (request or settings); never for morning_judge.
    const scorecardMode = isScorecardMode(params, settings);

    try {
        const optSettings = settings?.optimizationSettings;
        const optimizationEnabled = optSettings?.enabled !== false;

        // 0a. Fast sub-computation cache check
        if (optimizationEnabled && optSettings?.enableSubComputationCache !== false && !params.preloadedGameContext && !params.forceFullSwarm && !settings?.forceFullSwarm && !scorecardMode) {
            const subResult = checkSubComputationCache({
                task,
                context,
                onPartialResult: params.onPartialResult,
                onStage: params.onStage,
                getMetrics: () => globalMetricsCollector.getBaselineReport()
            });
            if (subResult) return subResult;
        }

        const targetAppId = params.retrievalScope?.callerAppId || params.callerAppId || params.originApp || settings?.appId || 'perfect-swarm';
        const includeShared = settings?.includeSharedMemory !== false;
        const qdrantUrl = settings?.qdrantUrl;

        // 0. Apply dynamic RL default policy
        const bestPolicy = globalFeedbackEngine.getPolicyOptimizer().getBestPolicy();
        if (settings) {
            if (settings.cacheSettings) {
                settings.cacheSettings.semanticThreshold = settings.cacheSettings.semanticThreshold ?? bestPolicy.cacheSemanticThreshold;
            } else {
                settings.cacheSettings = { semanticThreshold: bestPolicy.cacheSemanticThreshold };
            }

            if (settings.optimizationSettings) {
                settings.optimizationSettings.compressionTargetReductionRatio = settings.optimizationSettings.compressionTargetReductionRatio ?? bestPolicy.compressionTargetReductionRatio;
            } else {
                settings.optimizationSettings = { compressionTargetReductionRatio: bestPolicy.compressionTargetReductionRatio };
            }

            if (settings.clusterSettings) {
                settings.clusterSettings.schedulerMaxConcurrency = settings.clusterSettings.schedulerMaxConcurrency ?? bestPolicy.schedulerMaxConcurrency;
            } else {
                settings.clusterSettings = { schedulerMaxConcurrency: bestPolicy.schedulerMaxConcurrency };
            }
        } else {
            (params as any).settings = {
                cacheSettings: { semanticThreshold: bestPolicy.cacheSemanticThreshold },
                optimizationSettings: { compressionTargetReductionRatio: bestPolicy.compressionTargetReductionRatio },
                clusterSettings: { schedulerMaxConcurrency: bestPolicy.schedulerMaxConcurrency }
            };
        }

        const { memoryCortex, toolRegistry } = bindCortexAndTools(params, params.settings || settings, defaultAi, targetAppId);

        const isTwoHopSlateRun =
            !params.seedManifest &&
            (params.triageMode === 'two-hop' || (typeof data === 'string' && data.includes('=== COMPACT SLATE ===')));

        if (isTwoHopSlateRun) {
            const rawSlateSource = typeof data === 'string' && data.length > 0 ? data : (data ? JSON.stringify(data) : '');
            const parsedSlateHeaders = parseGameHeaders(rawSlateSource, params.eventIds);
            const hasNoUpcomingMarker = /\bNo upcoming games\b/i.test(rawSlateSource);
            const hasExplicitEmptyEventIds = Array.isArray(params.eventIds) && params.eventIds.length === 0;
            const activeEventSet = Array.isArray(params.eventIds) && params.eventIds.length > 0
                ? new Set(params.eventIds.map((id) => String(id).trim()).filter(Boolean))
                : null;
            const activeSlateHeaders =
                hasNoUpcomingMarker || hasExplicitEmptyEventIds
                    ? []
                    : (activeEventSet && activeEventSet.size > 0
                        ? parsedSlateHeaders.filter((h) => activeEventSet.has(h.eventId))
                        : parsedSlateHeaders);

            if (activeSlateHeaders.length === 0) {
                const emptyHop1Plan = {
                    mode: 'two-hop-slate',
                    triageMode: params.triageMode || 'two-hop',
                    active_event_ids: [] as string[],
                    slate_games_count: 0,
                    priced_games_count: 0,
                    r_id_count: 0,
                    selected_tools: [] as string[],
                    reasoning: 'Empty pregame slate (0 upcoming games); short-circuited prior to Qdrant retrieval and LLM execution.'
                };
                const emptyDossier = {
                    mode: 'two-hop-slate',
                    active_event_ids: [] as string[],
                    sections: [] as any[],
                    tool_call_trace: [] as any[],
                    seat_visibility: [] as any[],
                    markdown: '',
                    tokenEstimate: 0,
                    totalDurationMs: 0
                };
                const passMsg = 'All games on this pregame slate have already started (0 upcoming events). Switch to Live mode for in-progress games or check tomorrow\'s slate.';
                const emptyFinalAnalysis: any = {
                    ui_title: 'No Upcoming Pregame Games',
                    analysis: passMsg,
                    summary: passMsg,
                    picks: [],
                    pass: true,
                    wageringPass: true,
                    criticApproved: true,
                    verified: true,
                    tools_called: [],
                    hop1Plan: emptyHop1Plan,
                    curatedDossier: emptyDossier,
                    components: [
                        {
                            type: 'InsightList',
                            props: {
                                title: 'Pregame Slate Empty',
                                insights: [{ type: 'info', message: passMsg }]
                            }
                        }
                    ]
                };
                params.hop1Plan = emptyHop1Plan;
                params.curatedDossier = emptyDossier;
                params.onStage?.({
                    stage: 'hop1_plan',
                    plan: emptyHop1Plan,
                    selected_tools: []
                });
                params.onStage?.({
                    stage: 'curated_dossier',
                    dossier: emptyDossier
                });
                params.onStage?.({
                    stage: 'completed',
                    task,
                    finalAnalysis: emptyFinalAnalysis
                });
                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Empty Slate Short-Circuit',
                    modelName: 'Local/TypeScript',
                    prompt: 'Two-hop slate contained 0 upcoming event IDs; skipping Qdrant and LLM calls.',
                    output: {
                        activeEventIds: [],
                        wageringPass: true,
                        criticApproved: true
                    },
                    durationMs: Date.now() - workflowStartTime
                });
                return {
                    workflowId: (context as any).id,
                    status: 'complete',
                    partial: false,
                    degraded: [],
                    tools_called: [],
                    hop1Plan: emptyHop1Plan,
                    curatedDossier: emptyDossier,
                    events: context.events,
                    finalAnalysis: emptyFinalAnalysis,
                    metrics: globalMetricsCollector.getBaselineReport()
                };
            }
        }

        // 0. Infer Task Complexity via ModelRouter
        // R2: scorecard mode always runs the full swarm (the fast path has no scorecards or blackboard).
        const forceFullSwarm = scorecardMode || (params.forceFullSwarm ?? settings?.forceFullSwarm ?? settings?.disableFastPath ?? false);
        const deepAnalysisFlag = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? false;
        const bypassCache = Boolean(params.preloadedGameContext) || (params.bypassCache ?? false);
        const complexity: TaskComplexity = complexityOverride || ModelRouter.inferComplexity(
            task,
            (data || '').length,
            1,
            forceFullSwarm,
            { userQuestion: params.userQuestion, deepAnalysis: deepAnalysisFlag }
        );
        const deepAnalysisRequested = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? (complexity === 'complex');

        const agentConfigVersion = PayloadCache.hashString(
            (settings?.agents || []).map((a: any) => `${a.id || a.role}:${a.provider}/${a.model || ''}`).join('|')
            + (scorecardMode ? '|scorecardMode' : '') // R2: never share cache entries with non-scorecard runs
            + (params.preloadedGameContext?.status === 'ok'
                ? `|context:${params.preloadedGameContext.results.map(row => `${row.event_id}:${row.content_hash || 'none'}`).join('|')}`
                : '')
        ).substring(0, 16);

        const cacheKey = PayloadCache.computeFingerprint(task, data || "", {
            appId: targetAppId,
            deepAnalysis: deepAnalysisRequested,
            complexity,
            forceFullSwarm,
            agentConfigVersion
        });

        const tieredCacheEnabled = settings?.tieredCacheSettings?.enabled === true;
        const cacheQuery = `${task}\n${data || ''}`.trim();

        // 0b & 0c. Check Tiered, Payload, and Semantic Caches
        const earlyCacheResult = await resolveEarlyCacheHit({
            task,
            data,
            cacheKey,
            cacheQuery,
            agentConfigVersion,
            tieredCacheEnabled,
            forceFullSwarm,
            bypassCache,
            workflowStartTime,
            targetAppId,
            settings,
            context,
            params
        });
        if (earlyCacheResult) return earlyCacheResult;

        // 0d. Resolve A/B Testing Experiment Variant
        const { activeExperiment, activeVariant } = resolveExperimentVariant(settings, targetAppId, task, context);

        // 1. Resolve Manager, Analysts, and Critic
        const { managerAgent, analysts, dedicatedCriticAgent, managerModel, managerConfig } = resolveSwarmAgents(settings, activeVariant, defaultAi);

        const fastPathDecision = ModelRouter.evaluateFastPath(task, data || "", deepAnalysisRequested, forceFullSwarm);
        context.addEvent({
            agentRole: 'Model Router',
            action: 'Routing & Complexity Classification',
            modelName: 'Local/TypeScript',
            prompt: `Routing task with inferred complexity='${complexity}', fastPathEligible=${fastPathDecision.eligible}${forceFullSwarm ? ' (Fast track overridden: forceFullSwarm=true)' : ''}`,
            output: {
                complexity,
                fastPath: fastPathDecision,
                deepAnalysis: deepAnalysisRequested,
                forceFullSwarm,
                manager: { provider: managerConfig.provider, model: managerModel },
                analysts: analysts.map(a => ({ role: a.role, provider: a.provider, model: a.modelName }))
            },
            durationMs: 0
        });

        const coordinationSettings = settings?.coordinationSettings;
        const coordinationEnabled = coordinationSettings?.enabled !== false;

        if (fastPathDecision.eligible && analysts.length > 0) {
            const fastResult = await executeFastPath(
                fastPathDecision, analysts, context, params, settings,
                activeVariant, activeExperiment, cacheKey, cacheQuery, agentConfigVersion,
                targetAppId, memoryCortex, workflowStartTime, tieredCacheEnabled,
                coordinationEnabled, toolRegistry
            );
            if (fastResult) {
                if (params.preloadedGameContext) {
                    const toolsCalled = new Set(fastResult.tools_called || []);
                    toolsCalled.add('read_game_context_v1');
                    fastResult.tools_called = Array.from(toolsCalled);
                    if (fastResult.finalAnalysis && typeof fastResult.finalAnalysis === 'object') {
                        fastResult.finalAnalysis.tools_called = [...fastResult.tools_called];
                    }
                }
                return fastResult;
            }
        }

        let finalAnalysis: any = null;
        let workflowLifecycleResult: any = null;

        try {
            // Step 1: Data Profiling & Budgeting Pipeline
            const profilingResult = runDataProfilingPipeline({
                task,
                data,
                analysts,
                settings,
                optimizationEnabled,
                coordinationEnabled,
                context
            });

            // Step 3: Targeted Memory Grounding + Pre-Execution Deterministic Math Grounding
            const { historicalContext: rawHistoricalContext } = await resolveMemoryGrounding({
                memoryCortex,
                task,
                data,
                targetAppId,
                includeShared,
                bypassCache,
                qdrantUrl,
                toolRegistry,
                context,
                domain: params.domain || settings?.domain,
                domains: params.domains || (settings as any)?.domains,
                disableMemoryRetrieval: Boolean(params.disableMemoryRetrieval || settings?.disableMemoryRetrieval),
                settings,
                eventIds: params.eventIds,
                date: params.date,
                sport: params.sport,
                entityIds: params.entityIds,
                retrievalContext: params.retrievalContext,
                snapshotRefs: params.snapshotRefs,
                retrievalScope: params.retrievalScope,
                preloadedGameContext: params.preloadedGameContext,
                triageMode: params.triageMode || (isTwoHopSlateRun ? 'two-hop' : undefined),
                curatedDossierActive: Boolean(params.curatedDossier || params.seedManifest || isTwoHopSlateRun)
            });

            const mathBlock = profilingResult.mathGroundingReport?.promptBlock;
            const calibrationBlock = profilingResult.extractedCalibrationBlock;
            const contextParts = [
                rawHistoricalContext,
                calibrationBlock && !rawHistoricalContext.includes('=== SWARM EMPIRICAL WIN CALIBRATION ===') ? calibrationBlock : '',
                mathBlock || ''
            ].filter(Boolean);
            const historicalContext = contextParts.join('\n\n');

            // Hop 1: Two-Hop Triage & Fetch (when SeedManifest is provided or triageMode === 'two-hop')
            let hop1Plan: any = params.hop1Plan;
            let curatedDossier: CuratedDossier | any | undefined = params.curatedDossier;
            let unifiedSlateDossier: UnifiedSlateDossier | undefined;
            const env = typeof process !== "undefined" ? process.env : {} as Record<string, string | undefined>;
            if (params.seedManifest && !curatedDossier) {
                // 1. Triage Plan
                const plan = await planTriage(params.seedManifest, {
                    context,
                    env,
                    qdrantClient: (params as any).qdrantClient
                });
                hop1Plan = plan;
                params.hop1Plan = plan;
                params.onStage?.({
                    stage: 'hop1_plan',
                    plan
                });

                // 2. Parallel Fetch & Dossier Assemble
                curatedDossier = await executeTriage(plan, params.seedManifest, {
                    toolRegistry,
                    cache: globalGameQueryCache,
                    env,
                    qdrantClient: (params as any).qdrantClient
                });
                params.onStage?.({
                    stage: 'hop1_exec',
                    sections: curatedDossier.sections,
                    durationMs: curatedDossier.totalDurationMs
                });
                params.onStage?.({
                    stage: 'curated_dossier',
                    dossier: curatedDossier
                });
                params.curatedDossier = curatedDossier;
            } else if (isTwoHopSlateRun && !hop1Plan) {
                const rawSlateSource = typeof data === 'string' && data.length > 0 ? data : (profilingResult.rawInput || '');
                const parsedSlateHeaders = parseGameHeaders(rawSlateSource, params.eventIds);
                const activeSet = Array.isArray(params.eventIds) && params.eventIds.length > 0
                    ? new Set(params.eventIds.map((id) => String(id).trim()).filter(Boolean))
                    : null;
                const scopedHeaders = activeSet && activeSet.size > 0
                    ? parsedSlateHeaders.filter((h) => activeSet.has(h.eventId))
                    : parsedSlateHeaders;
                const activeHeaders = scopedHeaders.length > 0 ? scopedHeaders : parsedSlateHeaders;
                const selectedTools = [
                    'get_matchup_fundamentals',
                    'get_injury_and_roster_delta',
                    'get_market_movement'
                ].filter((t) => toolRegistry.has(t));
                hop1Plan = {
                    mode: 'two-hop-slate',
                    triageMode: params.triageMode || 'two-hop',
                    active_event_ids: activeHeaders.map((h) => h.eventId),
                    slate_games_count: activeHeaders.length,
                    priced_games_count: activeHeaders.filter((h) => (h.options || []).length > 0).length,
                    r_id_count: activeHeaders.reduce(
                        (acc, h) => acc + (h.options || []).filter((o) => Boolean(o.id)).length,
                        0
                    ),
                    selected_tools: selectedTools,
                    reasoning: 'Two-hop compact slate triage preserving R# pricing rows across activeEventIds with unified 3-tool Hop 1 dossier prefetch.'
                };
                params.hop1Plan = hop1Plan;
                params.onStage?.({
                    stage: 'hop1_plan',
                    plan: hop1Plan,
                    selected_tools: selectedTools
                });

                if (!curatedDossier && activeHeaders.length > 0 && selectedTools.length > 0) {
                    unifiedSlateDossier = await fetchTwoHopSlateDossier(
                        activeHeaders,
                        toolRegistry,
                        globalGameQueryCache,
                        context,
                        { env }
                    );
                    curatedDossier = toSerializableCuratedDossier(unifiedSlateDossier, []);
                    params.curatedDossier = curatedDossier;
                    params.onStage?.({
                        stage: 'hop1_exec',
                        sections: curatedDossier.sections,
                        durationMs: curatedDossier.totalDurationMs
                    });
                    params.onStage?.({
                        stage: 'curated_dossier',
                        dossier: curatedDossier
                    });
                }
            }

            // Hop 2 Specialist Debate Start Event
            if (params.seedManifest || curatedDossier || isTwoHopSlateRun) {
                params.onStage?.({
                    stage: 'analyst_start',
                    analysts: analysts.map(a => a.role),
                    hasCuratedDossier: Boolean(curatedDossier || isTwoHopSlateRun)
                });
            }

            // Step 4: Run Cluster Pipeline
            const clusterResult = await runClusterPipeline({
                task,
                data,
                analysts,
                managerAgent,
                chunks: profilingResult.chunks,
                profile: profilingResult.profile,
                rawInput: profilingResult.rawInput,
                historicalContext,
                targetAppId,
                settings,
                activeVariant,
                context,
                toolRegistry,
                memoryCortex,
                params,
                optimizationEnabled,
                coordinationEnabled,
                bypassCache,
                unifiedDossier: unifiedSlateDossier
            });

            // PS1: only ZERO analyst outputs is fatal (surfaces as swarm_error / HTTP 500).
            // managerFailed = the final answer did NOT come from the manager (the only case that makes the run 'partial').
            let managerFailed = false;
            if (
                countAnalystOutputs(clusterResult.allAnalystReports) === 0 &&
                !(clusterResult.earlyExitTriggered && clusterResult.earlyFinalAnalysis)
            ) {
                const failedSeats = getDegraded(context).join(', ');
                const lastError = [...context.events].reverse().find(e => e.error)?.error;
                throw new Error(`All analysts failed; no analyst output to compile.${failedSeats ? ' Failed seats: ' + failedSeats : ''}${lastError ? ' Reason: ' + String(lastError).slice(0, 300) : ''}`);
            }

            let workflowOriginalPromptTokens = clusterResult.workflowOriginalPromptTokens;
            let workflowCompressedPromptTokens = clusterResult.workflowCompressedPromptTokens;
            let workflowPromptTokensSaved = clusterResult.workflowPromptTokensSaved;
            let workflowDeduplicatedCount = clusterResult.workflowDeduplicatedCount;
            let workflowConsensus: AnalystConsensusDigest | undefined;
            const stage2CriticVetoes: string[] = [];
            let stage2VetoedLegs: VetoedLegTarget[] = [];
            let stage2VetoedClaims: string[] = [];
            let stage2CriticAuditFailed = false;
            let stage2CriticApproved: boolean | undefined = undefined;
            const stageSeatScorecards: any[] = [];

            // R2-S3: blackboard = { brief, scorecards, degraded, citedRows } (scorecardMode only).
            const blackboard = scorecardMode
                ? buildBlackboard({
                    brief: task,
                    data: data || '',
                    analysts,
                    allAnalystReports: clusterResult.allAnalystReports,
                    degraded: getDegraded(context)
                })
                : undefined;

            if (clusterResult.earlyExitTriggered && clusterResult.earlyFinalAnalysis) {
                finalAnalysis = clusterResult.earlyFinalAnalysis;
            } else {
                // Step 4b: Cross-Analyst Consensus Synthesis
                const consensusSlateHeaders = parseGameHeaders(profilingResult.rawInput || task, (params as any)?.eventIds);
                workflowConsensus = extractAnalystConsensus(clusterResult.allAnalystReports, analysts, task, consensusSlateHeaders);
                if (workflowConsensus?.agreementLevel) {
                    recordRunDebugAgreement((context as any)?.id, workflowConsensus.agreementLevel);
                }
                if (workflowConsensus && workflowConsensus.totalAnalysts > 1) {
                    context.addEvent({
                        agentRole: 'Analyst Consensus Engine',
                        action: 'Cross-Analyst Consensus Synthesized',
                        modelName: 'Local/ConsensusPipeline',
                        prompt: `Synthesized consensus across ${workflowConsensus.totalAnalysts} analysts (Score: ${Math.round(workflowConsensus.consensusScore * 100)}%, Agreement: ${workflowConsensus.agreementLevel}, Confidence: ${workflowConsensus.confidenceScore})`,
                        output: workflowConsensus,
                        durationMs: 0
                    });
                }

                // Step 5: Synthesis Pipeline
                const flatReports = clusterResult.allAnalystReports.flatMap((reps, idx) => {
                    const analystRole = analysts[idx]?.role;
                    const analystId = (analysts[idx] as any)?.id;
                    return (reps || []).filter(Boolean).map((r: any) => {
                        if (r && typeof r === 'object') {
                            if (!r.role && analystRole) r.role = analystRole;
                            if (!r.seat && analystId) r.seat = analystId;
                        }
                        return r;
                    });
                });
                const allToolCallTrace: ToolCallTraceEntry[] = mergeToolCallTraceEntries([
                    ...(unifiedSlateDossier?.rawToolCallTrace ?? []),
                    ...flatReports.flatMap((r: any) => (Array.isArray(r?.toolCallTrace) ? r.toolCallTrace : []))
                ]);
                const allToolEvidenceItems = collectSuccessfulEvidenceItems({
                    prePassedItems: [
                        ...(unifiedSlateDossier?.toolEvidenceItems ?? []),
                        ...flatReports.flatMap((r: any) => (Array.isArray(r?.toolEvidenceItems) ? r.toolEvidenceItems : []))
                    ],
                    toolCallTrace: allToolCallTrace
                });
                if (!curatedDossier && (isTwoHopSlateRun || hop1Plan)) {
                    const dossierSections = allToolEvidenceItems.map((item) => ({
                        tool: item.tool,
                        event_id: item.eventId,
                        status: 'ok' as const,
                        summary: item.summary,
                        tokenCost: Math.ceil((item.summary?.length || 0) / 4)
                    }));
                    const sectionIndexByExact = new Map<string, number>();
                    const sectionIndexByPair = new Map<string, number>();
                    dossierSections.forEach((sec, idx) => {
                        const exactKey = `${sec.tool}|${sec.event_id}|${sec.summary || ''}`;
                        if (!sectionIndexByExact.has(exactKey)) sectionIndexByExact.set(exactKey, idx);
                        const pairKey = `${sec.tool}|${sec.event_id}`;
                        if (!sectionIndexByPair.has(pairKey)) sectionIndexByPair.set(pairKey, idx);
                    });
                    const compactToolCallTrace = allToolCallTrace.map((t: any) => {
                        const summaryStr = typeof t?.summary === 'string' ? t.summary : '';
                        const exactKey = `${t?.tool || ''}|${t?.eventId || ''}|${summaryStr}`;
                        const pairKey = `${t?.tool || ''}|${t?.eventId || ''}`;
                        const matchedIdx =
                            sectionIndexByExact.get(exactKey) ??
                            sectionIndexByPair.get(pairKey);
                        const sectionIndex = matchedIdx !== undefined ? matchedIdx : null;
                        const sectionCost =
                            typeof sectionIndex === 'number' ? dossierSections[sectionIndex].tokenCost : 0;
                        const tokenCost =
                            typeof t?.tokenCost === 'number' && Number.isFinite(t.tokenCost)
                                ? t.tokenCost
                                : summaryStr
                                    ? Math.ceil(summaryStr.length / 4)
                                    : sectionCost;
                        return {
                            tool: String(t?.tool || ''),
                            eventId: String(t?.eventId || ''),
                            status: t?.status || 'ok',
                            tokenCost,
                            sectionIndex,
                            ...(typeof t?.durationMs === 'number' ? { durationMs: t.durationMs } : {}),
                            ...(typeof t?.cached === 'boolean' ? { cached: t.cached } : {}),
                            ...(typeof t?.attempt === 'number' ? { attempt: t.attempt } : {}),
                        };
                    });
                    const totalSummaryChars = dossierSections.reduce((acc, s) => acc + (s.summary?.length || 0), 0);
                    curatedDossier = {
                        mode: 'two-hop-slate',
                        active_event_ids: hop1Plan?.active_event_ids || params.eventIds || [],
                        sections: dossierSections,
                        tool_call_trace: compactToolCallTrace,
                        seat_visibility: clusterResult.seatVisibility || [],
                        tokenEstimate: Math.ceil(totalSummaryChars / 4),
                        totalDurationMs: allToolCallTrace.reduce((acc, t: any) => acc + (Number(t?.durationMs) || 0), 0)
                    };
                    params.curatedDossier = curatedDossier;
                    params.onStage?.({
                        stage: 'curated_dossier',
                        dossier: curatedDossier
                    });
                } else if (curatedDossier) {
                    const existingSections = Array.isArray(curatedDossier.sections) ? [...curatedDossier.sections] : [];
                    const existingTraces = Array.isArray(curatedDossier.tool_call_trace) ? [...curatedDossier.tool_call_trace] : [];
                    const existingSectionByPair = new Map<string, number>();
                    existingSections.forEach((sec: any, idx: number) => {
                        existingSectionByPair.set(`${sec.tool}|${sec.event_id}`, idx);
                    });
                    const existingTracePairs = new Set<string>(
                        existingTraces.map((t: any) => `${t.tool}|${t.eventId}`)
                    );
                    for (const item of allToolEvidenceItems) {
                        const pair = `${item.tool}|${item.eventId}`;
                        if (!existingSectionByPair.has(pair)) {
                            const idx = existingSections.length;
                            existingSectionByPair.set(pair, idx);
                            existingSections.push({
                                tool: item.tool,
                                event_id: item.eventId,
                                status: 'ok',
                                summary: item.summary,
                                tokenCost: Math.ceil((item.summary?.length || 0) / 4)
                            });
                        }
                    }
                    for (const t of allToolCallTrace) {
                        const pair = `${t.tool}|${t.eventId}`;
                        if (!existingTracePairs.has(pair)) {
                            existingTracePairs.add(pair);
                            const matchedIdx = existingSectionByPair.get(pair) ?? null;
                            existingTraces.push({
                                tool: String(t.tool || ''),
                                eventId: String(t.eventId || ''),
                                status: t.status || 'ok',
                                tokenCost: typeof matchedIdx === 'number' ? existingSections[matchedIdx].tokenCost : 0,
                                sectionIndex: matchedIdx,
                                ...(typeof (t as any).durationMs === 'number' ? { durationMs: (t as any).durationMs } : {}),
                                ...(typeof (t as any).cached === 'boolean' ? { cached: (t as any).cached } : {})
                            });
                        }
                    }
                    curatedDossier = {
                        ...curatedDossier,
                        sections: existingSections,
                        tool_call_trace: existingTraces,
                        seat_visibility: clusterResult.seatVisibility || curatedDossier.seat_visibility || []
                    };
                    params.curatedDossier = curatedDossier;
                    params.onStage?.({
                        stage: 'curated_dossier',
                        dossier: curatedDossier
                    });
                }
                const baseVerifierEvidence = buildVerifierEvidence(
                    [{ toolEvidenceItems: allToolEvidenceItems }],
                    profilingResult.rawInput ?? data ?? task
                );
                const verifierEvidence = (() => {
                    if (!calibrationBlock) return baseVerifierEvidence;
                    const maxCap = 2400;
                    if (!baseVerifierEvidence) {
                        if (calibrationBlock.length <= maxCap) return calibrationBlock;
                        const label = '\n[calibration trimmed]';
                        return `${calibrationBlock.slice(0, Math.max(0, maxCap - label.length)).trimEnd()}${label}`;
                    }
                    const room = maxCap - baseVerifierEvidence.length - 2;
                    if (room <= 40) return baseVerifierEvidence;
                    if (calibrationBlock.length <= room) {
                        return `${baseVerifierEvidence}\n\n${calibrationBlock}`;
                    }
                    const label = '\n[calibration trimmed]';
                    const sliceLen = Math.max(0, room - label.length);
                    return `${baseVerifierEvidence}\n\n${calibrationBlock.slice(0, sliceLen).trimEnd()}${label}`;
                })();

                // Step 5 & 6: Extract Critic verdict/vetoes/scorecards before synthesis compilation
                const isCriticSeat = (r: any): boolean => {
                    const label = String(r?.seat || r?.role || '').toLowerCase();
                    return label === 'critic' || label === 'risk' || label === 'risk_critic' || label.includes('critic') || label.includes('risk');
                };
                const criticReports = flatReports.filter(isCriticSeat);
                const nonCriticReports = flatReports.filter(r => !isCriticSeat(r));
                let stage2UnauditedLegs: VetoedLegTarget[] = [];
                let stage2AuditNote: string | undefined;
                const stage1HadProposedPicks = nonCriticReports.some(r =>
                    (Array.isArray((r as any)?.picks) && (r as any).picks.length > 0) ||
                    Boolean((r as any)?.scorecard?.pick) ||
                    (Array.isArray((r as any)?.scorecards) && (r as any).scorecards.some((s: any) => s?.pick || (Array.isArray(s?.picks) && s.picks.length > 0)))
                );
                stage2CriticApproved = stage2CriticAuditFailed ? false : undefined;
                for (const cr of criticReports) {
                    const auditMeta = (cr as any)?.criticAudit;
                    if (auditMeta && auditMeta.criticSkippedAudit === true) {
                        stage2CriticAuditFailed = true;
                        stage2CriticApproved = false;
                        if (Array.isArray(auditMeta.unauditedLegs) && auditMeta.unauditedLegs.length > 0) {
                            stage2UnauditedLegs = mergeVetoedLegTargets(stage2UnauditedLegs, auditMeta.unauditedLegs);
                        }
                        if (typeof auditMeta.auditNote === 'string' && auditMeta.auditNote.trim()) {
                            stage2AuditNote = auditMeta.auditNote.trim();
                        }
                    }
                    const verdictStr = typeof (cr as any).verdict === 'string' ? (cr as any).verdict.trim() : '';
                    const explicitVetoVerdict = /^(?:veto|vetoed|reject|rejected|fail|failed)$/i.test(verdictStr);
                    const explicitApproveVerdict = /^(?:approve|approved|pass|passed|accept|accepted)$/i.test(verdictStr);
                    if (cr && (cr.pass === false || (cr as any).criticApproved === false || (explicitVetoVerdict && cr.pass !== true && (cr as any).criticApproved !== true))) {
                        stage2CriticApproved = false;
                    } else if (cr && stage2CriticApproved === undefined && (cr.pass === true || (cr as any).criticApproved === true || explicitApproveVerdict)) {
                        stage2CriticApproved = true;
                    }
                    if (cr && cr.pass === false) {
                        const dedupedParts = dedupeVetoMessages([
                            typeof cr.feedback === 'string' ? cr.feedback : '',
                            typeof cr.verdict === 'string' ? cr.verdict : '',
                            typeof cr.summary === 'string' ? cr.summary : '',
                            typeof cr.analysis === 'string' ? cr.analysis : ''
                        ]);
                        if (dedupedParts.length > 0) {
                            stage2CriticVetoes.push(...dedupedParts);
                        } else if (Array.isArray(cr.flags) && cr.flags.length > 0) {
                            stage2CriticVetoes.push(cr.flags.join(', '));
                        }
                        if (Array.isArray((cr as any).vetoedLegs)) {
                            stage2VetoedLegs = mergeVetoedLegTargets(stage2VetoedLegs, (cr as any).vetoedLegs);
                        }
                        if (Array.isArray((cr as any).vetoedClaims)) {
                            stage2VetoedClaims = mergeVetoedClaims(stage2VetoedClaims, (cr as any).vetoedClaims);
                        }
                    }
                }
                for (const r of flatReports as any[]) {
                    if (!r || typeof r !== 'object') continue;
                    const seatLabel = String(r.role || r.seat || '').trim() || (isCriticSeat(r) ? 'Risk Critic' : 'Analyst');
                    if (isCriticSeat(r)) {
                        const isVeto = r.pass === false || r.criticApproved === false || String(r.verdict || '').toLowerCase() === 'veto';
                        const rawCriticNote = typeof r.verdict === 'string' && r.verdict.trim()
                            ? r.verdict.trim()
                            : (typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : '');
                        const cleanCriticNote = rawCriticNote
                            ? (dedupeVetoMessages([rawCriticNote]).join('; ') || rawCriticNote)
                            : '';
                        stageSeatScorecards.push({
                            seat: /critic/i.test(seatLabel) ? seatLabel : 'Risk Critic',
                            verdict: isVeto ? 'veto' : 'approve',
                            criticApproved: !isVeto,
                            wageringPass: Boolean(r.wageringPass ?? isVeto),
                            ...(cleanCriticNote ? { notes: cleanCriticNote } : {})
                        });
                    } else {
                        const picksCount = Array.isArray(r.picks) ? r.picks.length : 0;
                        stageSeatScorecards.push({
                            seat: seatLabel,
                            verdict: picksCount > 0 ? 'propose' : 'pass',
                            picksCount,
                            ...(typeof r.summary === 'string' && r.summary.trim() ? { notes: r.summary.trim() } : {})
                        });
                    }
                }
                const paramCriticRes = (params as any)?.criticResult || (params as any)?.criticFeedback || (settings as any)?.criticResult;
                if (paramCriticRes) {
                    if (typeof paramCriticRes === 'string' && paramCriticRes.trim()) {
                        const dedupedParam = dedupeVetoMessages([paramCriticRes.trim()]);
                        stage2CriticVetoes.push(...(dedupedParam.length > 0 ? dedupedParam : [paramCriticRes.trim()]));
                    } else if (typeof paramCriticRes === 'object' && paramCriticRes.pass === false) {
                        const dedupedParts = dedupeVetoMessages([
                            typeof paramCriticRes.feedback === 'string' ? paramCriticRes.feedback : '',
                            typeof paramCriticRes.verdict === 'string' ? paramCriticRes.verdict : '',
                            typeof paramCriticRes.summary === 'string' ? paramCriticRes.summary : ''
                        ]);
                        if (dedupedParts.length > 0) stage2CriticVetoes.push(...dedupedParts);
                        if (Array.isArray(paramCriticRes.vetoedLegs)) {
                            stage2VetoedLegs = mergeVetoedLegTargets(stage2VetoedLegs, paramCriticRes.vetoedLegs);
                        }
                        if (Array.isArray(paramCriticRes.vetoedClaims)) {
                            stage2VetoedClaims = mergeVetoedClaims(stage2VetoedClaims, paramCriticRes.vetoedClaims);
                        }
                    }
                }

                const synthesisResult = blackboard ? emptySynthesisResult() : compileSynthesisPrompt({
                    task,
                    rawInput: profilingResult.rawInput,
                    analysts,
                    managerAgent,
                    allAnalystReports: clusterResult.allAnalystReports,
                    clusterDigests: clusterResult.clusterDigests,
                    historicalContext,
                    workflowConsensus,
                    settings,
                    activeVariant,
                    context,
                    params,
                    bypassCache,
                    verifierEvidence,
                    ...(allToolCallTrace.length > 0 ? { toolCallTrace: allToolCallTrace } : {}),
                    ...(stage2VetoedLegs.length > 0 ? { vetoedLegs: stage2VetoedLegs } : {})
                });

                workflowOriginalPromptTokens += synthesisResult.workflowOriginalPromptTokens;
                workflowCompressedPromptTokens += synthesisResult.workflowCompressedPromptTokens;
                workflowPromptTokensSaved += synthesisResult.workflowPromptTokensSaved;
                workflowDeduplicatedCount += synthesisResult.workflowDeduplicatedCount;

                const allPlaceholderOrDataRequest = flatReports.length > 0 && nonCriticReports.every(r =>
                    ((r as any)._placeholder === true && !(Array.isArray((r as any).picks) && (r as any).picks.length > 0))
                    || isDataRequest(r)
                );

                const coveredEventIds = new Set<string>();
                for (const r of flatReports) {
                    if (Array.isArray((r as any).coveredEventIds)) {
                        for (const id of (r as any).coveredEventIds) coveredEventIds.add(id);
                    }
                }
                const coveredEventIdsList = Array.from(coveredEventIds);
                const joinedToolEvidence = flatReports
                    .map((r: any) => {
                        const ev = typeof r?.toolEvidence === 'string' ? r.toolEvidence.trim() : '';
                        if (!ev) return '';
                        const label = r?.role || r?.seat || 'Analyst';
                        return `[${label}]\n${ev}`;
                    })
                    .filter(Boolean)
                    .join('\n\n');
                const hop1CuratedDossierEvidence = (
                    (curatedDossier && Array.isArray((curatedDossier as any).sections) ? (curatedDossier as any).sections : null) ??
                    (unifiedSlateDossier && Array.isArray(unifiedSlateDossier.sections) ? unifiedSlateDossier.sections : [])
                )
                    .map((sec: any) => {
                        const sum = typeof sec?.summary === 'string' ? sec.summary.trim() : '';
                        if (!sum) return '';
                        const evId = typeof sec?.event_id === 'string' ? sec.event_id.trim() : '';
                        return evId && !sum.includes(evId) ? `EVENT ${evId}\n${sum}` : sum;
                    })
                    .filter(Boolean)
                    .join('\n\n');
                const baseJoinedEvidence = [hop1CuratedDossierEvidence, joinedToolEvidence, calibrationBlock].filter(Boolean).join('\n\n');
                const verifierToolResults = [hop1CuratedDossierEvidence, verifierEvidence || baseJoinedEvidence]
                    .filter((part, idx, arr) => Boolean(part) && (idx === 0 || !arr[0].includes(part)))
                    .join('\n\n');

                if (allPlaceholderOrDataRequest) {
                    const criticParts: string[] = [];
                    for (const cr of criticReports) {
                        const s = typeof cr?.summary === 'string' ? cr.summary.trim() : '';
                        const insList = Array.isArray(cr?.insights)
                            ? cr.insights.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
                            : [];
                        const uniqueIns = insList.filter((line: string) => !s || !s.includes(line));
                        const combined = [s, ...uniqueIns].filter(Boolean).join(' ').trim();
                        if (combined) criticParts.push(combined);
                    }
                    const criticSummary = criticParts.join('\n').trim();
                    const firstCritic: any = criticReports[0];
                    const criticVerdict = firstCritic?.scorecard ?? firstCritic?.verdict ?? (firstCritic?.recommendation ? { recommendation: firstCritic.recommendation, summary: firstCritic.summary } : undefined);
                    const placeholderApproved = typeof firstCritic?.criticApproved === 'boolean'
                        ? firstCritic.criticApproved
                        : (typeof firstCritic?.pass === 'boolean' ? firstCritic.pass : false);
                    finalAnalysis = {
                        ui_title: 'Insufficient data',
                        picks: [],
                        reason: criticSummary || 'all seats requested data without actionable insights',
                        criticApproved: placeholderApproved,
                        wageringPass: true,
                        ...(criticSummary ? { summary: criticSummary, analysis: criticSummary } : {}),
                        ...(criticVerdict !== undefined ? { critic: criticVerdict } : {})
                    };
                } else {
                    try {
                        const marketToolRecords = flatReports
                            .flatMap((r: any) =>
                                Array.isArray(r?.marketToolRecords) && r.marketToolRecords.length > 0
                                    ? r.marketToolRecords
                                    : (Array.isArray(r?.toolEvidenceItems) ? r.toolEvidenceItems : [])
                            )
                            .filter((item: any) => item && item.tool === 'get_market_movement' && item.eventId);

                        if (blackboard) {
                            // R2-S4/S5: critic + manager see the brief, the scorecards and citedRows only (never the full data).
                            // The critic runs when deep analysis is on (same gate as the verification critic).
                            finalAnalysis = await executeScorecardSynthesis({
                                blackboard,
                                managerAgent,
                                analysts,
                                dedicatedCriticAgent,
                                runCritic: deepAnalysisRequested,
                                context,
                                activeVariant,
                                bypassCache,
                                settings,
                                onStage: params.onStage
                            });
                        } else if (deepAnalysisRequested && (analysts.length > 0 || dedicatedCriticAgent)) {
                            const activeIdsForVerification = hop1Plan?.active_event_ids ?? params.eventIds;
                            const verificationResult = await runDeepAnalysisVerification({
                                task,
                                rawInput: profilingResult.rawInput,
                                effectiveDynamicPrompt: synthesisResult.effectiveDynamicPrompt,
                                effectiveCompiledReports: synthesisResult.effectiveCompiledReports,
                                effectiveHistoricalContext: synthesisResult.effectiveHistoricalContext,
                                managerAgent,
                                analysts,
                                dedicatedCriticAgent,
                                context,
                                settings,
                                coveredEventIds: coveredEventIdsList,
                                toolRegistry,
                                queryCache: globalGameQueryCache,
                                ...(Array.isArray(activeIdsForVerification) ? { activeEventIds: activeIdsForVerification } : {}),
                                ...(marketToolRecords.length > 0 ? { marketToolRecords } : {}),
                                ...(allToolCallTrace.length > 0 ? { toolCallTrace: allToolCallTrace } : {}),
                                ...(stage2CriticVetoes.length > 0 ? { criticVetoes: stage2CriticVetoes } : {}),
                                ...(stage2VetoedLegs.length > 0 ? { vetoedLegs: stage2VetoedLegs } : {}),
                                ...(stage2VetoedClaims.length > 0 ? { vetoedClaims: stage2VetoedClaims } : {}),
                                ...(stageSeatScorecards.length > 0 ? { seatScorecards: stageSeatScorecards } : {}),
                                ...(stage1HadProposedPicks ? { hadProposedPicks: true } : {}),
                                ...(typeof stage2CriticApproved === 'boolean' ? { criticVerdictApproved: stage2CriticApproved } : {}),
                                ...(verifierToolResults ? { toolResults: verifierToolResults } : {}),
                                ...(allToolEvidenceItems.length > 0 ? { toolEvidenceItems: allToolEvidenceItems } : {}),
                                ...(synthesisResult.appComputedCounts ? { appComputedCounts: synthesisResult.appComputedCounts } : {})
                            });
                            finalAnalysis = verificationResult.finalAnalysis;
                            workflowLifecycleResult = verificationResult.lifecycleResult;
                            if (Array.isArray(workflowLifecycleResult?.verifiedEventIds)) {
                                for (const evId of workflowLifecycleResult.verifiedEventIds) {
                                    if (evId && !coveredEventIdsList.includes(evId)) {
                                        coveredEventIdsList.push(evId);
                                    }
                                }
                            }
                        } else {
                            const availableTools = toolRegistry
                                ? ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement'].filter(t => toolRegistry.has(t))
                                : undefined;
                            finalAnalysis = await executeManagerSynthesis(
                                managerAgent,
                                synthesisResult.effectiveDynamicPrompt,
                                context,
                                activeVariant,
                                bypassCache,
                                settings,
                                coveredEventIdsList,
                                {
                                    toolResults: verifierToolResults,
                                    ...(marketToolRecords.length > 0 ? { marketToolRecords } : {}),
                                    criticVetoes: stage2CriticVetoes,
                                    ...(stage2VetoedLegs.length > 0 ? { vetoedLegs: stage2VetoedLegs } : {}),
                                    ...(stage2VetoedClaims.length > 0 ? { vetoedClaims: stage2VetoedClaims } : {}),
                                    ...(stageSeatScorecards.length > 0 ? { seatScorecards: stageSeatScorecards } : {}),
                                    ...(stage2CriticAuditFailed ? { criticAuditFailed: true } : {}),
                                    ...(stage2UnauditedLegs.length > 0 ? { unauditedLegs: stage2UnauditedLegs } : {}),
                                    ...(stage1HadProposedPicks ? { hadProposedPicks: true } : {}),
                                    ...(typeof stage2CriticApproved === 'boolean' ? { criticVerdictApproved: stage2CriticApproved } : {}),
                                    ...(stage2AuditNote ? { auditNote: stage2AuditNote } : {}),
                                    rawBoard: profilingResult.rawInput,
                                    ...(allToolCallTrace.length > 0 ? { toolCallTrace: allToolCallTrace } : {}),
                                    ...(availableTools && availableTools.length > 0 ? { availableTools } : {}),
                                    ...(Array.isArray(hop1Plan?.active_event_ids ?? params.eventIds)
                                        ? { activeEventIds: hop1Plan?.active_event_ids ?? params.eventIds }
                                        : {})
                                }
                            );
                        }

                        if (coveredEventIdsList.length > 0 && finalAnalysis && Array.isArray(finalAnalysis.picks)) {
                            const slateHeaders = parseGameHeaders(data || profilingResult.rawInput);
                            const originalCount = finalAnalysis.picks.length;
                            finalAnalysis.picks = filterPicksByCoverage(finalAnalysis.picks, coveredEventIdsList, slateHeaders);
                            if (finalAnalysis.picks.length === 0 && originalCount > 0) {
                                finalAnalysis.ui_title = 'Insufficient data';
                                finalAnalysis.reason = 'no picks with specialist coverage';
                                finalAnalysis.criticApproved = false;
                                finalAnalysis.wageringPass = true;
                            }
                        }
                    } catch (managerErr: any) {
                        // PS1: the whole manager chain failed. Return the best analyst output as a partial answer.
                        // Applies to chat AND morning runs (Architect decision 2026-10-16).
                        const best = pickBestAnalystOutput(clusterResult.allAnalystReports, analysts);
                        if (!best) {
                            throw managerErr;
                        }
                        managerFailed = true;
                        recordDegraded(context, managerAgent.id || 'manager');
                        const isBettingPartial =
                            (settings as any)?.responseSchema === 'morning_judge' ||
                            (params as any)?.originApp === 'duelodds' ||
                            (params as any)?.callerAppId === 'duelodds' ||
                            (params as any)?.appId === 'duelodds' ||
                            (params as any)?.isBettingRun === true ||
                            stage1HadProposedPicks ||
                            criticReports.length > 0;
                        const criticRan = criticReports.length > 0 || Boolean(paramCriticRes);
                        const criticExplicitlyPassed =
                            criticReports.some((cr: any) => cr && (cr.pass === true || cr.criticApproved === true)) ||
                            (paramCriticRes && typeof paramCriticRes === 'object' && (paramCriticRes.pass === true || paramCriticRes.criticApproved === true));
                        const criticExplicitlyFailed =
                            stage2CriticAuditFailed ||
                            criticReports.some((cr: any) => cr && (cr.pass === false || cr.criticApproved === false)) ||
                            (paramCriticRes && typeof paramCriticRes === 'object' && paramCriticRes.pass === false);
                        const criticPassed = criticRan && criticExplicitlyPassed && !criticExplicitlyFailed;
                        finalAnalysis = buildPartialFinalAnalysis(
                            best,
                            getDegraded(context),
                            isBettingPartial
                                ? {
                                    isBettingRun: true,
                                    criticRan,
                                    criticPassed,
                                    criticApproved: criticPassed,
                                    vetoedLegs: stage2VetoedLegs,
                                    vetoTexts: stage2CriticVetoes,
                                    seatScorecards: stageSeatScorecards,
                                    allAnalystReports: clusterResult.allAnalystReports
                                }
                                : undefined
                        );
                        context.addEvent({
                            agentRole: 'Partial Result Fallback',
                            action: 'Manager Chain Exhausted',
                            modelName: 'Local/PartialResult',
                            prompt: `Manager chain failed; returning best analyst output from ${best.role} (${best.provider}) as a partial result.`,
                            error: managerErr?.message || String(managerErr),
                            output: { degraded: getDegraded(context) },
                            durationMs: 0
                        });
                    }
                }
            }

            // Step 7: Learning & Telemetry Pipeline
            const learningResult = await runLearningPipeline({
                task,
                data,
                finalAnalysis,
                context,
                params,
                settings,
                activeVariant,
                activeExperiment,
                workflowStartTime,
                complexity,
                workflowLifecycleResult,
                analysts,
                managerAgent,
                memoryCortex,
                targetAppId,
                cacheKey,
                cacheQuery,
                agentConfigVersion,
                tieredCacheEnabled,
                profilingEnabled: settings?.profilingSettings?.enabled !== false,
                coordinationEnabled,
                workflowTotalTokens: profilingResult.totalTokens,
                workflowPromptTokensSaved,
                workflowOriginalPromptTokens,
                workflowCompressedPromptTokens,
                workflowDeduplicatedCount,
                workflowSchedulingResult: clusterResult.workflowSchedulingResult,
                workflowHierarchyMetrics: clusterResult.workflowHierarchyMetrics,
                latestClusterDigests: clusterResult.latestClusterDigests,
                workflowDecompositionPlan: profilingResult.workflowDecompositionPlan,
                parametersUsed: bestPolicy
            });

            const degraded = getDegraded(context);
            const status: SwarmRunStatus = managerFailed ? 'partial' : 'complete';

            const toolsCalled = new Set<string>();
            if (params.preloadedGameContext) {
                toolsCalled.add('read_game_context_v1');
            }
            if (curatedDossier?.sections) {
                for (const sec of curatedDossier.sections) {
                    if (sec.tool) toolsCalled.add(sec.tool);
                }
            }
            for (const ev of context.events) {
                const anyEv = ev as any;
                if (anyEv.tool) toolsCalled.add(anyEv.tool);
                if (anyEv.output?.tool) toolsCalled.add(anyEv.output.tool);
            }
            const toolsCalledList = Array.from(toolsCalled);
            if (!curatedDossier && (isTwoHopSlateRun || hop1Plan)) {
                curatedDossier = {
                    mode: 'two-hop-slate',
                    active_event_ids: hop1Plan?.active_event_ids || params.eventIds || [],
                    sections: [],
                    tool_call_trace: [],
                    seat_visibility: clusterResult.seatVisibility || [],
                    markdown: '',
                    tokenEstimate: 0,
                    totalDurationMs: 0
                };
                params.curatedDossier = curatedDossier;
                params.onStage?.({
                    stage: 'curated_dossier',
                    dossier: curatedDossier
                });
            }
            const resolvedFinalSeatVisibility = Array.isArray(curatedDossier?.seat_visibility) && curatedDossier.seat_visibility.length > 0
                ? curatedDossier.seat_visibility
                : (Array.isArray(finalAnalysis?.curatedDossier?.seat_visibility)
                    ? finalAnalysis.curatedDossier.seat_visibility
                    : []);

            const hop1ToolsMs = typeof curatedDossier?.totalDurationMs === 'number' && Number.isFinite(curatedDossier.totalDurationMs)
                ? Math.max(0, Math.round(curatedDossier.totalDurationMs))
                : undefined;
            const diagnostics = buildCompactRunDiagnostics({
                events: context.events,
                totalMs: Math.max(0, Date.now() - workflowStartTime),
                ...(hop1ToolsMs !== undefined ? { hop1ToolsMs } : {})
            });

            if (finalAnalysis && typeof finalAnalysis === 'object') {
                finalAnalysis.tools_called = [...toolsCalledList];
                finalAnalysis.diagnostics = diagnostics;
                if (hop1Plan && finalAnalysis.hop1Plan === undefined) {
                    finalAnalysis.hop1Plan = hop1Plan;
                }
                if (curatedDossier) {
                    finalAnalysis.curatedDossier = finalAnalysis.curatedDossier && typeof finalAnalysis.curatedDossier === 'object'
                        ? {
                            ...curatedDossier,
                            ...finalAnalysis.curatedDossier,
                            seat_visibility: resolvedFinalSeatVisibility.length > 0
                                ? resolvedFinalSeatVisibility
                                : (finalAnalysis.curatedDossier.seat_visibility || [])
                        }
                        : curatedDossier;
                }
                if (resolvedFinalSeatVisibility.length > 0 && !Array.isArray(finalAnalysis.seat_visibility)) {
                    finalAnalysis.seat_visibility = resolvedFinalSeatVisibility;
                }
                const isMorningPayload =
                    (settings as any)?.responseSchema === 'morning_judge' ||
                    'winProbHome' in finalAnalysis ||
                    'win_prob_home' in finalAnalysis;
                if (!isMorningPayload) {
                    const combinedDetVetoes = [
                        ...stage2CriticVetoes,
                        ...stage2VetoedLegs,
                        ...stage2VetoedClaims,
                        ...(Array.isArray(workflowLifecycleResult?.accumulatedVetoes) ? workflowLifecycleResult.accumulatedVetoes : []),
                        ...(Array.isArray(workflowLifecycleResult?.vetoedLegs) ? workflowLifecycleResult.vetoedLegs : []),
                        ...(Array.isArray(workflowLifecycleResult?.vetoedClaims) ? workflowLifecycleResult.vetoedClaims : [])
                    ];
                    const vetoTextsForReconcile = dedupeVetoMessages([
                        ...stage2CriticVetoes,
                        ...(Array.isArray(workflowLifecycleResult?.accumulatedVetoes) ? workflowLifecycleResult.accumulatedVetoes : [])
                    ]);
                    const vetoLegsForReconcile = mergeVetoedLegTargets(stage2VetoedLegs, workflowLifecycleResult?.vetoedLegs);
                    const finalPicksArr = Array.isArray(finalAnalysis.picks) ? finalAnalysis.picks : [];
                    const boardTextForReconcile = typeof data === 'string' && data.trim() ? data : task;
                    const headersForReconcile = parseGameHeaders(boardTextForReconcile, params.eventIds);
                    const rowMapForReconcile = extractRowOptions([boardTextForReconcile], headersForReconcile);
                    const targetedLegsForReconcile = mergeVetoedLegTargets(
                        vetoLegsForReconcile,
                        extractVetoedLegTargets(vetoTextsForReconcile, headersForReconcile, rowMapForReconcile)
                    );
                    const survivingOverlapVeto =
                        targetedLegsForReconcile.length > 0 &&
                        finalPicksArr.some((pk: any) =>
                            targetedLegsForReconcile.some((vl) => pickMatchesVetoedTarget(pk, vl, rowMapForReconcile))
                        );
                    const repairedCleanPass =
                        !stage2CriticAuditFailed &&
                        workflowLifecycleResult?.criticAuditFailed !== true &&
                        workflowLifecycleResult?.success === true &&
                        finalAnalysis.verified === true &&
                        finalPicksArr.length > 0 &&
                        !survivingOverlapVeto &&
                        (
                            combinedDetVetoes.length === 0 ||
                            (stage2CriticApproved !== false && vetoLegsForReconcile.length === 0) ||
                            targetedLegsForReconcile.length > 0
                        );
                    const preserveCleanSubsetPicks =
                        !stage2CriticAuditFailed &&
                        workflowLifecycleResult?.criticAuditFailed !== true &&
                        Boolean(workflowLifecycleResult) &&
                        workflowLifecycleResult?.success === false &&
                        finalPicksArr.length > 0 &&
                        !survivingOverlapVeto;
                    reconcileFinalVerdictAndPicks(finalAnalysis, {
                        criticPass1Approved: stage2CriticApproved,
                        criticVerdictApproved: stage2CriticApproved,
                        deterministicVetoes: repairedCleanPass ? [] : combinedDetVetoes,
                        hadDeterministicVetoes:
                            stage2CriticAuditFailed ||
                            workflowLifecycleResult?.criticAuditFailed === true ||
                            workflowLifecycleResult?.success === false ||
                            finalAnalysis.verified === false ||
                            (!repairedCleanPass && combinedDetVetoes.length > 0),
                        criticAuditFailed: stage2CriticAuditFailed || workflowLifecycleResult?.criticAuditFailed === true,
                        verificationSuccess: workflowLifecycleResult ? workflowLifecycleResult.success !== false : undefined,
                        verificationApproved: repairedCleanPass,
                        preserveCleanSubsetPicks,
                        vetoTexts: vetoTextsForReconcile,
                        vetoedLegs: vetoLegsForReconcile,
                        seatScorecards: stageSeatScorecards
                    });
                }
            }

            return {
                workflowId: (context as any).id,
                status,
                partial: managerFailed,
                degraded,
                tools_called: toolsCalledList,
                diagnostics,
                ...(hop1Plan ? { hop1Plan } : {}),
                ...(curatedDossier ? { curatedDossier } : {}),
                ...(resolvedFinalSeatVisibility.length > 0 ? { seat_visibility: resolvedFinalSeatVisibility } : {}),
                events: context.events,
                finalAnalysis,
                metrics: learningResult.metrics,
                experiment: activeExperiment && activeVariant ? {
                    experimentId: activeExperiment.id,
                    variantId: activeVariant.variantId,
                    variantName: activeVariant.name,
                    decision: learningResult.workflowExpDecision
                } : undefined,
                compression: workflowOriginalPromptTokens > 0 ? {
                    originalTokens: workflowOriginalPromptTokens,
                    compressedTokens: workflowCompressedPromptTokens,
                    tokensSaved: workflowPromptTokensSaved,
                    reductionRatio: Math.round((workflowPromptTokensSaved / workflowOriginalPromptTokens) * 1000) / 1000,
                    deduplicatedSegmentsCount: workflowDeduplicatedCount
                } : undefined,
                scheduling: clusterResult.workflowSchedulingResult ? {
                    totalTasks: clusterResult.workflowSchedulingResult.totalTasks,
                    successfulTasks: clusterResult.workflowSchedulingResult.successfulTasks,
                    failedTasks: clusterResult.workflowSchedulingResult.failedTasks,
                    totalQueueWaitMs: clusterResult.workflowSchedulingResult.totalQueueWaitMs,
                    averageQueueWaitMs: clusterResult.workflowSchedulingResult.averageQueueWaitMs,
                    totalExecutionMs: clusterResult.workflowSchedulingResult.totalExecutionMs,
                    totalBackpressureDelayMs: clusterResult.workflowSchedulingResult.totalBackpressureDelayMs,
                    stolenTaskCount: clusterResult.workflowSchedulingResult.stolenTaskCount
                } : undefined,
                hierarchy: clusterResult.workflowHierarchyMetrics ? {
                    treeDepth: clusterResult.workflowHierarchyMetrics.treeDepth,
                    totalNodes: clusterResult.workflowHierarchyMetrics.totalNodes,
                    tierCounts: clusterResult.workflowHierarchyMetrics.tierCounts,
                    delegatedTasksCount: clusterResult.workflowHierarchyMetrics.delegationsCount,
                    escalatedTasksCount: clusterResult.workflowHierarchyMetrics.escalationsCount
                } : undefined,
                tieredCache: tieredCacheEnabled ? {
                    hit: false,
                    latencyMs: 0,
                    snapshotId: learningResult.workflowSnapshotId,
                    metrics: globalTieredCache.getMetrics()
                } : undefined,
                unifiedBaselines: undefined,
                feedback: learningResult.workflowFeedbackReport,
                coordination: coordinationEnabled && globalKnowledgeGraph.getVersion() > 0 ? {
                    knowledgeGraphVersion: globalKnowledgeGraph.getVersion(),
                    totalNodes: globalKnowledgeGraph.getStats().totalNodes,
                    totalEdges: globalKnowledgeGraph.getStats().totalEdges,
                    hypothesesCount: globalHypothesisLayer.getHypotheses().length,
                    validatedHypothesesCount: globalHypothesisLayer.getHypotheses('validated').length,
                    taskDecomposition: profilingResult.workflowDecompositionPlan,
                    agentLearningRates: Object.fromEntries(
                        globalLearningRateManager.getAllStates().map(s => [s.agentId, s.learningRate])
                    ),
                    shapedReward: learningResult.workflowShapedReward
                } : undefined,
                optimization: optimizationEnabled ? {
                    earlyExit: clusterResult.earlyExitTriggered,
                    tier: clusterResult.earlyExitTriggered ? 'tier1_approx' : 'tier2_refined',
                    latencySavedMs: clusterResult.earlyExitLatencySavedMs,
                    partialResultEmitted: Boolean(clusterResult.earlyPartialPrediction),
                    subcomputationsCached: 0,
                    tokenWeightRatio: profilingResult.tokenWeightReport?.metadataWeightRatio ?? 0,
                    tokensSaved: profilingResult.preFilterResult?.tokensSaved ?? 0
                } : undefined,
                consensus: workflowConsensus,
                // R2-S3: /analyze and swarm_complete return the blackboard alongside finalAnalysis (degraded refreshed).
                ...(blackboard ? { blackboard: { ...blackboard, degraded } } : {})
            };
        } catch (swarmErr: any) {
            const workflowDurationMs = Date.now() - workflowStartTime;
            if (activeExperiment && activeVariant && settings?.experimentSettings?.autoRecordMetrics !== false) {
                activeExperiment.recordOutcome(activeVariant.variantId, {
                    durationMs: workflowDurationMs,
                    error: true,
                    errorMessage: swarmErr?.message || String(swarmErr),
                    rlaifScore: 0.10
                });
            }
            globalMetricsCollector.recordTaskExecution({
                success: false,
                durationMs: workflowDurationMs,
                agentRole: 'System Orchestrator',
                error: swarmErr?.message || String(swarmErr)
            });
            console.error("Swarm execution failed:", swarmErr);
            throw swarmErr;
        }
    } finally {
        if (isRunDebugPersistEnabled()) {
            void persistRunDebugRecord((context as any).id);
        }
        if (unsubscribe) {
            unsubscribe();
        }
    }
}
