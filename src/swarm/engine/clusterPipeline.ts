import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import type { SwarmWorkflowParams } from './types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import type { AgentVariantConfig } from '../experiment.ts';
import { ToolRegistry } from '../tools/index.ts';
import {
    globalHierarchicalMessageBus,
    type ClusterDigest,
    type SwarmTopology,
    type SpecialistReportInput
} from '../communication.ts';
import {
    globalSpecialistRouter,
    globalTokenBudgetManager,
    globalSpecialistProfiler,
    globalNodeCapacityManager,
    type SpecialistRoutingPlan
} from '../loadBalancer.ts';
import {
    HierarchicalSpecialistTree,
    type HierarchyMetrics
} from '../hierarchy.ts';
import {
    AdaptiveTaskScheduler,
    type ScheduledTask,
    type SchedulerExecutionResult,
    type TaskPriority
} from '../scheduler.ts';
import {
    DependencyGraph,
    SpeculativeExecutionCoordinator,
    type SpeculativeTask
} from '../speculative.ts';
import {
    globalPredictionWorkerPool,
    type PartialPrediction
} from '../optimization.ts';
import { publishInteragentCoordination } from './coordinationPipeline.ts';
import type { MemoryCortex } from '../memory.ts';
import { setupClusterTopology } from './clusterTopology.ts';
import { createAnalystExecutor } from './analystExecution.ts';
import { evaluateEarlyExit } from './earlyExit.ts';

export interface ClusterPipelineParams {
    task: string;
    data?: string;
    analysts: Agent[];
    managerAgent: Agent;
    chunks: string[];
    profile: any;
    rawInput: string;
    historicalContext: string;
    targetAppId: string;
    settings?: SwarmEngineSettings;
    activeVariant?: AgentVariantConfig;
    context: SwarmContext;
    toolRegistry: ToolRegistry;
    memoryCortex?: MemoryCortex;
    params: SwarmWorkflowParams;
    optimizationEnabled: boolean;
    coordinationEnabled: boolean;
    bypassCache: boolean;
}

export interface ClusterPipelineResult {
    allAnalystReports: any[][];
    clusterDigests: Record<string, ClusterDigest>;
    topology: SwarmTopology;
    latestClusterDigests: Record<string, ClusterDigest>;
    earlyPartialPrediction?: PartialPrediction;
    earlyExitTriggered: boolean;
    earlyExitLatencySavedMs: number;
    earlyFinalAnalysis: any | null;
    workflowSchedulingResult?: SchedulerExecutionResult;
    workflowHierarchyMetrics?: HierarchyMetrics;
    workflowOriginalPromptTokens: number;
    workflowCompressedPromptTokens: number;
    workflowPromptTokensSaved: number;
    workflowDeduplicatedCount: number;
}

export async function runClusterPipeline(p: ClusterPipelineParams): Promise<ClusterPipelineResult> {
    const {
        task,
        data,
        analysts,
        managerAgent,
        chunks,
        profile,
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
    } = p;

    let workflowOriginalPromptTokens = 0;
    let workflowCompressedPromptTokens = 0;
    let workflowPromptTokensSaved = 0;
    let workflowDeduplicatedCount = 0;
    let workflowSchedulingResult: SchedulerExecutionResult | undefined;
    let workflowHierarchyMetrics: HierarchyMetrics | undefined;
    const coordinationSettings = settings?.coordinationSettings;
    const optSettings = settings?.optimizationSettings;

    const allAnalystReports: any[][] = analysts.map(() => []);

    // 1. Dynamic Cluster Auto-Discovery & Capability Lead Election
    const {
        topology,
        analystClusterMap,
        specialistTree,
        hierarchicalDelegationCount
    } = setupClusterTopology({
        task,
        data,
        analysts,
        managerAgent,
        chunks,
        settings,
        context
    });
    let hierarchicalEscalationCount = 0;

    // 2. Dynamic Specialist Routing
    if (analysts.length > 0 && chunks.length > 0) {
        let routingPlan: SpecialistRoutingPlan;
        if (chunks.length > 1) {
            routingPlan = globalSpecialistRouter.planDistribution(task, chunks, analysts);
        } else {
            const estTokens = Math.max(10, Math.ceil(chunks[0].length / 4));
            const assignments = analysts.map(analyst => {
                const { score: affinity, matchedDomain } = globalSpecialistRouter.scoreAffinity(analyst.role, `${task}\n${chunks[0]}`);
                globalTokenBudgetManager.recordUsage(analyst.provider, estTokens, analyst.role);
                return {
                    chunkIndex: 0,
                    estimatedTokens: estTokens,
                    agentId: (analyst as any).id || analyst.role,
                    agentRole: analyst.role,
                    provider: analyst.provider,
                    affinityScore: affinity,
                    allocatedTokens: estTokens,
                    reason: matchedDomain
                        ? `Matched '${matchedDomain}' domain affinity (${Math.round(affinity * 100)}%)`
                        : `Domain perspective analysis (${Math.round(affinity * 100)}%)`
                };
            });

            const specialistSummary: Record<string, { role: string; chunksAssigned: number; tokensAllocated: number }> = {};
            for (const a of analysts) {
                specialistSummary[a.role] = {
                    role: a.role,
                    chunksAssigned: 1,
                    tokensAllocated: estTokens
                };
            }

            routingPlan = {
                totalChunks: 1,
                totalEstimatedTokens: estTokens * analysts.length,
                assignments,
                specialistSummary
            };
        }

        context.addEvent({
            agentRole: 'Dynamic Task Router',
            action: 'Specialist Dynamic Routing',
            modelName: 'Local/AffinityRouter',
            prompt: `Dynamic specialist routing plan for ${chunks.length} chunk(s) across ${analysts.length} specialist(s)`,
            output: {
                totalChunks: routingPlan.totalChunks,
                totalEstimatedTokens: routingPlan.totalEstimatedTokens,
                assignments: routingPlan.assignments,
                specialistSummary: routingPlan.specialistSummary,
                tokenBudgets: globalTokenBudgetManager.getMetrics(),
                capabilityProfiles: globalSpecialistProfiler.getAllProfiles(),
                nodeCapacity: globalNodeCapacityManager.getAllNodeMetrics()
            },
            durationMs: 0
        });

        // 3. Construct Analyst Execution Function
        const executeAnalyst = createAnalystExecutor({
            task,
            chunks,
            profile,
            historicalContext,
            targetAppId,
            settings,
            activeVariant,
            context,
            toolRegistry,
            memoryCortex,
            analystClusterMap,
            specialistTree,
            bypassCache,
            onPromptCompression: (m) => {
                workflowOriginalPromptTokens += m.originalTokens;
                workflowCompressedPromptTokens += m.compressedTokens;
                workflowPromptTokensSaved += m.tokensSaved;
                workflowDeduplicatedCount += m.deduplicatedCount;
            },
            onEscalation: () => {
                hierarchicalEscalationCount++;
            }
        });

        const useScheduling = settings?.schedulingSettings?.enabled === true;
        const useSpeculativeParallel = !useScheduling && settings?.speculativeParallel !== false && params.speculativeParallel !== false;

        // 4. Execution Strategies (Adaptive Scheduling vs Speculative Parallel vs Worker Pool)
        if (useScheduling) {
            const schedConfig = settings?.schedulingSettings;
            const scheduler = new AdaptiveTaskScheduler({
                strategy: schedConfig?.strategy || 'work-stealing',
                maxConcurrency: schedConfig?.maxConcurrency || settings?.maxSpeculativeConcurrency || 4,
                enableRateLimiting: schedConfig?.enableRateLimiting !== false,
                agingThresholdMs: schedConfig?.agingThresholdMs,
                rateLimits: schedConfig?.rateLimits,
                onEvent: (evt) => {
                    if (evt.type === 'backpressure_delay') {
                        context.addEvent({
                            agentRole: 'Rate Limiter',
                            action: 'Queue Backpressure Delayed',
                            modelName: 'Local/TokenBucket',
                            prompt: `Provider '${evt.provider}' rate limit backpressure: delaying task '${evt.taskId}' by ${evt.delayMs}ms`,
                            output: { taskId: evt.taskId, provider: evt.provider, delayMs: evt.delayMs }
                        });
                    } else if (evt.type === 'work_stolen') {
                        context.addEvent({
                            agentRole: 'Work Stealing Pool',
                            action: 'Work Stolen',
                            modelName: 'Local/WorkStealing',
                            prompt: `Worker '${evt.workerId}' stole task '${evt.taskId}' from '${evt.metadata?.stolenFrom}'`,
                            output: { taskId: evt.taskId, workerId: evt.workerId, stolenFrom: evt.metadata?.stolenFrom }
                        });
                    } else if (evt.type === 'task_scheduled') {
                        context.addEvent({
                            agentRole: 'Adaptive Task Scheduler',
                            action: 'Task Scheduled',
                            modelName: 'Local/AdaptiveScheduler',
                            prompt: `Scheduled task '${evt.taskId}' for worker '${evt.workerId}' (Priority: ${evt.priority})`,
                            output: { taskId: evt.taskId, workerId: evt.workerId, priority: evt.priority, provider: evt.provider }
                        });
                    }
                }
            });

            let schedTasks: ScheduledTask[];
            if (chunks.length > 1) {
                schedTasks = chunks.map((chunk, i) => {
                    const assignment = routingPlan.assignments.find(asn => asn.chunkIndex === i);
                    const assignedAnalyst = analysts.find(a => a.role === assignment?.agentRole) || analysts[i % analysts.length];
                    const estTokens = assignment?.estimatedTokens || Math.max(10, Math.ceil(chunk.length / 4));
                    return {
                        id: `chunk-task-${i}`,
                        priority: (i === 0 ? 'high' : 'normal') as TaskPriority,
                        assignedWorkerId: assignedAnalyst.role,
                        targetProvider: assignedAnalyst.provider,
                        domain: assignedAnalyst.role,
                        estimatedTokens: estTokens,
                        payload: chunk,
                        execute: () => executeAnalyst(assignedAnalyst, chunk, i)
                    };
                });
            } else {
                const estTokens = Math.max(10, Math.ceil(chunks[0].length / 4));
                schedTasks = analysts.map((analyst, i) => {
                    return {
                        id: `analyst-task-${i}`,
                        priority: 'normal' as TaskPriority,
                        assignedWorkerId: analyst.role,
                        targetProvider: analyst.provider,
                        domain: analyst.role,
                        estimatedTokens: estTokens,
                        payload: chunks[0],
                        execute: () => executeAnalyst(analyst, chunks[0], 0)
                    };
                });
            }

            workflowSchedulingResult = await scheduler.executeScheduled(schedTasks, {
                strategy: schedConfig?.strategy,
                maxConcurrency: schedConfig?.maxConcurrency
            });

            for (const item of workflowSchedulingResult.results) {
                if (item.success && item.result) {
                    const resData = item.result;
                    const chunkIdx = (resData as any)._chunkIndex ?? 0;
                    const assignedAnalyst = analysts.find(a => a.role === item.workerId) || analysts[chunkIdx % analysts.length];
                    const analystIdx = analysts.indexOf(assignedAnalyst);
                    if (analystIdx >= 0) {
                        allAnalystReports[analystIdx].push(resData);
                    }
                }
            }

            context.addEvent({
                agentRole: 'Adaptive Task Scheduler',
                action: 'Adaptive Task Scheduling',
                modelName: 'Local/AdaptiveScheduler',
                prompt: `Adaptive scheduling executed ${schedTasks.length} task(s) using '${schedConfig?.strategy || 'work-stealing'}' strategy (Queue Wait: ${workflowSchedulingResult.averageQueueWaitMs}ms, Stolen: ${workflowSchedulingResult.stolenTaskCount}, Backpressure: ${workflowSchedulingResult.totalBackpressureDelayMs}ms)`,
                output: {
                    totalTasks: workflowSchedulingResult.totalTasks,
                    successfulTasks: workflowSchedulingResult.successfulTasks,
                    failedTasks: workflowSchedulingResult.failedTasks,
                    averageQueueWaitMs: workflowSchedulingResult.averageQueueWaitMs,
                    totalExecutionMs: workflowSchedulingResult.totalExecutionMs,
                    totalBackpressureDelayMs: workflowSchedulingResult.totalBackpressureDelayMs,
                    stolenTaskCount: workflowSchedulingResult.stolenTaskCount,
                    strategy: schedConfig?.strategy || 'work-stealing'
                },
                durationMs: workflowSchedulingResult.totalExecutionMs
            });
        } else if (chunks.length > 1) {
            if (useSpeculativeParallel) {
                const depGraph = DependencyGraph.fromChunks(chunks, task);
                const speculativeCoordinator = new SpeculativeExecutionCoordinator();
                const maxConcurrency = settings?.maxSpeculativeConcurrency || params.maxSpeculativeConcurrency || 4;

                const specTasks: SpeculativeTask[] = chunks.map((chunk, i) => {
                    const assignment = routingPlan.assignments.find(asn => asn.chunkIndex === i);
                    const assignedAnalyst = analysts.find(a => a.role === assignment?.agentRole) || analysts[i % analysts.length];
                    const node = depGraph.getNode(`chunk-${i}`);
                    return {
                        id: `chunk-${i}`,
                        chunkIndex: i,
                        payload: chunk,
                        dependencies: node?.dependencies || [],
                        execute: () => executeAnalyst(assignedAnalyst, chunk, i)
                    };
                });

                const specResult = await speculativeCoordinator.executeSpeculative(specTasks, {
                    maxConcurrency,
                    staggerDelayMs: 25,
                    conflictOptions: {
                        strategy: settings?.conflictResolutionStrategy || 'conservative_pessimistic',
                        capabilityScorer: (role) => globalSpecialistProfiler.getCapabilityScore(role)
                    }
                });

                for (const resData of specResult.results) {
                    const chunkIdx = (resData as any)._chunkIndex ?? 0;
                    const assignment = routingPlan.assignments.find(asn => asn.chunkIndex === chunkIdx);
                    const assignedAnalyst = analysts.find(a => a.role === assignment?.agentRole) || analysts[chunkIdx % analysts.length];
                    const analystIdx = analysts.indexOf(assignedAnalyst);
                    if (analystIdx >= 0) {
                        allAnalystReports[analystIdx].push(resData);
                    }
                }

                context.addEvent({
                    agentRole: 'Speculative Execution Coordinator',
                    action: 'Speculative Parallel Execution',
                    modelName: 'Local/SpeculativeCoordinator',
                    prompt: `Speculatively executed ${chunks.length} independent chunk(s) across ${analysts.length} specialist(s) (Peak Concurrency: ${specResult.concurrencyPeak})`,
                    output: {
                        totalChunks: chunks.length,
                        concurrencyPeak: specResult.concurrencyPeak,
                        actualWallClockDurationMs: specResult.actualWallClockDurationMs,
                        serialDurationEstimateMs: specResult.serialDurationEstimateMs,
                        latencyReductionPercent: specResult.latencyReductionPercent,
                        conflictsDetected: specResult.reconciledReport.conflicts.length,
                        conflictsResolved: specResult.reconciledReport.resolutions.length,
                        duplicateInsightsMerged: specResult.reconciledReport.duplicateCount
                    },
                    durationMs: specResult.actualWallClockDurationMs
                });

                if (specResult.reconciledReport.conflicts.length > 0) {
                    context.addEvent({
                        agentRole: 'Conflict Resolver',
                        action: 'Conflict Resolution',
                        modelName: 'Local/ConflictResolver',
                        prompt: `Resolved ${specResult.reconciledReport.conflicts.length} conflicting assertions across speculative branches`,
                        output: {
                            conflicts: specResult.reconciledReport.conflicts,
                            resolutions: specResult.reconciledReport.resolutions,
                            strategy: settings?.conflictResolutionStrategy || 'conservative_pessimistic'
                        },
                        durationMs: 0
                    });
                }
            } else {
                const usePool = optimizationEnabled && (optSettings?.workerPoolConcurrency ?? 4) > 1;

                const chunkTasks = chunks.map((chunk, i) => {
                    const assignment = routingPlan.assignments.find(asn => asn.chunkIndex === i);
                    const assignedAnalyst = analysts.find(a => a.role === assignment?.agentRole) || analysts[i % analysts.length];
                    const analystIdx = analysts.indexOf(assignedAnalyst);
                    return { chunk, i, assignedAnalyst, analystIdx };
                });

                const chunkReports = usePool
                    ? await globalPredictionWorkerPool.submitBatch(
                        chunkTasks.map(taskItem => () => executeAnalyst(taskItem.assignedAnalyst, taskItem.chunk, taskItem.i))
                    )
                    : await Promise.all(
                        chunkTasks.map(taskItem => executeAnalyst(taskItem.assignedAnalyst, taskItem.chunk, taskItem.i))
                    );

                chunkTasks.forEach((taskItem, index) => {
                    if (taskItem.analystIdx >= 0) {
                        allAnalystReports[taskItem.analystIdx].push(chunkReports[index]);
                    }
                });
            }
        } else {
            const usePool = optimizationEnabled && (optSettings?.workerPoolConcurrency ?? 4) > 1;
            const chunkReports = usePool
                ? await globalPredictionWorkerPool.submitBatch(
                    analysts.map((analyst) => () => executeAnalyst(analyst, chunks[0], 0))
                )
                : await Promise.all(
                    analysts.map((analyst) => executeAnalyst(analyst, chunks[0], 0))
                );
            for (let a = 0; a < analysts.length; a++) {
                allAnalystReports[a].push(chunkReports[a]);
            }
        }
    }

    if (specialistTree) {
        const metrics = specialistTree.getMetrics();
        metrics.delegationsCount = hierarchicalDelegationCount;
        metrics.escalationsCount = hierarchicalEscalationCount;
        workflowHierarchyMetrics = metrics;
    }

    // 5. Hierarchical Communication Layer: Aggregate Cluster Digests
    const clusterReportsMap: Record<string, SpecialistReportInput[]> = {};
    for (let a = 0; a < analysts.length; a++) {
        const analyst = analysts[a];
        const aId = analyst.id || analyst.role;
        const cluster = analystClusterMap.get(aId) || 'general-pod';
        if (!clusterReportsMap[cluster]) clusterReportsMap[cluster] = [];

        for (const rep of allAnalystReports[a]) {
            clusterReportsMap[cluster].push({
                specialistRole: analyst.role,
                insights: rep.insights,
                anomalies: rep.anomalies,
                summary: rep.summary
            });
        }
    }

    const clusterDigests: Record<string, ClusterDigest> = {};
    for (const [cId, reps] of Object.entries(clusterReportsMap)) {
        clusterDigests[cId] = globalHierarchicalMessageBus.aggregateClusterReports(cId, reps);
    }
    const latestClusterDigests = clusterDigests;
    const busMetrics = globalHierarchicalMessageBus.getMetrics();

    context.addEvent({
        agentRole: 'Hierarchical Communication Layer',
        action: 'Hierarchical Swarm Communication',
        modelName: 'Local/HierarchicalBus',
        prompt: `Consolidated ${analysts.length} specialist reports across ${Object.keys(clusterDigests).length} cluster(s) with ${Math.round(busMetrics.overallCompressionRatio * 100)}% token reduction`,
        output: {
            digests: clusterDigests,
            metrics: busMetrics,
            topology: {
                pods: topology.pods,
                leadNodeIds: topology.leadNodeIds,
                totalPods: topology.totalPods
            }
        },
        durationMs: 0
    });

    // 6. Interagent Message Publishing & Coordination
    if (coordinationEnabled) {
        publishInteragentCoordination({
            analysts,
            allAnalystReports,
            coordinationSettings,
            context
        });
    }

    params.onStage?.({
        stage: 'cluster_aggregation',
        task,
        digests: clusterDigests,
        metrics: busMetrics,
        topology
    });

    // 7. Early Partial Prediction & Confidence Early-Exit Evaluation
    const {
        earlyPartialPrediction,
        earlyExitTriggered,
        earlyExitLatencySavedMs,
        earlyFinalAnalysis
    } = evaluateEarlyExit({
        task,
        allAnalystReports,
        analystsCount: analysts.length,
        optimizationEnabled,
        settings,
        context,
        workflowParams: params
    });

    return {
        allAnalystReports,
        clusterDigests,
        topology,
        latestClusterDigests,
        earlyPartialPrediction,
        earlyExitTriggered,
        earlyExitLatencySavedMs,
        earlyFinalAnalysis,
        workflowSchedulingResult,
        workflowHierarchyMetrics,
        workflowOriginalPromptTokens,
        workflowCompressedPromptTokens,
        workflowPromptTokensSaved,
        workflowDeduplicatedCount
    };
}
