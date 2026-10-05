import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import type { SwarmWorkflowParams, SwarmFeedbackReport } from './types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import type { AgentVariantConfig, AgentExperiment, ExecutionMetrics, ExperimentDecision } from '../experiment.ts';
import { type MemoryCortex, normalizeDomain, extractEntityIds } from '../memory.ts';
import type { TaskComplexity } from '../router.ts';
import { globalPayloadCache, globalSemanticCache } from '../cache.ts';
import { globalMetricsCollector, globalUnifiedProfiler, type SwarmBaselineReport } from '../profiler.ts';
import { globalTieredCache, SelectiveSnapshotter, type TieredLookupResult } from '../tieredCache.ts';
import { globalFeedbackEngine, analystLedger } from '../feedback.ts';
import { globalLoadBalancer } from '../loadBalancer.ts';
import { globalKnowledgeGraph } from '../knowledgeGraph.ts';
import {
    globalLearningRateManager,
    globalHypothesisLayer,
    globalShapedRewardPolicy,
    type TaskDecompositionPlan
} from '../coordination.ts';
import { arbitrateAndPropagateCoordination } from './coordinationPipeline.ts';
import type { ClusterDigest } from '../communication.ts';
import type { SchedulerExecutionResult } from '../scheduler.ts';
import type { HierarchyMetrics } from '../hierarchy.ts';

export interface LearningPipelineParams {
    task: string;
    data: any;
    finalAnalysis: any;
    context: SwarmContext;
    params: SwarmWorkflowParams;
    settings?: SwarmEngineSettings;
    activeVariant?: AgentVariantConfig;
    activeExperiment?: AgentExperiment;
    workflowStartTime: number;
    complexity: TaskComplexity;
    workflowLifecycleResult: any;
    analysts: Agent[];
    managerAgent: Agent;
    memoryCortex?: MemoryCortex;
    targetAppId: string;
    cacheKey: string;
    cacheQuery: string;
    agentConfigVersion: string;
    tieredCacheEnabled: boolean;
    profilingEnabled: boolean;
    coordinationEnabled: boolean;
    workflowTotalTokens: number;
    workflowPromptTokensSaved: number;
    workflowOriginalPromptTokens: number;
    workflowCompressedPromptTokens: number;
    workflowDeduplicatedCount: number;
    workflowSchedulingResult?: SchedulerExecutionResult;
    workflowHierarchyMetrics?: HierarchyMetrics;
    workflowTieredCacheHit?: TieredLookupResult;
    latestClusterDigests?: Record<string, ClusterDigest>;
    workflowDecompositionPlan?: TaskDecompositionPlan;
}

export interface LearningPipelineResult {
    metrics: SwarmBaselineReport;
    workflowFeedbackReport?: SwarmFeedbackReport;
    workflowExpDecision?: ExperimentDecision;
    workflowSnapshotId?: string;
    workflowShapedReward?: {
        shapedReward: number;
        components: {
            extrinsic: number;
            noveltyBonus: number;
            redundancyPenalty: number;
        };
    };
}

export async function runLearningPipeline(p: LearningPipelineParams): Promise<LearningPipelineResult> {
    const {
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
        profilingEnabled,
        coordinationEnabled,
        workflowTotalTokens,
        workflowPromptTokensSaved,
        workflowOriginalPromptTokens,
        workflowCompressedPromptTokens,
        workflowDeduplicatedCount,
        workflowSchedulingResult,
        workflowHierarchyMetrics,
        workflowTieredCacheHit,
        latestClusterDigests
    } = p;

    const coordinationSettings = settings?.coordinationSettings;

    // Step 5b: Hierarchical Hypothesis Arbitration & Knowledge Graph Propagation
    if (coordinationEnabled) {
        arbitrateAndPropagateCoordination({
            finalAnalysis,
            managerRole: managerAgent.role || 'Manager Node',
            coordinationSettings,
            context
        });
    }

    if (memoryCortex && finalAnalysis && !finalAnalysis.ui_title?.toLowerCase().includes("error")) {
        const qualityRating = workflowLifecycleResult
            ? workflowLifecycleResult.computedRating
            : (complexity === 'instant' ? 0.90 : 0.85);
        const verified = workflowLifecycleResult ? workflowLifecycleResult.success : false;
        const feedback = workflowLifecycleResult?.criticFeedback;
        const isFact = verified || qualityRating >= 0.8;
        const writeOriginApp = (params as any).originApp || (params as any).callerAppId || targetAppId;
        const domain = normalizeDomain(settings?.domain || (params as any).domain, task);
        const entityIds = extractEntityIds(task, (params as any).entityIds || settings?.entityIds);
        const content = `Task: ${task}\nResult: ${finalAnalysis.ui_title || 'Analysis complete'}`;
        const meta = {
            originApp: writeOriginApp,
            appId: writeOriginApp,
            domain,
            memoryType: isFact ? ('fact' as const) : ('judgment' as const),
            entityIds,
            agentRole: 'Manager Node',
            complexity,
            verified: isFact,
            qualityRating,
            feedback,
            attempts: workflowLifecycleResult?.attempts || 1,
            task,
            fastPath: false
        };

        try {
            const storedId = await memoryCortex.store(content, meta);
            if (params.onMemoryLearned) {
                params.onMemoryLearned({
                    appId: writeOriginApp,
                    content,
                    id: storedId,
                    metadata: meta
                });
            }
        } catch (err: any) {
            console.warn(`[Swarm] Memory storage failed:`, err);
        }
    }

    if (finalAnalysis && !finalAnalysis.ui_title?.toLowerCase().includes("error")) {
        globalPayloadCache.set(cacheKey, finalAnalysis);
        globalSemanticCache.set(task, finalAnalysis, { data, configVersion: agentConfigVersion });
    }

    const workflowDurationMs = Date.now() - workflowStartTime;
    const isSuccess = !finalAnalysis?.ui_title?.toLowerCase().includes("error");
    globalMetricsCollector.recordTaskExecution({
        success: isSuccess,
        durationMs: workflowDurationMs,
        agentRole: managerAgent?.role || 'Manager Node',
        provider: managerAgent?.provider
    });
    const metrics = globalMetricsCollector.getBaselineReport();
    context.addEvent({
        agentRole: 'System Profiler',
        action: 'Workflow Metrics Baseline',
        modelName: 'Local/MetricsCollector',
        prompt: `Workflow baseline telemetry: completionRate=${metrics.overallCompletionRatePercent}%, p50=${metrics.overallLatency.p50Ms}ms, p95=${metrics.overallLatency.p95Ms}ms, totalTasks=${metrics.totalTasks}`,
        output: metrics,
        durationMs: workflowDurationMs
    });

    let workflowExpDecision: ExperimentDecision | undefined;
    if (activeExperiment && activeVariant && settings?.experimentSettings?.autoRecordMetrics !== false) {
        const isError = !isSuccess;
        const rlaifScore = workflowLifecycleResult?.computedRating 
            ? (workflowLifecycleResult.computedRating / 100) 
            : (complexity === 'instant' ? 0.90 : 0.85);
        const tokensTotal = workflowTotalTokens || (metrics?.totalTasks ? metrics.totalTasks * 500 : 1000);

        const execMetrics: ExecutionMetrics = {
            durationMs: workflowDurationMs,
            tokensTotal,
            rlaifScore,
            error: isError,
            errorMessage: isError ? finalAnalysis?.ui_title : undefined,
            anomaliesCount: (finalAnalysis?.components || []).reduce((acc: number, c: any) => {
                if (c.type === 'InsightList' && Array.isArray(c.props?.insights)) {
                    return acc + c.props.insights.filter((ins: any) => ins.type === 'alert' || ins.type === 'warning').length;
                }
                return acc;
            }, 0),
            insightsCount: (finalAnalysis?.components || []).reduce((acc: number, c: any) => {
                if (c.type === 'InsightList' && Array.isArray(c.props?.insights)) {
                    return acc + c.props.insights.length;
                }
                return acc;
            }, 0)
        };

        workflowExpDecision = activeExperiment.recordOutcome(activeVariant.variantId, execMetrics);

        context.addEvent({
            agentRole: 'A/B Testing Engine',
            action: workflowExpDecision.action === 'promoted' 
                ? 'Agent Configuration Promoted'
                : (workflowExpDecision.action === 'circuit_breaker_rollback' 
                    ? 'Circuit Breaker Rollback' 
                    : 'Agent Experiment Evaluated'),
            modelName: 'Local/ExperimentManager',
            prompt: `Workflow evaluation: variant='${activeVariant.variantId}', action='${workflowExpDecision.action}', reason=${workflowExpDecision.reason}`,
            output: {
                experimentId: activeExperiment.id,
                variantId: activeVariant.variantId,
                metrics: execMetrics,
                decision: workflowExpDecision,
                performance: activeExperiment.getPerformance(activeVariant.variantId)
            },
            durationMs: 0
        });
    }

    params.onStage?.({
        stage: 'completed',
        task,
        digests: latestClusterDigests,
        finalAnalysis
    });

    let workflowSnapshotId: string | undefined;
    if (tieredCacheEnabled && finalAnalysis) {
        globalTieredCache.set(cacheQuery, finalAnalysis, cacheQuery);
        if (settings?.tieredCacheSettings?.enableStateSnapshots !== false) {
            const snapId = `snap-${Date.now()}-${crypto.randomUUID()}`;
            workflowSnapshotId = snapId;
            const stateToSnap = {
                task,
                complexity,
                finalAnalysisTitle: finalAnalysis?.ui_title,
                eventsCount: context.events.length,
                analystsCount: analysts.length
            };
            const baseSnap = globalTieredCache.saveSnapshot(snapId, stateToSnap);
            const comp = SelectiveSnapshotter.compressPayload(JSON.stringify(stateToSnap));
            context.addEvent({
                agentRole: 'State Compression Engine',
                action: 'State Snapshot Compressed',
                modelName: 'Local/SelectiveSnapshotter',
                prompt: `Saved compressed state snapshot '${snapId}' (${comp.originalByteSize} -> ${comp.compressedByteSize} bytes, ${comp.reductionPercent}% reduction)`,
                output: {
                    snapshotId: snapId,
                    hash: baseSnap.hash,
                    originalBytes: comp.originalByteSize,
                    compressedBytes: comp.compressedByteSize,
                    reductionPercent: comp.reductionPercent
                },
                durationMs: 0
            });
        }
    }

    if (profilingEnabled) {
        globalUnifiedProfiler.recordWorkflowRun({
            durationMs: workflowDurationMs,
            cache: tieredCacheEnabled ? {
                l1Hits: workflowTieredCacheHit?.tier === 'L1' ? 1 : 0,
                l2Hits: workflowTieredCacheHit?.tier === 'L2' ? 1 : 0,
                l3Hits: workflowTieredCacheHit?.tier === 'L3' ? 1 : 0,
                misses: !workflowTieredCacheHit?.found ? 1 : 0,
                savedTokens: workflowTieredCacheHit?.found ? 250 : 0
            } : undefined,
            scheduler: workflowSchedulingResult ? {
                totalTasks: workflowSchedulingResult.totalTasks,
                successfulTasks: workflowSchedulingResult.successfulTasks,
                failedTasks: workflowSchedulingResult.failedTasks,
                totalQueueWaitMs: workflowSchedulingResult.totalQueueWaitMs,
                totalExecutionMs: workflowSchedulingResult.totalExecutionMs,
                totalBackpressureDelayMs: workflowSchedulingResult.totalBackpressureDelayMs,
                stolenTaskCount: workflowSchedulingResult.stolenTaskCount
            } : undefined,
            compression: workflowOriginalPromptTokens > 0 ? {
                totalOriginalTokens: workflowOriginalPromptTokens,
                totalCompressedTokens: workflowCompressedPromptTokens,
                totalTokensSaved: workflowPromptTokensSaved,
                deduplicatedSegmentsCount: workflowDeduplicatedCount
            } : undefined,
            hierarchy: workflowHierarchyMetrics ? {
                treeDepth: workflowHierarchyMetrics.treeDepth,
                totalNodes: workflowHierarchyMetrics.totalNodes,
                tierCounts: workflowHierarchyMetrics.tierCounts,
                delegatedTasksCount: workflowHierarchyMetrics.delegationsCount,
                escalatedTasksCount: workflowHierarchyMetrics.escalationsCount
            } : undefined
        });
    }

    const feedbackEnabled = settings?.feedbackSettings?.enabled !== false;
    let workflowFeedbackReport: SwarmFeedbackReport | undefined;
    if (feedbackEnabled) {
        try {
            const qualityScore = workflowLifecycleResult?.computedRating ? workflowLifecycleResult.computedRating / 100 : (isSuccess ? 0.90 : 0.40);
            const failoverCount = (context.events || []).filter(e => e.action?.toLowerCase().includes('failover')).length;
            const hardErrorCount = isSuccess ? 0 : 1;
            const errorCount = hardErrorCount + failoverCount;

            const participatingRoles = (analysts && analysts.length > 0)
                ? analysts.map(a => a.role).filter(Boolean)
                : (settings?.agents || []).map((a: any) => a.role).filter(Boolean);

            const baseOperationalAccuracy = isSuccess ? 0.95 : 0.30;
            const ledgerStats = analystLedger.getAverageAccuracy(targetAppId, participatingRoles);
            const blendWeight = ledgerStats.totalOutcomes > 0 ? Math.min(0.50, ledgerStats.totalOutcomes * 0.05) : 0;
            const accuracyScore = Math.round(((1 - blendWeight) * baseOperationalAccuracy + blendWeight * ledgerStats.accuracy) * 1000) / 1000;

            const tokensConsumed = workflowTotalTokens || (metrics?.totalTasks ? metrics.totalTasks * 400 : 800);
            const tokenSavings = workflowPromptTokensSaved;

            const fbResult = await globalFeedbackEngine.processFeedback({
                workflowId: (context as any).id || `wf-${Date.now()}`,
                task,
                appId: targetAppId,
                agentRoles: participatingRoles,
                durationMs: workflowDurationMs,
                targetTier: complexity === 'instant' ? 'instant' : 'complex',
                tokenSavings,
                tokensConsumed,
                qualityScore,
                accuracyScore,
                errorCount,
                hardErrorCount,
                failoverCount,
                anomalyCount: (finalAnalysis?.components || []).reduce((acc: number, c: any) => {
                    if (c.type === 'InsightList' && Array.isArray(c.props?.insights)) {
                        return acc + c.props.insights.filter((ins: any) => ins.type === 'alert' || ins.type === 'warning').length;
                    }
                    return acc;
                }, 0),
                finalInsightSnippet: typeof finalAnalysis === 'string' ? finalAnalysis.slice(0, 150) : (finalAnalysis?.ui_title || JSON.stringify(finalAnalysis).slice(0, 150)),
                inputData: data
            });

            workflowFeedbackReport = {
                reward: fbResult.reward,
                tunedParameters: fbResult.tunedParameters,
                driftAlerts: fbResult.driftAlerts,
                outcomeId: fbResult.outcomeId,
                policyUpdated: fbResult.policyUpdated
            };

            // Feed reinforcement learning reward into load balancer for failover priority weighting
            if (fbResult.reward?.compositeReward !== undefined) {
                for (const analyst of analysts) {
                    globalLoadBalancer.recordReward(analyst.provider, fbResult.reward.compositeReward);
                }
                if (managerAgent) {
                    globalLoadBalancer.recordReward(managerAgent.provider, fbResult.reward.compositeReward);
                }
            }

            context.addEvent({
                agentRole: 'Feedback & Learning Engine',
                action: 'Policy Tuned & Outcome Indexed',
                modelName: 'Local/RL-Evolutionary-Optimizer',
                prompt: `Feedback processed: composite reward=${fbResult.reward.compositeReward}, drift alerts=${fbResult.driftAlerts.length}`,
                output: {
                    reward: fbResult.reward.compositeReward,
                    rewardComponents: fbResult.reward.components,
                    rewardInputs: {
                        qualityScore,
                        accuracyScore,
                        errorCount,
                        hardErrorCount,
                        failoverCount,
                        durationMs: workflowDurationMs,
                        tokensConsumed,
                        tokenSavings,
                        computedRating: workflowLifecycleResult?.computedRating ?? null
                    },
                    policyUpdated: fbResult.policyUpdated,
                    outcomeId: fbResult.outcomeId,
                    activePolicy: fbResult.tunedParameters,
                    driftAlerts: fbResult.driftAlerts
                },
                durationMs: 0
            });
        } catch (fbErr: any) {
            console.warn('[Swarm] Feedback processing failed:', fbErr);
        }
    }

    // Step 7b: Adaptive Learning Rates & Shaped Reward Optimization
    let workflowShapedReward: {
        shapedReward: number;
        components: {
            extrinsic: number;
            noveltyBonus: number;
            redundancyPenalty: number;
        };
    } | undefined;

    if (coordinationEnabled) {
        const extrinsic = workflowLifecycleResult?.computedRating
            ? workflowLifecycleResult.computedRating / 100
            : (isSuccess ? 0.90 : 0.35);

        if (coordinationSettings?.rewardShaping !== false) {
            const noveltyScore = Math.min(1.0, (globalKnowledgeGraph.getStats().totalNodes % 10) / 10 + 0.3);
            const redundancyCount = globalHypothesisLayer.getHypotheses('refuted').length;
            workflowShapedReward = globalShapedRewardPolicy.calculateShapedReward({
                extrinsicReward: extrinsic,
                noveltyScore,
                redundancyCount
            });
        }

        if (coordinationSettings?.adaptiveLearningRates !== false) {
            const targetReward = workflowShapedReward?.shapedReward ?? extrinsic;
            const updatedRates: Record<string, number> = {};
            for (const analyst of analysts) {
                const res = globalLearningRateManager.recordAgentStep(analyst.role, targetReward);
                updatedRates[analyst.role] = res.newRate;
            }
            const mgrRes = globalLearningRateManager.recordAgentStep(managerAgent.role || 'Manager Node', targetReward);
            updatedRates[managerAgent.role || 'Manager Node'] = mgrRes.newRate;

            context.addEvent({
                agentRole: 'Adaptive Learning Coordinator',
                action: 'Agent Learning Rates Updated',
                modelName: 'Local/AgentAdaptiveLearningRateManager',
                prompt: `Adjusted learning rates across ${Object.keys(updatedRates).length} agents based on reward ${targetReward}`,
                output: {
                    reward: targetReward,
                    agentRates: updatedRates
                },
                durationMs: 0
            });
        }
    }

    return {
        metrics,
        workflowFeedbackReport,
        workflowExpDecision,
        workflowSnapshotId,
        workflowShapedReward
    };
}
