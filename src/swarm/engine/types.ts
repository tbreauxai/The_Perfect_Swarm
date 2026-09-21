import { GoogleGenAI } from "@google/genai";
import { SwarmContext } from "../context.ts";
import { MemoryCortex } from "../memory.ts";
import type { SwarmEvent, LearnedMemoryEvent, SwarmEngineSettings } from "../types.ts";
import type { TaskComplexity } from "../router.ts";
import type { UnifiedSwarmBaselineReport, SwarmBaselineReport } from "../profiler.ts";
import type { TunableParameters, DriftAlert, RewardSignal } from "../feedback.ts";
import type { ExperimentDecision } from "../experiment.ts";
import type { TieredCacheMetrics } from "../tieredCache.ts";
import type { ClusterDigest } from "../communication.ts";
import type { TaskDecompositionPlan } from "../coordination.ts";
import type { SwarmTool, ToolRegistry } from "../tools/index.ts";
export interface SwarmStagePayload {
    stage: 'routing' | 'cluster_aggregation' | 'partial_prediction' | 'manager_synthesis' | 'critic_verification' | 'completed';
    task?: string;
    digests?: Record<string, ClusterDigest>;
    partialPrediction?: any;
    metrics?: any;
    [key: string]: any;
}

export interface SwarmWorkflowParams {
    task: string;
    data?: string;
    settings?: SwarmEngineSettings;
    defaultAi?: GoogleGenAI;
    enableDeepAnalysis?: boolean;
    forceFullSwarm?: boolean;
    /**
     * Skip all caches (payload, semantic, tiered) and force a fresh LLM run.
     * Useful for debugging and for verifying behavior after config changes.
     */
    bypassCache?: boolean;
    speculativeParallel?: boolean;
    maxSpeculativeConcurrency?: number;
    complexityOverride?: TaskComplexity;
    onEvent?: (event: SwarmEvent) => void;
    onMemoryLearned?: (event: LearnedMemoryEvent) => void;
    onStage?: (stagePayload: SwarmStagePayload) => void;
    onPartialResult?: (partialResult: any) => void;
    context?: SwarmContext;
    cortex?: MemoryCortex;
    tools?: SwarmTool[] | ToolRegistry;
}

export interface SwarmWorkflowResult {
    events: SwarmEvent[];
    finalAnalysis: any;
    metrics?: SwarmBaselineReport;
    experiment?: {
        experimentId: string;
        variantId: string;
        variantName?: string;
        decision?: ExperimentDecision;
    };
    compression?: {
        originalTokens: number;
        compressedTokens: number;
        tokensSaved: number;
        reductionRatio: number;
        deduplicatedSegmentsCount: number;
    };
    scheduling?: {
        totalTasks: number;
        successfulTasks: number;
        failedTasks: number;
        totalQueueWaitMs: number;
        averageQueueWaitMs: number;
        totalExecutionMs: number;
        totalBackpressureDelayMs: number;
        stolenTaskCount: number;
    };
    hierarchy?: {
        treeDepth: number;
        totalNodes: number;
        tierCounts: Record<number, number>;
        delegatedTasksCount: number;
        escalatedTasksCount: number;
    };
    tieredCache?: {
        hit: boolean;
        tier?: 'L1' | 'L2' | 'L3';
        similarity?: number;
        latencyMs: number;
        snapshotId?: string;
        metrics: TieredCacheMetrics;
    };
    unifiedBaselines?: UnifiedSwarmBaselineReport;
    feedback?: SwarmFeedbackReport;
    coordination?: {
        knowledgeGraphVersion: number;
        totalNodes: number;
        totalEdges: number;
        hypothesesCount: number;
        validatedHypothesesCount: number;
        taskDecomposition?: TaskDecompositionPlan;
        agentLearningRates: Record<string, number>;
        shapedReward?: {
            shapedReward: number;
            components: {
                extrinsic: number;
                noveltyBonus: number;
                redundancyPenalty: number;
            };
        };
    };
    optimization?: {
        earlyExit: boolean;
        tier: 'tier1_approx' | 'tier2_refined';
        latencySavedMs: number;
        partialResultEmitted: boolean;
        subcomputationsCached?: number;
        tokenWeightRatio?: number;
        tokensSaved?: number;
    };
}

export interface SwarmFeedbackReport {
    reward: RewardSignal;
    tunedParameters: TunableParameters;
    driftAlerts: DriftAlert[];
    outcomeId: string;
    policyUpdated: boolean;
}

/**
 * Process-level singleton registry for in-memory cortex instances per appId.
 * Preserves continuous vector learning across sequential workflow runs in the same runtime.
 */
