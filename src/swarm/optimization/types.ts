export type SubComputationDomain = 
    | 'team_form' 
    | 'head_to_head' 
    | 'market_odds' 
    | 'player_props' 
    | 'league_baseline' 
    | 'custom';

export interface SubComputationCacheEntry<T = any> {
    domain: SubComputationDomain;
    key: string;
    value: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
}

export interface SubComputationCacheMetrics {
    totalEntries: number;
    hits: number;
    misses: number;
    hitRatio: number;
    subcomputationsSaved: number;
    evictions: number;
    domainBreakdown: Record<SubComputationDomain, { entries: number; hits: number; misses: number }>;
}

export interface SubComputationCacheConfig {
    defaultTtlMs?: number; // default: 300,000ms (5 minutes)
    maxEntries?: number;   // default: 1,000 entries
}

export interface BaselineDifference {
    tokenDelta: number;
    tokenDivergenceRatio: number;
    baselineTokens: number;
    currentTokens: number;
    addedKeys: string[];
    removedKeys: string[];
    deviatingFields: Array<{ field: string; baselineTokens: number; currentTokens: number; growthPercent: number }>;
    isBloated: boolean;
    recommendation: string;
}

export interface TokenWeightReport {
    totalTokens: number;
    metadataTokens: number;
    dataTokens: number;
    metadataWeightRatio: number;
    fieldWeights: Record<string, number>;
    isBloated: boolean;
    baselineDiff?: BaselineDifference;
    recommendations: string[];
}

export interface PreFilterOptions {
    maxMatches?: number;
    minLiquidityVolume?: number;
    stripStaleOdds?: boolean;
    stripVerboseFields?: boolean;
    salientKeys?: string[];
    allowedMarketTypes?: string[];
    dropClosedMatches?: boolean;
}

export interface PreFilterResult {
    filteredData: any;
    originalByteSize: number;
    filteredByteSize: number;
    originalEstimatedTokens: number;
    filteredEstimatedTokens: number;
    tokensSaved: number;
    prunedFieldsCount: number;
    prunedRecordsCount: number;
    reductionRatio: number;
}

export interface PartialPrediction {
    id?: string;
    event?: string;
    market?: string;
    predictedOutcome?: string;
    probability?: number;
    confidence?: number;
    odds?: number;
    spread?: number;
    tier?: 'tier1_approx' | 'tier2_refined';
    alternatives?: Array<{ outcome: string; probability: number }>;
    summary?: string;
}

export interface EarlyExitOptions {
    confidenceThreshold?: number; // default: 0.85
    marginThreshold?: number;     // default: 0.35
    requireDecisiveSpread?: boolean;
}

export interface EarlyExitDecision {
    canEarlyExit: boolean;
    confidence: number;
    margin?: number;
    reason: string;
    tier: 'tier1_approx' | 'tier2_refined';
    bypassedRefinement: boolean;
    estimatedLatencySavedMs: number;
}

export type PredictionTaskPriority = 'high' | 'normal' | 'low';

export interface PoolTask<T = any> {
    id: string;
    priority: PredictionTaskPriority;
    execute: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    timeoutMs?: number;
    submittedAt: number;
}

export interface WorkerPoolMetrics {
    maxConcurrency: number;
    activeWorkers: number;
    queueLength: number;
    completedTasks: number;
    failedTasks: number;
    totalExecutionTimeMs: number;
    averageTaskDurationMs: number;
}

export interface PredictionWorkerPoolConfig {
    maxConcurrency?: number;
    defaultTaskTimeoutMs?: number;
}

export interface TieredPredictionInput {
    task: string;
    data?: any;
    baseline?: any;
    onPartialResult?: (partial: PartialPrediction) => void;
    tier1Fn: (data: any) => Promise<PartialPrediction>;
    tier2Fn?: (data: any, tier1Result: PartialPrediction) => Promise<any>;
    options?: {
        enableEarlyExit?: boolean;
        confidenceThreshold?: number;
        marginThreshold?: number;
        preFilter?: boolean;
        subComputationDomain?: SubComputationDomain;
        subComputationKey?: string;
    };
}

export interface TieredPredictionResult {
    finalResult: any;
    tier: 'tier1_approx' | 'tier2_refined';
    earlyExit: boolean;
    earlyExitDecision?: EarlyExitDecision;
    tier1LatencyMs: number;
    tier2LatencyMs: number;
    totalLatencyMs: number;
    partialResultEmitted: boolean;
    tokenReport?: TokenWeightReport;
    preFilterResult?: PreFilterResult;
    cacheHit?: boolean;
}
