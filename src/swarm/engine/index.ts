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
import { runDeepAnalysisVerification } from "./verificationPipeline.ts";
import { runLearningPipeline } from "./learningPipeline.ts";

import { SwarmContext } from '../context.ts';
import { globalMetricsCollector } from '../profiler.ts';
import { ModelRouter, type TaskComplexity } from '../router.ts';
import { PayloadCache } from '../cache.ts';
import { globalKnowledgeGraph } from '../knowledgeGraph.ts';
import { globalLearningRateManager, globalHypothesisLayer } from '../coordination.ts';
import { globalTieredCache } from '../tieredCache.ts';

export async function executeSwarmWorkflow(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
    const workflowStartTime = Date.now();
    const { task, data, settings, defaultAi, enableDeepAnalysis, complexityOverride, onEvent } = params;
    const context = params.context || new SwarmContext();
    if (!(context as any).id) {
        (context as any).id = `wf-${Date.now()}`;
    }
    const unsubscribe = onEvent ? context.subscribe(onEvent) : undefined;

    try {
        const optSettings = settings?.optimizationSettings;
        const optimizationEnabled = optSettings?.enabled !== false;

        // 0a. Fast sub-computation cache check
        if (optimizationEnabled && optSettings?.enableSubComputationCache !== false && !params.forceFullSwarm && !settings?.forceFullSwarm) {
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
        const { memoryCortex, toolRegistry } = bindCortexAndTools(params, settings, defaultAi, targetAppId);

        // 0. Infer Task Complexity via ModelRouter
        const forceFullSwarm = params.forceFullSwarm ?? settings?.forceFullSwarm ?? settings?.disableFastPath ?? false;
        const bypassCache = params.bypassCache ?? false;
        const complexity: TaskComplexity = complexityOverride || ModelRouter.inferComplexity(task, (data || '').length, 1, forceFullSwarm);
        const deepAnalysisRequested = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? (complexity === 'complex');

        const agentConfigVersion = PayloadCache.hashString(
            (settings?.agents || []).map((a: any) => `${a.id || a.role}:${a.provider}/${a.model || ''}`).join('|')
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
                context
            });

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

            let workflowOriginalPromptTokens = clusterResult.workflowOriginalPromptTokens;
            let workflowCompressedPromptTokens = clusterResult.workflowCompressedPromptTokens;
            let workflowPromptTokensSaved = clusterResult.workflowPromptTokensSaved;
            let workflowDeduplicatedCount = clusterResult.workflowDeduplicatedCount;
            let workflowConsensus: AnalystConsensusDigest | undefined;

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
                const synthesisResult = compileSynthesisPrompt({
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
                if (deepAnalysisRequested && (analysts.length > 0 || dedicatedCriticAgent)) {
                    const verificationResult = await runDeepAnalysisVerification({
                        task,
                        rawInput: profilingResult.rawInput,
                        effectiveDynamicPrompt: synthesisResult.effectiveDynamicPrompt,
                        effectiveCompiledReports: synthesisResult.effectiveCompiledReports,
                        effectiveHistoricalContext: synthesisResult.effectiveHistoricalContext,
                        managerAgent,
                        analysts,
                        dedicatedCriticAgent,
                        context
                    });
                    finalAnalysis = verificationResult.finalAnalysis;
                    workflowLifecycleResult = verificationResult.lifecycleResult;
                } else {
                    finalAnalysis = await executeManagerSynthesis(
                        managerAgent,
                        synthesisResult.effectiveDynamicPrompt,
                        context,
                        activeVariant,
                        bypassCache
                    );
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
                workflowDecompositionPlan: profilingResult.workflowDecompositionPlan
            });

            return {
                workflowId: (context as any).id,
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
                consensus: workflowConsensus
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
