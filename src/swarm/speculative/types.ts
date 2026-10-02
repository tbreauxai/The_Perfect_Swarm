export type SubtaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed';

export interface SubtaskNode<T = any> {
    id: string;
    chunkIndex: number;
    dependencies: string[]; // IDs of tasks that must complete before this task
    payload: T;
    metadata?: Record<string, any>;
    status?: SubtaskStatus;
    result?: any;
    error?: string;
    durationMs?: number;
}

export type ConflictType = 
    | 'contradiction'        // Explicit opposing statements (e.g. healthy vs critical)
    | 'severity_mismatch'    // Mismatch in assigned priority/urgency
    | 'metric_divergence'    // Numerical values differ significantly
    | 'duplicate';           // Semantically redundant findings

export interface ConflictingAssertion {
    id: string;
    topic: string;
    conflictType: ConflictType;
    claims: {
        sourceAgentRole: string;
        claim: string;
        confidence: number;
        sentiment: 'positive' | 'negative' | 'neutral';
        extractedValue?: number;
    }[];
}

export type ConflictResolutionStrategy = 
    | 'confidence_weighted'      // Select or weight claims by specialist confidence/affinity
    | 'conservative_pessimistic'  // Prioritize safety/anomalies (avoid false negatives)
    | 'majority_consensus'       // Quorum agreement among specialist votes
    | 'deduplicate_union';        // Combine distinct insights, remove near-duplicates

export interface ResolvedAssertion {
    topic: string;
    resolvedClaim: string;
    conflictType: ConflictType;
    strategy: ConflictResolutionStrategy;
    confidence: number;
    contributingSources: string[];
    rationale: string;
}

export interface ReconciledReportResult {
    insights: string[];
    anomalies: string[];
    summary: string;
    conflicts: ConflictingAssertion[];
    resolutions: ResolvedAssertion[];
    duplicateCount: number;
}

export interface ConflictResolutionOptions {
    strategy?: ConflictResolutionStrategy;
    confidenceThreshold?: number;
    similarityThreshold?: number; // default: 0.75 for deduplication
    capabilityScorer?: (role: string) => number;
}

export interface SpeculativeTask<TInput = any, TOutput = any> {
    id: string;
    chunkIndex: number;
    payload: TInput;
    dependencies?: string[];
    execute: () => Promise<TOutput>;
}

export interface SpeculativeExecutionResult<TOutput = any> {
    results: (TOutput & { _chunkIndex?: number })[];
    reconciledReport: ReconciledReportResult;
    serialDurationEstimateMs: number;
    actualWallClockDurationMs: number;
    latencyReductionPercent: number;
    concurrencyPeak: number;
    totalTasks: number;
}

export interface SpeculativeOptions {
    maxConcurrency?: number;      // default: 4
    staggerDelayMs?: number;      // small jitter between launches (default: 50ms)
    conflictOptions?: ConflictResolutionOptions;
    slotAcquirer?: (key: string) => { release: () => void } | null;
}
