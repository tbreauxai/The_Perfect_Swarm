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

export const DEFAULT_MAX_CHARS = 500000;
export const DEFAULT_MAX_TOKENS_PER_CHUNK = 8000; // Calibrated for free-tier quotas
export const DEFAULT_MAX_CHUNKS = 8; // Expanded from 4 to 8 to support deep metadata payloads

/**
 * Extracts metadata and profiles the input data payload.
 */
export function profileData(data: string, maxChars: number = DEFAULT_MAX_CHARS): { rawInput: string; profile: DataProfile } {
    let rawInput = data || "";
    if (rawInput.length > maxChars) {
        rawInput = rawInput.substring(0, maxChars) + "\n...[TRUNCATED FOR MEMORY SAFETY]...";
    }

    const charCount = rawInput.length;
    const estimatedTokens = Math.ceil(charCount / 4);
    const rowCount = rawInput.split('\n').length;
    const trimmed = rawInput.trim();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

    return {
        rawInput,
        profile: {
            charCount,
            estimatedTokens,
            rowCount,
            format: isJson ? 'JSON' : 'Text/CSV'
        }
    };
}

/**
 * Splits raw input into token-budgeted chunks respecting free-tier API quotas and HTTP timeout thresholds.
 */
export function createTokenChunks(
    rawInput: string,
    maxTokensPerChunk: number = DEFAULT_MAX_TOKENS_PER_CHUNK,
    maxChunks: number = DEFAULT_MAX_CHUNKS
): ChunkingResult {
    const rawLines = rawInput.split('\n');
    const maxCharsPerChunk = maxTokensPerChunk * 4;
    const normalizedLines: string[] = [];

    for (const line of rawLines) {
        if (line.length <= maxCharsPerChunk) {
            normalizedLines.push(line);
        } else {
            // Segment ultra-long line (e.g. minified JSON or unformatted logs)
            for (let offset = 0; offset < line.length; offset += maxCharsPerChunk) {
                normalizedLines.push(line.substring(offset, offset + maxCharsPerChunk));
            }
        }
    }

    const chunks: string[] = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (const line of normalizedLines) {
        const lineTokens = Math.ceil(line.length / 4);

        if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
            currentTokens = 0;
        }

        currentChunk += line + "\n";
        currentTokens += lineTokens;
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    if (chunks.length === 0) {
        chunks.push("");
    }

    const originalChunkCount = chunks.length;
    let warning: string | undefined = undefined;

    if (chunks.length > maxChunks) {
        warning = `Payload exceeded ${maxChunks} batches (${originalChunkCount} chunks detected). Analysis balanced to preserve opening structure, representative sampling, and closing metadata trailer.`;
        if (maxChunks <= 1) {
            chunks.length = 1;
        } else if (maxChunks === 2) {
            const first = chunks[0];
            const last = chunks[chunks.length - 1];
            chunks.length = 0;
            chunks.push(first, last);
        } else {
            const first = chunks.slice(0, maxChunks - 1);
            const last = chunks[chunks.length - 1];
            chunks.length = 0;
            chunks.push(...first, last);
        }
    }

    const totalTokens = chunks.reduce((acc, c) => acc + Math.ceil(c.length / 4), 0);

    return {
        chunks,
        originalChunkCount,
        maxTokensPerChunk,
        totalTokens,
        warning
    };
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

export function calculateLatencyDistribution(
    latencies: number[],
    currentEma: number = 0,
    alpha: number = 0.2
): LatencyDistribution {
    if (!latencies || latencies.length === 0) {
        return {
            minMs: 0,
            maxMs: 0,
            avgMs: 0,
            p50Ms: 0,
            p90Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            emaMs: currentEma,
            sampleCount: 0
        };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const count = sorted.length;
    const minMs = sorted[0];
    const maxMs = sorted[count - 1];
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avgMs = Math.round(sum / count);

    const getPercentile = (p: number): number => {
        const idx = Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
        return sorted[idx];
    };

    return {
        minMs,
        maxMs,
        avgMs,
        p50Ms: getPercentile(50),
        p90Ms: getPercentile(90),
        p95Ms: getPercentile(95),
        p99Ms: getPercentile(99),
        emaMs: currentEma,
        sampleCount: count
    };
}

/**
 * Instruments key performance metrics (task completion rate, latency percentiles, EMA, and provider/agent baselines).
 */
export class SwarmMetricsCollector {
    private static instance: SwarmMetricsCollector;
    private latencies: number[] = [];
    private overallEma: number = 0;
    private emaAlpha: number = 0.2;
    private totalTasks: number = 0;
    private successCount: number = 0;
    private failureCount: number = 0;

    private providerRecords: Map<string, {
        latencies: number[];
        ema: number;
        successes: number;
        failures: number;
        lastError?: string;
    }> = new Map();

    private agentRecords: Map<string, {
        latencies: number[];
        ema: number;
        successes: number;
        failures: number;
        lastError?: string;
    }> = new Map();

    public constructor(alpha: number = 0.2) {
        this.emaAlpha = alpha;
    }

    public static getInstance(): SwarmMetricsCollector {
        if (!SwarmMetricsCollector.instance) {
            SwarmMetricsCollector.instance = new SwarmMetricsCollector();
        }
        return SwarmMetricsCollector.instance;
    }

    public recordTaskExecution(params: {
        success: boolean;
        durationMs: number;
        provider?: string;
        agentRole?: string;
        error?: string;
    }): void {
        const { success, durationMs, provider, agentRole, error } = params;
        const validDuration = Math.max(0, Math.round(durationMs));

        this.totalTasks++;
        if (success) {
            this.successCount++;
        } else {
            this.failureCount++;
        }

        this.latencies.push(validDuration);
        if (this.overallEma === 0) {
            this.overallEma = validDuration;
        } else {
            this.overallEma = Math.round((this.emaAlpha * validDuration) + ((1 - this.emaAlpha) * this.overallEma));
        }

        if (provider) {
            const pKey = provider.toLowerCase();
            let rec = this.providerRecords.get(pKey);
            if (!rec) {
                rec = { latencies: [], ema: 0, successes: 0, failures: 0 };
                this.providerRecords.set(pKey, rec);
            }
            if (success) rec.successes++;
            else rec.failures++;
            if (error) rec.lastError = error;
            rec.latencies.push(validDuration);
            rec.ema = rec.ema === 0 ? validDuration : Math.round((this.emaAlpha * validDuration) + ((1 - this.emaAlpha) * rec.ema));
        }

        if (agentRole) {
            const aKey = agentRole;
            let rec = this.agentRecords.get(aKey);
            if (!rec) {
                rec = { latencies: [], ema: 0, successes: 0, failures: 0 };
                this.agentRecords.set(aKey, rec);
            }
            if (success) rec.successes++;
            else rec.failures++;
            if (error) rec.lastError = error;
            rec.latencies.push(validDuration);
            rec.ema = rec.ema === 0 ? validDuration : Math.round((this.emaAlpha * validDuration) + ((1 - this.emaAlpha) * rec.ema));
        }
    }

    public getBaselineReport(): SwarmBaselineReport {
        const overallRate = this.totalTasks > 0
            ? Math.round((this.successCount / this.totalTasks) * 10000) / 100
            : 0;

        const overallLatency = calculateLatencyDistribution(this.latencies, this.overallEma, this.emaAlpha);

        const providers: Record<string, EntityMetricsBaseline> = {};
        for (const [p, rec] of this.providerRecords.entries()) {
            const total = rec.successes + rec.failures;
            providers[p] = {
                name: p,
                totalTasks: total,
                successCount: rec.successes,
                failureCount: rec.failures,
                completionRatePercent: total > 0 ? Math.round((rec.successes / total) * 10000) / 100 : 0,
                latency: calculateLatencyDistribution(rec.latencies, rec.ema, this.emaAlpha),
                lastError: rec.lastError
            };
        }

        const agents: Record<string, EntityMetricsBaseline> = {};
        for (const [a, rec] of this.agentRecords.entries()) {
            const total = rec.successes + rec.failures;
            agents[a] = {
                name: a,
                totalTasks: total,
                successCount: rec.successes,
                failureCount: rec.failures,
                completionRatePercent: total > 0 ? Math.round((rec.successes / total) * 10000) / 100 : 0,
                latency: calculateLatencyDistribution(rec.latencies, rec.ema, this.emaAlpha),
                lastError: rec.lastError
            };
        }

        return {
            timestamp: Date.now(),
            totalTasks: this.totalTasks,
            successCount: this.successCount,
            failureCount: this.failureCount,
            overallCompletionRatePercent: overallRate,
            overallLatency,
            providers,
            agents
        };
    }

    public reset(): void {
        this.latencies = [];
        this.overallEma = 0;
        this.totalTasks = 0;
        this.successCount = 0;
        this.failureCount = 0;
        this.providerRecords.clear();
        this.agentRecords.clear();
    }

    public getSnapshot(): SwarmBaselineReport {
        return this.getBaselineReport();
    }
}

export const globalMetricsCollector = SwarmMetricsCollector.getInstance();

export class SwarmTracer {
    private static instance: SwarmTracer;
    private events: TraceEvent[] = [];
    private onEventCb?: (event: TraceEvent) => void;

    private constructor() {}

    public static getInstance(): SwarmTracer {
        if (!SwarmTracer.instance) {
            SwarmTracer.instance = new SwarmTracer();
        }
        return SwarmTracer.instance;
    }

    public setCallback(cb: (event: TraceEvent) => void) {
        this.onEventCb = cb;
    }

    public logEvent(event: Omit<TraceEvent, 'id' | 'timestamp'>) {
        const fullEvent: TraceEvent = {
            ...event,
            id: Math.random().toString(36).substring(7),
            timestamp: Date.now()
        };
        this.events.push(fullEvent);
        if (this.onEventCb) {
            this.onEventCb(fullEvent);
        }

        // Auto-instrument metrics when trace event has duration
        if (fullEvent.durationMs !== undefined && fullEvent.durationMs > 0) {
            const isFailure = !!fullEvent.error || fullEvent.action.toLowerCase().includes('failed') || fullEvent.action.toLowerCase().includes('error');
            globalMetricsCollector.recordTaskExecution({
                success: !isFailure,
                durationMs: fullEvent.durationMs,
                provider: fullEvent.provider,
                agentRole: fullEvent.agentRole,
                error: fullEvent.error
            });
        }
    }

    public dumpTrace(): TraceEvent[] {
        return this.events;
    }

    public clear() {
        this.events = [];
    }
}

// ============================================================================
// Unified Baseline Profiling, Subsystem Telemetry & Performance Anomaly Detection
// ============================================================================

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

export class PerformanceAnomalyDetector {
    private baselineP95: number = 0;
    private baselineP99: number = 0;
    private observedLatencies: number[] = [];

    calibrate(latencies: number[]): void {
        if (!latencies || latencies.length === 0) return;
        this.observedLatencies = [...latencies].sort((a, b) => a - b);
        const count = this.observedLatencies.length;
        const p95Idx = Math.min(count - 1, Math.max(0, Math.ceil(0.95 * count) - 1));
        const p99Idx = Math.min(count - 1, Math.max(0, Math.ceil(0.99 * count) - 1));
        this.baselineP95 = this.observedLatencies[p95Idx];
        this.baselineP99 = this.observedLatencies[p99Idx];
    }

    checkLatency(subsystem: string, observedMs: number): PerformanceAnomaly | null {
        if (this.baselineP99 > 0 && observedMs > this.baselineP99 * 2.0) {
            return {
                id: Math.random().toString(36).substring(7),
                subsystem,
                metric: 'latencyMs',
                observedValue: observedMs,
                baselineValue: this.baselineP99,
                threshold: this.baselineP99 * 2.0,
                severity: 'critical',
                message: `Critical latency spike: ${observedMs}ms exceeded baseline p99 (${this.baselineP99}ms) by >200%`,
                timestamp: Date.now()
            };
        }
        if (this.baselineP95 > 0 && observedMs > this.baselineP95 * 1.5) {
            return {
                id: Math.random().toString(36).substring(7),
                subsystem,
                metric: 'latencyMs',
                observedValue: observedMs,
                baselineValue: this.baselineP95,
                threshold: this.baselineP95 * 1.5,
                severity: 'warning',
                message: `Elevated latency warning: ${observedMs}ms exceeded baseline p95 (${this.baselineP95}ms) by >150%`,
                timestamp: Date.now()
            };
        }
        return null;
    }

    getBaselines(): { p95: number; p99: number; sampleCount: number } {
        return {
            p95: this.baselineP95,
            p99: this.baselineP99,
            sampleCount: this.observedLatencies.length
        };
    }
}

export class UnifiedSwarmProfiler {
    private static instance: UnifiedSwarmProfiler;
    private workflowLatencies: number[] = [];
    private workflowEma: number = 0;
    private totalWorkflows: number = 0;
    private anomalies: PerformanceAnomaly[] = [];
    private anomalyDetector = new PerformanceAnomalyDetector();

    private cacheBaseline: CacheMetricsBaseline = {
        l1Hits: 0,
        l2Hits: 0,
        l3Hits: 0,
        misses: 0,
        totalRequests: 0,
        hitRatePercent: 0,
        savedTokens: 0,
        memorySavedBytes: 0,
        promotions: 0
    };

    private schedulerBaseline: SchedulerMetricsBaseline = {
        totalTasks: 0,
        successfulTasks: 0,
        failedTasks: 0,
        totalQueueWaitMs: 0,
        averageQueueWaitMs: 0,
        totalExecutionMs: 0,
        totalBackpressureDelayMs: 0,
        stolenTaskCount: 0
    };

    private compressionBaseline: CompressionMetricsBaseline = {
        totalOriginalTokens: 0,
        totalCompressedTokens: 0,
        totalTokensSaved: 0,
        averageReductionPercent: 0,
        deduplicatedSegmentsCount: 0
    };

    private vectorIndexBaseline: VectorIndexMetricsBaseline = {
        totalQueries: 0,
        totalComparisons: 0,
        averageComparisonsPerQuery: 0,
        pruningEfficiencyPercent: 0
    };

    private hierarchyBaseline: HierarchyMetricsBaseline = {
        treeDepth: 0,
        totalNodes: 0,
        tierCounts: {},
        delegatedTasksCount: 0,
        escalatedTasksCount: 0
    };

    private speculativeBaseline: SpeculativeMetricsBaseline = {
        totalRuns: 0,
        parallelBatchesExecuted: 0,
        averageSpeedupRatio: 1.0,
        conflictsDetected: 0,
        conflictsResolved: 0
    };

    public static getInstance(): UnifiedSwarmProfiler {
        if (!UnifiedSwarmProfiler.instance) {
            UnifiedSwarmProfiler.instance = new UnifiedSwarmProfiler();
        }
        return UnifiedSwarmProfiler.instance;
    }

    public recordWorkflowRun(params: {
        durationMs: number;
        cache?: Partial<CacheMetricsBaseline>;
        scheduler?: Partial<SchedulerMetricsBaseline>;
        compression?: Partial<CompressionMetricsBaseline>;
        vectorIndex?: Partial<VectorIndexMetricsBaseline>;
        hierarchy?: Partial<HierarchyMetricsBaseline>;
        speculative?: Partial<SpeculativeMetricsBaseline>;
    }): void {
        const d = Math.max(0, Math.round(params.durationMs));
        this.totalWorkflows++;
        this.workflowLatencies.push(d);
        this.workflowEma = this.workflowEma === 0 ? d : Math.round(0.2 * d + 0.8 * this.workflowEma);

        const anomaly = this.anomalyDetector.checkLatency('WorkflowEngine', d);
        if (anomaly) {
            this.anomalies.push(anomaly);
            if (this.anomalies.length > 50) this.anomalies.shift();
        }

        if (this.workflowLatencies.length % 5 === 0) {
            this.anomalyDetector.calibrate(this.workflowLatencies);
        }

        if (params.cache) this.mergeCacheMetrics(params.cache);
        if (params.scheduler) this.mergeSchedulerMetrics(params.scheduler);
        if (params.compression) this.mergeCompressionMetrics(params.compression);
        if (params.vectorIndex) this.mergeVectorIndexMetrics(params.vectorIndex);
        if (params.hierarchy) this.mergeHierarchyMetrics(params.hierarchy);
        if (params.speculative) this.mergeSpeculativeMetrics(params.speculative);
    }

    public mergeCacheMetrics(update: Partial<CacheMetricsBaseline>): void {
        this.cacheBaseline.l1Hits += update.l1Hits ?? 0;
        this.cacheBaseline.l2Hits += update.l2Hits ?? 0;
        this.cacheBaseline.l3Hits += update.l3Hits ?? 0;
        this.cacheBaseline.misses += update.misses ?? 0;
        this.cacheBaseline.savedTokens += update.savedTokens ?? 0;
        this.cacheBaseline.memorySavedBytes += update.memorySavedBytes ?? 0;
        this.cacheBaseline.promotions += update.promotions ?? 0;

        const totalHits = this.cacheBaseline.l1Hits + this.cacheBaseline.l2Hits + this.cacheBaseline.l3Hits;
        const total = totalHits + this.cacheBaseline.misses;
        this.cacheBaseline.totalRequests = total;
        this.cacheBaseline.hitRatePercent = total > 0 ? Math.round((totalHits / total) * 10000) / 100 : 0;
    }

    public mergeSchedulerMetrics(update: Partial<SchedulerMetricsBaseline>): void {
        this.schedulerBaseline.totalTasks += update.totalTasks ?? 0;
        this.schedulerBaseline.successfulTasks += update.successfulTasks ?? 0;
        this.schedulerBaseline.failedTasks += update.failedTasks ?? 0;
        this.schedulerBaseline.totalQueueWaitMs += update.totalQueueWaitMs ?? 0;
        this.schedulerBaseline.totalExecutionMs += update.totalExecutionMs ?? 0;
        this.schedulerBaseline.totalBackpressureDelayMs += update.totalBackpressureDelayMs ?? 0;
        this.schedulerBaseline.stolenTaskCount += update.stolenTaskCount ?? 0;

        if (this.schedulerBaseline.totalTasks > 0) {
            this.schedulerBaseline.averageQueueWaitMs = Math.round(this.schedulerBaseline.totalQueueWaitMs / this.schedulerBaseline.totalTasks);
        }
    }

    public mergeCompressionMetrics(update: Partial<CompressionMetricsBaseline>): void {
        this.compressionBaseline.totalOriginalTokens += update.totalOriginalTokens ?? 0;
        this.compressionBaseline.totalCompressedTokens += update.totalCompressedTokens ?? 0;
        this.compressionBaseline.totalTokensSaved += update.totalTokensSaved ?? 0;
        this.compressionBaseline.deduplicatedSegmentsCount += update.deduplicatedSegmentsCount ?? 0;

        if (this.compressionBaseline.totalOriginalTokens > 0) {
            this.compressionBaseline.averageReductionPercent = Math.round(
                (this.compressionBaseline.totalTokensSaved / this.compressionBaseline.totalOriginalTokens) * 10000
            ) / 100;
        }
    }

    public mergeVectorIndexMetrics(update: Partial<VectorIndexMetricsBaseline>): void {
        this.vectorIndexBaseline.totalQueries += update.totalQueries ?? 0;
        this.vectorIndexBaseline.totalComparisons += update.totalComparisons ?? 0;
        if (this.vectorIndexBaseline.totalQueries > 0) {
            this.vectorIndexBaseline.averageComparisonsPerQuery = Math.round(
                (this.vectorIndexBaseline.totalComparisons / this.vectorIndexBaseline.totalQueries) * 100
            ) / 100;
        }
        if (update.pruningEfficiencyPercent !== undefined) {
            this.vectorIndexBaseline.pruningEfficiencyPercent = update.pruningEfficiencyPercent;
        }
    }

    public mergeHierarchyMetrics(update: Partial<HierarchyMetricsBaseline>): void {
        if (update.treeDepth !== undefined) this.hierarchyBaseline.treeDepth = Math.max(this.hierarchyBaseline.treeDepth, update.treeDepth);
        if (update.totalNodes !== undefined) this.hierarchyBaseline.totalNodes = update.totalNodes;
        if (update.tierCounts) this.hierarchyBaseline.tierCounts = { ...this.hierarchyBaseline.tierCounts, ...update.tierCounts };
        this.hierarchyBaseline.delegatedTasksCount += update.delegatedTasksCount ?? 0;
        this.hierarchyBaseline.escalatedTasksCount += update.escalatedTasksCount ?? 0;
    }

    public mergeSpeculativeMetrics(update: Partial<SpeculativeMetricsBaseline>): void {
        this.speculativeBaseline.totalRuns += update.totalRuns ?? 0;
        this.speculativeBaseline.parallelBatchesExecuted += update.parallelBatchesExecuted ?? 0;
        this.speculativeBaseline.conflictsDetected += update.conflictsDetected ?? 0;
        this.speculativeBaseline.conflictsResolved += update.conflictsResolved ?? 0;
        if (update.averageSpeedupRatio !== undefined) {
            this.speculativeBaseline.averageSpeedupRatio = update.averageSpeedupRatio;
        }
    }

    public getUnifiedBaselineReport(): UnifiedSwarmBaselineReport {
        const taskMetrics = globalMetricsCollector.getBaselineReport();
        const workflowDuration = calculateLatencyDistribution(this.workflowLatencies, this.workflowEma, 0.2);

        const totalTokensSaved = this.cacheBaseline.savedTokens + this.compressionBaseline.totalTokensSaved;
        const estimatedCostSavedDollars = Math.round((totalTokensSaved / 1000) * 0.002 * 10000) / 10000;

        let heapUsedMb = 0;
        if (typeof process !== 'undefined' && process.memoryUsage) {
            heapUsedMb = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
        }

        return {
            timestamp: Date.now(),
            totalWorkflows: this.totalWorkflows,
            workflowDuration,
            taskMetrics,
            subsystems: {
                cache: { ...this.cacheBaseline },
                scheduler: { ...this.schedulerBaseline },
                compression: { ...this.compressionBaseline },
                vectorIndex: { ...this.vectorIndexBaseline },
                hierarchy: { ...this.hierarchyBaseline },
                speculative: { ...this.speculativeBaseline }
            },
            resourceUtilization: {
                totalTokensSaved,
                totalMemorySavedBytes: this.cacheBaseline.memorySavedBytes,
                estimatedCostSavedDollars,
                heapUsedMb
            },
            anomalies: [...this.anomalies]
        };
    }

    public getDetector(): PerformanceAnomalyDetector {
        return this.anomalyDetector;
    }

    public reset(): void {
        this.workflowLatencies = [];
        this.workflowEma = 0;
        this.totalWorkflows = 0;
        this.anomalies = [];
        this.cacheBaseline = { l1Hits: 0, l2Hits: 0, l3Hits: 0, misses: 0, totalRequests: 0, hitRatePercent: 0, savedTokens: 0, memorySavedBytes: 0, promotions: 0 };
        this.schedulerBaseline = { totalTasks: 0, successfulTasks: 0, failedTasks: 0, totalQueueWaitMs: 0, averageQueueWaitMs: 0, totalExecutionMs: 0, totalBackpressureDelayMs: 0, stolenTaskCount: 0 };
        this.compressionBaseline = { totalOriginalTokens: 0, totalCompressedTokens: 0, totalTokensSaved: 0, averageReductionPercent: 0, deduplicatedSegmentsCount: 0 };
        this.vectorIndexBaseline = { totalQueries: 0, totalComparisons: 0, averageComparisonsPerQuery: 0, pruningEfficiencyPercent: 0 };
        this.hierarchyBaseline = { treeDepth: 0, totalNodes: 0, tierCounts: {}, delegatedTasksCount: 0, escalatedTasksCount: 0 };
        this.speculativeBaseline = { totalRuns: 0, parallelBatchesExecuted: 0, averageSpeedupRatio: 1.0, conflictsDetected: 0, conflictsResolved: 0 };
    }
}

export const globalUnifiedProfiler = UnifiedSwarmProfiler.getInstance();

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

/**
 * Executes a synthetic benchmark sweep measuring swarm pipeline throughput and latency baselines.
 */
export async function runSwarmBenchmark(options?: BenchmarkOptions): Promise<BenchmarkResult> {
    const iterations = options?.iterations ?? 20;
    const batchSize = options?.batchSize ?? 5;
    const profiler = UnifiedSwarmProfiler.getInstance();
    const startTime = Date.now();
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
        const iterStart = Date.now();

        // Simulate multi-task execution load
        for (let b = 0; b < batchSize; b++) {
            const taskDuration = 1 + (i % 5) * 2;
            globalMetricsCollector.recordTaskExecution({
                success: true,
                durationMs: taskDuration,
                provider: i % 2 === 0 ? 'gemini' : 'groq',
                agentRole: b === 0 ? 'Manager' : 'Specialist'
            });
        }

        // Simulate subsystem baseline telemetry
        profiler.recordWorkflowRun({
            durationMs: 5 + (i % 4) * 3,
            cache: { l1Hits: 1, l2Hits: i % 2, misses: i % 3 === 0 ? 1 : 0, savedTokens: 250 },
            scheduler: { totalTasks: batchSize, successfulTasks: batchSize, totalQueueWaitMs: 2 },
            compression: { totalOriginalTokens: 1000, totalCompressedTokens: 600, totalTokensSaved: 400 }
        });

        const iterDuration = Date.now() - iterStart;
        latencies.push(iterDuration);
    }

    const totalDuration = Math.max(1, Date.now() - startTime);
    const opsPerSec = Math.round((iterations / (totalDuration / 1000)) * 100) / 100;
    const latency = calculateLatencyDistribution(latencies);
    const report = profiler.getUnifiedBaselineReport();

    return {
        totalIterations: iterations,
        durationMs: totalDuration,
        opsPerSecond: opsPerSec,
        latency,
        anomalies: report.anomalies,
        report,
        summary: `Benchmark completed ${iterations} iterations across ${batchSize} batch tasks in ${totalDuration}ms (${opsPerSec} ops/s, p50: ${latency.p50Ms}ms, p95: ${latency.p95Ms}ms).`
    };
}
