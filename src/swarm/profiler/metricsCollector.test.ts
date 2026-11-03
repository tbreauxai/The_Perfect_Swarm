import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    calculateLatencyDistribution,
    SwarmMetricsCollector,
    globalMetricsCollector,
    SwarmTracer
} from './metricsCollector';
import type { TraceEvent } from './types';

describe('MetricsCollector Module', () => {
    describe('calculateLatencyDistribution', () => {
        it('returns zeroed distribution for empty latencies', () => {
            const dist = calculateLatencyDistribution([]);
            expect(dist).toEqual({
                minMs: 0,
                maxMs: 0,
                avgMs: 0,
                p50Ms: 0,
                p90Ms: 0,
                p95Ms: 0,
                p99Ms: 0,
                emaMs: 0,
                sampleCount: 0
            });
        });

        it('returns zeroed distribution for null/undefined latencies', () => {
            // @ts-ignore
            const dist = calculateLatencyDistribution(null);
            expect(dist.sampleCount).toBe(0);
        });

        it('calculates statistics correctly for valid latencies', () => {
            const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
            const dist = calculateLatencyDistribution(latencies, 20, 0.2);

            expect(dist.sampleCount).toBe(10);
            expect(dist.minMs).toBe(10);
            expect(dist.maxMs).toBe(100);
            expect(dist.avgMs).toBe(55); // (10+...)/10 = 550/10 = 55
            expect(dist.p50Ms).toBe(50); // index 4
            expect(dist.p90Ms).toBe(90); // index 8
            expect(dist.p95Ms).toBe(100); // index 9
            expect(dist.p99Ms).toBe(100); // index 9
            expect(dist.emaMs).toBe(20);
        });

        it('calculates correctly for single latency', () => {
            const latencies = [42];
            const dist = calculateLatencyDistribution(latencies, 15, 0.2);

            expect(dist.sampleCount).toBe(1);
            expect(dist.minMs).toBe(42);
            expect(dist.maxMs).toBe(42);
            expect(dist.avgMs).toBe(42);
            expect(dist.p50Ms).toBe(42);
            expect(dist.p99Ms).toBe(42);
            expect(dist.emaMs).toBe(15);
        });
    });

    describe('SwarmMetricsCollector', () => {
        let collector: SwarmMetricsCollector;

        beforeEach(() => {
            // Test singleton pattern but allow resetting state
            collector = SwarmMetricsCollector.getInstance();
            collector.reset();
        });

        it('implements singleton pattern', () => {
            const instance1 = SwarmMetricsCollector.getInstance();
            const instance2 = SwarmMetricsCollector.getInstance();
            expect(instance1).toBe(instance2);
        });

        it('records successful task execution', () => {
            collector.recordTaskExecution({
                success: true,
                durationMs: 100
            });

            const report = collector.getBaselineReport();
            expect(report.totalTasks).toBe(1);
            expect(report.successCount).toBe(1);
            expect(report.failureCount).toBe(0);
            expect(report.overallCompletionRatePercent).toBe(100);
            expect(report.overallLatency.sampleCount).toBe(1);
            expect(report.overallLatency.avgMs).toBe(100);
            expect(report.overallLatency.emaMs).toBe(100); // First value sets EMA directly
        });

        it('records failed task execution', () => {
            collector.recordTaskExecution({
                success: false,
                durationMs: 50
            });

            const report = collector.getBaselineReport();
            expect(report.totalTasks).toBe(1);
            expect(report.successCount).toBe(0);
            expect(report.failureCount).toBe(1);
            expect(report.overallCompletionRatePercent).toBe(0);
            expect(report.overallLatency.sampleCount).toBe(1);
        });

        it('updates overall EMA correctly on subsequent tasks', () => {
            collector.recordTaskExecution({ success: true, durationMs: 100 });
            collector.recordTaskExecution({ success: true, durationMs: 200 }); // (0.2 * 200) + (0.8 * 100) = 40 + 80 = 120

            const report = collector.getBaselineReport();
            expect(report.overallLatency.emaMs).toBe(120);
        });

        it('tracks provider-specific metrics and errors', () => {
            collector.recordTaskExecution({
                success: true,
                durationMs: 150,
                provider: 'OpenAI'
            });

            collector.recordTaskExecution({
                success: false,
                durationMs: 200,
                provider: 'openai', // Case-insensitive handling check (handled via toLowerCase in implementation)
                error: 'Rate limit exceeded'
            });

            const report = collector.getBaselineReport();
            const providerMetrics = report.providers['openai'];
            expect(providerMetrics).toBeDefined();
            expect(providerMetrics.totalTasks).toBe(2);
            expect(providerMetrics.successCount).toBe(1);
            expect(providerMetrics.failureCount).toBe(1);
            expect(providerMetrics.completionRatePercent).toBe(50);
            expect(providerMetrics.lastError).toBe('Rate limit exceeded');
        });

        it('tracks agent-specific metrics', () => {
            collector.recordTaskExecution({
                success: true,
                durationMs: 50,
                agentRole: 'Analyst'
            });

            const report = collector.getBaselineReport();
            const agentMetrics = report.agents['Analyst'];
            expect(agentMetrics).toBeDefined();
            expect(agentMetrics.totalTasks).toBe(1);
            expect(agentMetrics.successCount).toBe(1);
            expect(agentMetrics.failureCount).toBe(0);
        });

        it('getSnapshot returns same as getBaselineReport', () => {
            collector.recordTaskExecution({ success: true, durationMs: 10 });
            const snapshot = collector.getSnapshot();
            const report = collector.getBaselineReport();

            // Omit timestamp for comparison since they might differ by 1ms
            const { timestamp: ts1, ...snapshotWithoutTimestamp } = snapshot;
            const { timestamp: ts2, ...reportWithoutTimestamp } = report;

            expect(snapshotWithoutTimestamp).toEqual(reportWithoutTimestamp);
        });

        it('maintains a bounded latency array', () => {
            for (let i = 0; i < 1050; i++) {
                collector.recordTaskExecution({ success: true, durationMs: 10 });
            }
            const report = collector.getBaselineReport();
            expect(report.overallLatency.sampleCount).toBe(1000);
        });
    });

    describe('SwarmTracer', () => {
        let tracer: SwarmTracer;

        beforeEach(() => {
            tracer = SwarmTracer.getInstance();
            tracer.clear();
            globalMetricsCollector.reset(); // Also reset global collector
        });

        it('implements singleton pattern', () => {
            const instance1 = SwarmTracer.getInstance();
            const instance2 = SwarmTracer.getInstance();
            expect(instance1).toBe(instance2);
        });

        it('logs event with generated ID and timestamp', () => {
            tracer.logEvent({ action: 'Test Action' });

            const trace = tracer.dumpTrace();
            expect(trace.length).toBe(1);
            expect(trace[0].action).toBe('Test Action');
            expect(trace[0].id).toBeDefined();
            expect(typeof trace[0].id).toBe('string');
            expect(trace[0].timestamp).toBeDefined();
            expect(typeof trace[0].timestamp).toBe('number');
        });

        it('triggers callback when event is logged', () => {
            const callback = vi.fn();
            tracer.setCallback(callback);

            tracer.logEvent({ action: 'Callback Test' });

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                action: 'Callback Test',
                id: expect.any(String),
                timestamp: expect.any(Number)
            }));
        });

        it('auto-instruments global metrics when durationMs is provided for success', () => {
            tracer.logEvent({
                action: 'Agent Task Completed',
                durationMs: 250,
                provider: 'Local',
                agentRole: 'Critic'
            });

            const metrics = globalMetricsCollector.getBaselineReport();
            expect(metrics.totalTasks).toBe(1);
            expect(metrics.successCount).toBe(1);
            expect(metrics.overallLatency.sampleCount).toBe(1);
            expect(metrics.overallLatency.avgMs).toBe(250);

            expect(metrics.providers['local']).toBeDefined();
            expect(metrics.agents['Critic']).toBeDefined();
        });

        it('auto-instruments global metrics as failure when error is present', () => {
            tracer.logEvent({
                action: 'Agent Task Errored',
                durationMs: 300,
                error: 'Network Timeout'
            });

            const metrics = globalMetricsCollector.getBaselineReport();
            expect(metrics.totalTasks).toBe(1);
            expect(metrics.successCount).toBe(0);
            expect(metrics.failureCount).toBe(1);
        });

        it('auto-instruments global metrics as failure when action contains "failed"', () => {
            tracer.logEvent({
                action: 'Task Failed During Execution',
                durationMs: 150
            });

            const metrics = globalMetricsCollector.getBaselineReport();
            expect(metrics.totalTasks).toBe(1);
            expect(metrics.failureCount).toBe(1);
        });

        it('clears the trace events', () => {
            tracer.logEvent({ action: 'Event 1' });
            tracer.logEvent({ action: 'Event 2' });

            expect(tracer.dumpTrace().length).toBe(2);

            tracer.clear();

            expect(tracer.dumpTrace().length).toBe(0);
        });
    });
});
