export interface PerformanceMetricsSnapshot {
    workflowId: string;
    task: string;
    appId: string;
    durationMs: number;
    targetTier: 'instant' | 'complex' | 'hierarchical';
    tokenSavings: number;
    tokensConsumed: number;
    qualityScore?: number; // 0.0 - 1.0
    accuracyScore?: number; // 0.0 - 1.0
    errorCount: number;
    hardErrorCount?: number;
    failoverCount?: number;
    anomalyCount: number;
    timestamp: number;
    metadata?: Record<string, any>;
}

export interface RewardWeights {
    quality: number;
    accuracy: number;
    latency: number;
    cost: number;
    tokenSavings: number;
}

export interface RewardSignal {
    compositeReward: number; // Normalized -1.0 to 1.0
    components: {
        qualityReward: number;
        accuracyReward: number;
        latencyPenalty: number;
        costPenalty: number;
        savingsReward: number;
        failoverPenalty?: number;
    };
    weights: RewardWeights;
    timestamp: number;
}

export interface TunableParameters {
    cacheL1MaxEntries: number;
    cacheSemanticThreshold: number;
    compressionTargetReductionRatio: number;
    compressionSimilarityThreshold: number;
    schedulerMaxConcurrency: number;
    schedulerStarvationAgeMs: number;
    speculativeBatchThreshold: number;
    explorationFactor: number;
}

export const DEFAULT_TUNABLE_PARAMETERS: TunableParameters = {
    cacheL1MaxEntries: 100,
    cacheSemanticThreshold: 0.82,
    compressionTargetReductionRatio: 0.35,
    compressionSimilarityThreshold: 0.72,
    schedulerMaxConcurrency: 4,
    schedulerStarvationAgeMs: 5000,
    speculativeBatchThreshold: 3,
    explorationFactor: 0.15
};

export interface ParameterBounds {
    min: number;
    max: number;
    step: number;
    isInteger?: boolean;
}

export const PARAMETER_BOUNDS: Record<keyof TunableParameters, ParameterBounds> = {
    cacheL1MaxEntries: { min: 20, max: 1000, step: 10, isInteger: true },
    cacheSemanticThreshold: { min: 0.60, max: 0.98, step: 0.02 },
    compressionTargetReductionRatio: { min: 0.15, max: 0.65, step: 0.05 },
    compressionSimilarityThreshold: { min: 0.50, max: 0.95, step: 0.02 },
    schedulerMaxConcurrency: { min: 1, max: 16, step: 1, isInteger: true },
    schedulerStarvationAgeMs: { min: 1000, max: 15000, step: 500, isInteger: true },
    speculativeBatchThreshold: { min: 2, max: 10, step: 1, isInteger: true },
    explorationFactor: { min: 0.01, max: 0.50, step: 0.02 }
};

export type DriftType =
    | 'page-hinkley-latency'
    | 'page-hinkley-quality'
    | 'embedding-centroid-shift'
    | 'schema-validation-failure';

export interface DriftAlert {
    id: string;
    driftType: DriftType;
    severity: 'warning' | 'critical';
    metric: string;
    currentValue: number;
    baselineValue: number;
    threshold: number;
    recommendedAction: 're-index-memory' | 'reset-policy' | 'tighten-thresholds' | 'retrain-weights';
    timestamp: number;
    message: string;
}

export interface AnalysisOutcomeRecord {
    id: string;
    workflowId: string;
    task: string;
    appId: string;
    finalInsightSnippet: string;
    metrics: PerformanceMetricsSnapshot;
    reward: RewardSignal;
    parametersUsed: TunableParameters;
    driftAlerts: DriftAlert[];
    agentRoles?: string[];
    timestamp: number;
}

export interface AnalystLedgerRecord {
    wins: number;
    losses: number;
    pushes: number;
    lastUpdated: number;
}
