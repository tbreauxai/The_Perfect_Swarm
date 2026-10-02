import type { AgentConfig } from '../types.ts';

export type ExperimentStatus = 'draft' | 'active' | 'paused' | 'concluded' | 'rolled_back';

export type AllocationStrategy = 'random' | 'deterministic_hash' | 'thompson_sampling' | 'epsilon_greedy';

export interface AgentVariantConfig {
    variantId: string;
    name: string;
    description?: string;
    isBaseline?: boolean;
    trafficWeight: number; // e.g. 0.50 (normalized against all active variants)
    agents?: AgentConfig[];
    systemPrompts?: Record<string, string>; // role/id -> custom system prompt
    parameters?: {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        [key: string]: any;
    };
    metadata?: Record<string, any>;
}

export interface ExecutionMetrics {
    durationMs: number;
    tokensTotal?: number;
    rlaifScore?: number; // 0.0 - 1.0 from Critic verification loop
    userRating?: number; // 0.0 - 1.0 optional external feedback
    error?: boolean;
    errorMessage?: string;
    anomaliesCount?: number;
    insightsCount?: number;
    metadata?: Record<string, any>;
    timestamp?: string;
}

export interface VariantPerformance {
    variantId: string;
    sampleCount: number;
    successCount: number;
    errorCount: number;
    errorRate: number;
    meanDurationMs: number;
    meanRlaifScore: number;
    meanTokens: number;
    compositeScore: number;
    history: ExecutionMetrics[];
}

export interface CircuitBreakerConfig {
    maxErrorRate?: number;                 // default: 0.20 (20% error threshold)
    minRlaifScore?: number;                // default: 0.60 (minimum acceptable quality rating)
    maxLatencyDegradationPercent?: number;  // default: 50% slower than baseline
    minSamplesBeforeTrigger?: number;      // default: 5 samples before circuit breaker can trip
}

export interface PromotionCriteria {
    minSampleSize?: number;                // default: 10 samples per variant
    confidenceLevel?: number;              // default: 0.95 (alpha = 0.05)
    minImprovementPercent?: number;        // default: 5% (0.05 improvement in primary metric)
    primaryMetric?: 'composite' | 'rlaifScore' | 'durationMs'; // default: 'composite'
}

export interface CompositeScoreWeights {
    rlaifWeight?: number;       // default: 0.50
    latencyWeight?: number;     // default: 0.30
    tokenWeight?: number;       // default: 0.20
    baselineLatencyMs?: number; // default: 2000ms
    baselineTokens?: number;    // default: 4000 tokens
}

export interface StatisticalComparison {
    controlVariantId: string;
    treatmentVariantId: string;
    metric: 'rlaifScore' | 'durationMs' | 'tokens' | 'composite';
    controlMean: number;
    treatmentMean: number;
    delta: number;
    percentChange: number;
    tStatistic: number;
    degreesOfFreedom: number;
    pValue: number;
    isStatisticallySignificant: boolean;
    confidenceInterval95: [number, number];
    recommendation: 'promote' | 'continue' | 'rollback' | 'inconclusive';
    reason: string;
}

export interface ExperimentDecision {
    experimentId: string;
    status: ExperimentStatus;
    winningVariantId?: string;
    action: 'none' | 'promoted' | 'circuit_breaker_rollback' | 'traffic_rebalanced';
    reason: string;
    timestamp: string;
    comparison?: StatisticalComparison;
}

export interface ExperimentConfig {
    id: string;
    name: string;
    description?: string;
    variants: AgentVariantConfig[];
    allocationStrategy?: AllocationStrategy;
    circuitBreaker?: CircuitBreakerConfig;
    promotionCriteria?: PromotionCriteria;
    compositeWeights?: CompositeScoreWeights;
}
