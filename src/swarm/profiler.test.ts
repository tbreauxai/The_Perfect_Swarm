import { describe, it, expect } from 'vitest';
import { createTokenChunks, profileData, calculateLatencyDistribution, SwarmMetricsCollector, globalMetricsCollector, SwarmTracer } from './profiler';

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
