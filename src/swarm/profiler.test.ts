import { describe, it, expect } from 'vitest';
import {
    createTokenChunks,
    profileData,
    calculateLatencyDistribution,
    SwarmMetricsCollector,
    globalMetricsCollector,
    SwarmTracer,
    UnifiedSwarmProfiler,
    PerformanceAnomalyDetector,
    runSwarmBenchmark
} from './profiler';

describe('Token Budget & Metadata Chunk Preservation', () => {
    it('creates token chunks with expanded capacity (up to 8 chunks by default)', () => {
        // Generate a large payload that exceeds 4 chunks
        const longLine = 'data_row_key_value_metric_item_telemetry_indicator_'.repeat(100); // ~5000 chars = ~1250 tokens per line
        const lines: string[] = [];
        for (let i = 0; i < 40; i++) {
            lines.push(`Line ${i}: ${longLine}`);
        }
        const largePayload = lines.join('\n');

        const result = createTokenChunks(largePayload);

        // Under expanded capacity, it should support more than 4 chunks without immediately truncating to 4
        expect(result.chunks.length).toBeGreaterThan(4);
        expect(result.chunks.length).toBeLessThanOrEqual(8);
        expect(result.originalChunkCount).toBeGreaterThanOrEqual(result.chunks.length);
    });

    it('preserves metadata from beginning and end of deep payloads when maxChunks is reached', () => {
        // Generate a deep payload where important summary metadata is at the end
        const lines: string[] = [];
        lines.push('START_METADATA_HEADER: Initial schema setup');
        for (let i = 0; i < 60; i++) {
            lines.push(`Row ${i}: ` + 'repeated_data_metrics_log_entry_'.repeat(80));
        }
        lines.push('END_METADATA_TRAILER: Critical performance summary at end of file');
        const deepPayload = lines.join('\n');

        // With maxChunks = 4, the critical end metadata trailer must not be discarded
        const result = createTokenChunks(deepPayload, 2000, 4);

        expect(result.chunks.length).toBe(4);
        const combinedContent = result.chunks.join('\n');
        expect(combinedContent).toContain('START_METADATA_HEADER');
        expect(combinedContent).toContain('END_METADATA_TRAILER');
    });
});

describe('Key Metrics & Latency Baseline Instrumentation', () => {
    it('accurately computes latency distribution percentiles (p50, p90, p95, p99, EMA)', () => {
        // 100 sample latencies from 1ms to 100ms
        const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
        const dist = calculateLatencyDistribution(latencies, 50, 0.2);

        expect(dist.minMs).toBe(1);
        expect(dist.maxMs).toBe(100);
        expect(dist.avgMs).toBe(51);
        expect(dist.p50Ms).toBe(50);
        expect(dist.p90Ms).toBe(90);
        expect(dist.p95Ms).toBe(95);
        expect(dist.p99Ms).toBe(99);
        expect(dist.sampleCount).toBe(100);
    });

    it('handles empty latency distribution gracefully', () => {
        const dist = calculateLatencyDistribution([]);
        expect(dist.minMs).toBe(0);
        expect(dist.maxMs).toBe(0);
        expect(dist.avgMs).toBe(0);
        expect(dist.p50Ms).toBe(0);
        expect(dist.p95Ms).toBe(0);
        expect(dist.sampleCount).toBe(0);
    });

    it('instruments task completion rate and per-provider/agent baselines in SwarmMetricsCollector', () => {
        const collector = new SwarmMetricsCollector();

        // 8 successful tasks, 2 failures = 80% completion rate
        collector.recordTaskExecution({ success: true, durationMs: 100, provider: 'gemini', agentRole: 'Manager' });
        collector.recordTaskExecution({ success: true, durationMs: 150, provider: 'gemini', agentRole: 'Manager' });
        collector.recordTaskExecution({ success: true, durationMs: 200, provider: 'groq', agentRole: 'Analyst' });
        collector.recordTaskExecution({ success: false, durationMs: 300, provider: 'groq', agentRole: 'Analyst', error: 'Rate limit' });
        collector.recordTaskExecution({ success: true, durationMs: 120, provider: 'mistral', agentRole: 'Critic' });

        const report = collector.getBaselineReport();

        expect(report.totalTasks).toBe(5);
        expect(report.successCount).toBe(4);
        expect(report.failureCount).toBe(1);
        expect(report.overallCompletionRatePercent).toBe(80);

        // Verify provider breakdown
        expect(report.providers['gemini'].totalTasks).toBe(2);
        expect(report.providers['gemini'].completionRatePercent).toBe(100);
        expect(report.providers['gemini'].latency.p50Ms).toBe(100);

        expect(report.providers['groq'].totalTasks).toBe(2);
        expect(report.providers['groq'].completionRatePercent).toBe(50);
        expect(report.providers['groq'].lastError).toBe('Rate limit');

        // Verify agent breakdown
        expect(report.agents['Manager'].totalTasks).toBe(2);
        expect(report.agents['Analyst'].totalTasks).toBe(2);
        expect(report.agents['Critic'].totalTasks).toBe(1);
    });

    it('auto-instruments metrics from SwarmTracer duration events', () => {
        globalMetricsCollector.reset();
        const tracer = SwarmTracer.getInstance();

        tracer.logEvent({
            action: 'Completed execution',
            durationMs: 85,
            provider: 'test-prov',
            agentRole: 'Test Role'
        });

        const report = globalMetricsCollector.getBaselineReport();
        expect(report.totalTasks).toBeGreaterThanOrEqual(1);
        expect(report.providers['test-prov']).toBeDefined();
        expect(report.providers['test-prov'].latency.minMs).toBe(85);
    });
});

describe('Unified Swarm Profiler & Subsystem Baseline Aggregation', () => {
    it('aggregates multi-subsystem baselines into unified report', () => {
        const profiler = new UnifiedSwarmProfiler();
        profiler.reset();

        profiler.recordWorkflowRun({
            durationMs: 120,
            cache: { l1Hits: 5, l2Hits: 3, misses: 2, savedTokens: 500, memorySavedBytes: 2048, promotions: 1 },
            scheduler: { totalTasks: 10, successfulTasks: 10, failedTasks: 0, totalQueueWaitMs: 50, totalExecutionMs: 110, stolenTaskCount: 2 },
            compression: { totalOriginalTokens: 4000, totalCompressedTokens: 2500, totalTokensSaved: 1500, deduplicatedSegmentsCount: 4 },
            vectorIndex: { totalQueries: 8, totalComparisons: 24, pruningEfficiencyPercent: 70 },
            hierarchy: { treeDepth: 3, totalNodes: 6, delegatedTasksCount: 5, escalatedTasksCount: 1 },
            speculative: { totalRuns: 1, parallelBatchesExecuted: 2, averageSpeedupRatio: 1.8 }
        });

        const report = profiler.getUnifiedBaselineReport();

        expect(report.totalWorkflows).toBe(1);
        expect(report.workflowDuration.avgMs).toBe(120);

        // Cache checks
        expect(report.subsystems.cache?.l1Hits).toBe(5);
        expect(report.subsystems.cache?.hitRatePercent).toBe(80); // (5+3)/(5+3+2) = 8/10 = 80%
        expect(report.subsystems.cache?.memorySavedBytes).toBe(2048);

        // Scheduler checks
        expect(report.subsystems.scheduler?.totalTasks).toBe(10);
        expect(report.subsystems.scheduler?.averageQueueWaitMs).toBe(5); // 50 / 10
        expect(report.subsystems.scheduler?.stolenTaskCount).toBe(2);

        // Compression checks
        expect(report.subsystems.compression?.totalTokensSaved).toBe(1500);
        expect(report.subsystems.compression?.averageReductionPercent).toBe(37.5); // 1500 / 4000 = 37.5%

        // Vector index checks
        expect(report.subsystems.vectorIndex?.averageComparisonsPerQuery).toBe(3); // 24 / 8
        expect(report.subsystems.vectorIndex?.pruningEfficiencyPercent).toBe(70);

        // Hierarchy & Speculative
        expect(report.subsystems.hierarchy?.treeDepth).toBe(3);
        expect(report.subsystems.speculative?.averageSpeedupRatio).toBe(1.8);

        // Resource utilization
        expect(report.resourceUtilization.totalTokensSaved).toBe(2000); // 500 (cache) + 1500 (compression)
        expect(report.resourceUtilization.estimatedCostSavedDollars).toBeGreaterThan(0);
    });
});

describe('Performance Anomaly & Latency Drift Detection', () => {
    it('calibrates baseline distributions and flags critical latency anomalies', () => {
        const detector = new PerformanceAnomalyDetector();
        // Calibrate with latencies 10ms..50ms
        const samples = Array.from({ length: 100 }, (_, i) => 10 + Math.floor(i * 0.4));
        detector.calibrate(samples);

        const bounds = detector.getBaselines();
        expect(bounds.p95).toBeGreaterThan(0);
        expect(bounds.p99).toBeGreaterThan(0);

        // Nominal latency should return null
        expect(detector.checkLatency('engine', bounds.p95)).toBeNull();

        // Warning latency (>1.5x p95)
        const warning = detector.checkLatency('engine', bounds.p95 * 1.6);
        expect(warning).not.toBeNull();
        expect(warning?.severity).toBe('warning');

        // Critical latency (>2.0x p99)
        const critical = detector.checkLatency('engine', bounds.p99 * 2.5);
        expect(critical).not.toBeNull();
        expect(critical?.severity).toBe('critical');
    });
});

describe('Swarm Benchmark Harness & Synthetic Workload Profiling', () => {
    it('executes synthetic benchmark sweep and produces verified ops/sec and baseline report', async () => {
        const result = await runSwarmBenchmark({
            iterations: 10,
            batchSize: 3
        });

        expect(result.totalIterations).toBe(10);
        expect(result.durationMs).toBeGreaterThan(0);
        expect(result.opsPerSecond).toBeGreaterThan(0);
        expect(result.latency.sampleCount).toBe(10);
        expect(result.report.totalWorkflows).toBeGreaterThanOrEqual(10);
        expect(result.summary).toContain('Benchmark completed');
    });
});
