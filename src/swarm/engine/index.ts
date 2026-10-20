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
import { executeFastPath } from "./fastPath.ts";
import { checkSubComputationCache, resolveEarlyCacheHit } from "./cachingPipeline.ts";
import { runDataProfilingPipeline } from "./profilingPipeline.ts";
import { extractAnalystConsensus, renderPromptConsensusBlock, type AnalystConsensusDigest } from "./consensusPipeline.ts";
export { extractAnalystConsensus, renderPromptConsensusBlock, type AnalystConsensusDigest };
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
import { runDeepAnalysisVerification } from "./verificationPipeline.ts";
import { runLearningPipeline } from "./learningPipeline.ts";
import { isScorecardMode } from "./scorecard.ts";
import { buildBlackboard } from "./blackboard.ts";
import {
  executeScorecardSynthesis,
  emptySynthesisResult,
} from "./scorecardManager.ts";

import { SwarmContext } from '../context.ts';
import { globalMetricsCollector } from '../profiler.ts';
import { ModelRouter, type TaskComplexity } from '../router.ts';
import { PayloadCache } from '../cache.ts';
import { globalKnowledgeGraph } from '../knowledgeGraph.ts';
import { globalLearningRateManager, globalHypothesisLayer } from '../coordination.ts';
import { globalTieredCache } from '../tieredCache.ts';
import { globalFeedbackEngine } from '../feedback.ts';

export async function executeSwarmWorkflow(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
    const workflowStartTime = Date.now();
    const { task, data, settings, defaultAi, enableDeepAnalysis, complexityOverride, onEvent } = params;
    const context = params.context || new SwarmContext();
    if (!(context as any).id) {
        (context as any).id = `wf-${Date.now()}`;
    }
    const unsubscribe = onEvent ? context.subscribe(onEvent) : undefined;
    // R2: opt-in scorecard + blackboard flow (request or settings); never for morning_judge.
    const scorecardMode = isScorecardMode(params, settings);

    try {
        const optSettings = settings?.optimizationSettings;
        const optimizationEnabled = optSettings?.enabled !== false;

        // 0a. Fast sub-computation cache check
        if (optimizationEnabled && optSettings?.enableSubComputationCache !== false && !params.forceFullSwarm && !settings?.forceFullSwarm && !scorecardMode) {
            const subResult = checkSubComputationCache({
                task,
                context,
                onPartialResult: params.onPartialResult,
                onStage: params.onStage,
                getMetrics: () => globalMetricsCollector.getBaselineReport()
            });
            if (subResult) return subResult;
        }

        const targetAppId = settings?.appId || 'perfect-swarm';
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

        // 0. Infer Task Complexity via ModelRouter
        // R2: scorecard mode always runs the full swarm (the fast path has no scorecards or blackboard).
        const forceFullSwarm = scorecardMode || (params.forceFullSwarm ?? settings?.forceFullSwarm ?? settings?.disableFastPath ?? false);
        const bypassCache = params.bypassCache ?? false;
        const complexity: TaskComplexity = complexityOverride || ModelRouter.inferComplexity(task, (data || '').length, 1, forceFullSwarm);
        const deepAnalysisRequested = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? (complexity === 'complex');

        const agentConfigVersion = PayloadCache.hashString(
            (settings?.agents || []).map((a: any) => `${a.id || a.role}:${a.provider}/${a.model || ''}`).join('|')
            + (scorecardMode ? '|scorecardMode' : '') // R2: never share cache entries with non-scorecard runs
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
            if (fastResult) return fastResult;
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

            // Step 3: Targeted Memory Grounding
            const { historicalContext } = await resolveMemoryGrounding({
                memoryCortex,
                task,
                targetAppId,
                includeShared,
                bypassCache,
                qdrantUrl,
                toolRegistry,
                context,
                domain: (params as any).domain || settings?.domain
            } as any);

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
                bypassCache
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
                workflowConsensus = extractAnalystConsensus(clusterResult.allAnalystReports, analysts, task);
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
                    bypassCache
                });

                workflowOriginalPromptTokens += synthesisResult.workflowOriginalPromptTokens;
                workflowCompressedPromptTokens += synthesisResult.workflowCompressedPromptTokens;
                workflowPromptTokensSaved += synthesisResult.workflowPromptTokensSaved;
                workflowDeduplicatedCount += synthesisResult.workflowDeduplicatedCount;

                // Step 5 & 6: Verification vs Standard Synthesis Execution
                try {
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
                            settings
                        });
                        finalAnalysis = verificationResult.finalAnalysis;
                        workflowLifecycleResult = verificationResult.lifecycleResult;
                    } else {
                        finalAnalysis = await executeManagerSynthesis(
                            managerAgent,
                            synthesisResult.effectiveDynamicPrompt,
                            context,
                            activeVariant,
                            bypassCache,
                            settings
                        );
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
                    finalAnalysis = buildPartialFinalAnalysis(best, getDegraded(context));
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

            return {
                workflowId: (context as any).id,
                status,
                partial: managerFailed,
                degraded,
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
        if (unsubscribe) {
            unsubscribe();
        }
    }
}
