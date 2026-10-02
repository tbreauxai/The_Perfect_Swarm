export interface DataProfile {
    charCount: number;
    estimatedTokens: number;
    rowCount: number;
    format: 'JSON' | 'Text/CSV';
}

export interface ChunkingResult {
    chunks: string[];
    originalChunkCount: number;
    maxTokensPerChunk: number;
    totalTokens: number;
    warning?: string;
}

export interface TraceEvent {
    id: string;
    timestamp: number;
    agentRole?: string;
    action: string;
    modelName?: string;
    provider?: string;
    durationMs?: number;
    error?: string;
    payload?: any;
}

export interface LatencyDistribution {
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    emaMs: number;
    sampleCount: number;
}

export interface EntityMetricsBaseline {
    name: string;
    totalTasks: number;
    successCount: number;
    failureCount: number;
    completionRatePercent: number;
    latency: LatencyDistribution;
    lastError?: string;
}

export interface SwarmBaselineReport {
    timestamp: number;
    totalTasks: number;
    successCount: number;
    failureCount: number;
    overallCompletionRatePercent: number;
    overallLatency: LatencyDistribution;
    providers: Record<string, EntityMetricsBaseline>;
    agents: Record<string, EntityMetricsBaseline>;
}

export interface CacheMetricsBaseline {
    l1Hits: number;
    l2Hits: number;
    l3Hits: number;
    misses: number;
    totalRequests: number;
    hitRatePercent: number;
    savedTokens: number;
    memorySavedBytes: number;
    promotions: number;
}

export interface SchedulerMetricsBaseline {
    totalTasks: number;
    successfulTasks: number;
    failedTasks: number;
    totalQueueWaitMs: number;
    averageQueueWaitMs: number;
    totalExecutionMs: number;
    totalBackpressureDelayMs: number;
    stolenTaskCount: number;
}

export interface CompressionMetricsBaseline {
    totalOriginalTokens: number;
    totalCompressedTokens: number;
    totalTokensSaved: number;
    averageReductionPercent: number;
    deduplicatedSegmentsCount: number;
}

export interface VectorIndexMetricsBaseline {
    totalQueries: number;
    totalComparisons: number;
    averageComparisonsPerQuery: number;
    pruningEfficiencyPercent: number;
}

export interface HierarchyMetricsBaseline {
    treeDepth: number;
    totalNodes: number;
    tierCounts: Record<number, number>;
    delegatedTasksCount: number;
    escalatedTasksCount: number;
}

export interface SpeculativeMetricsBaseline {
    totalRuns: number;
    parallelBatchesExecuted: number;
    averageSpeedupRatio: number;
    conflictsDetected: number;
    conflictsResolved: number;
}

export interface PerformanceAnomaly {
    id: string;
    subsystem: string;
    metric: string;
    observedValue: number;
    baselineValue: number;
    threshold: number;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    timestamp: number;
}

export interface ResourceUtilizationBaseline {
    totalTokensSaved: number;
    totalMemorySavedBytes: number;
    estimatedCostSavedDollars: number;
    heapUsedMb: number;
}

export interface UnifiedSwarmBaselineReport {
    timestamp: number;
    totalWorkflows: number;
    workflowDuration: LatencyDistribution;
    taskMetrics: SwarmBaselineReport;
    subsystems: {
        cache?: CacheMetricsBaseline;
        scheduler?: SchedulerMetricsBaseline;
        compression?: CompressionMetricsBaseline;
        vectorIndex?: VectorIndexMetricsBaseline;
        hierarchy?: HierarchyMetricsBaseline;
        speculative?: SpeculativeMetricsBaseline;
    };
    resourceUtilization: ResourceUtilizationBaseline;
    anomalies: PerformanceAnomaly[];
}

export interface BenchmarkOptions {
    iterations?: number;
    batchSize?: number;
    enableSubsystems?: boolean;
}

export interface BenchmarkResult {
    totalIterations: number;
    durationMs: number;
    opsPerSecond: number;
    latency: LatencyDistribution;
    anomalies: PerformanceAnomaly[];
    report: UnifiedSwarmBaselineReport;
    summary: string;
}
