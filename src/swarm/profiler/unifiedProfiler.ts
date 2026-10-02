import type {
    CacheMetricsBaseline,
    SchedulerMetricsBaseline,
    CompressionMetricsBaseline,
    VectorIndexMetricsBaseline,
    HierarchyMetricsBaseline,
    SpeculativeMetricsBaseline,
    PerformanceAnomaly,
    UnifiedSwarmBaselineReport,
    BenchmarkOptions,
    BenchmarkResult
} from './types.ts';
import { calculateLatencyDistribution, globalMetricsCollector } from './metricsCollector.ts';
import { PerformanceAnomalyDetector } from './anomalyDetector.ts';

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
