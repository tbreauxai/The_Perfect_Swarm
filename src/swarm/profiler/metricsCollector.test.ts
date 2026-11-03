import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    calculateLatencyDistribution,
    SwarmMetricsCollector,
    globalMetricsCollector,
    SwarmTracer
} from './metricsCollector.ts';

describe('MetricsCollector', () => {
    describe('calculateLatencyDistribution', () => {
        it('returns zeroed distribution for empty input', () => {
            const result = calculateLatencyDistribution([]);
            expect(result.sampleCount).toBe(0);
            expect(result.avgMs).toBe(0);
            expect(result.minMs).toBe(0);
            expect(result.maxMs).toBe(0);
        });

        it('calculates distribution correctly for a single item', () => {
            const result = calculateLatencyDistribution([100]);
            expect(result.sampleCount).toBe(1);
            expect(result.avgMs).toBe(100);
            expect(result.minMs).toBe(100);
            expect(result.maxMs).toBe(100);
            expect(result.p50Ms).toBe(100);
            expect(result.p90Ms).toBe(100);
            expect(result.p95Ms).toBe(100);
            expect(result.p99Ms).toBe(100);
        });

        it('calculates distribution correctly for multiple items', () => {
            const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
            const result = calculateLatencyDistribution(latencies);
            expect(result.sampleCount).toBe(10);
            expect(result.minMs).toBe(10);
            expect(result.maxMs).toBe(100);
            expect(result.avgMs).toBe(55); // (10+...100)/10 = 55
            expect(result.p50Ms).toBe(50);
            expect(result.p90Ms).toBe(90);
            expect(result.p95Ms).toBe(100); // gets rounded to next nearest index based on logic
            expect(result.p99Ms).toBe(100);
        });

        it('uses currentEma correctly', () => {
            const result = calculateLatencyDistribution([], 55);
            expect(result.emaMs).toBe(55);
        });
    });

    describe('SwarmMetricsCollector', () => {
        let collector: SwarmMetricsCollector;

        beforeEach(() => {
            collector = SwarmMetricsCollector.getInstance();
            collector.reset();
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
            expect(report.overallLatency.avgMs).toBe(100);
        });

        it('records failed task execution', () => {
            collector.recordTaskExecution({
                success: false,
                durationMs: 150
            });
            const report = collector.getBaselineReport();
            expect(report.totalTasks).toBe(1);
            expect(report.successCount).toBe(0);
            expect(report.failureCount).toBe(1);
            expect(report.overallCompletionRatePercent).toBe(0);
        });

        it('records provider metrics correctly', () => {
            collector.recordTaskExecution({
                success: true,
                durationMs: 200,
                provider: 'OpenAI'
            });
            collector.recordTaskExecution({
                success: false,
                durationMs: 300,
                provider: 'OpenAI',
                error: 'Timeout'
            });

            const report = collector.getBaselineReport();
            const providerMetrics = report.providers['openai']; // keys are lowercased

            expect(providerMetrics).toBeDefined();
            expect(providerMetrics.totalTasks).toBe(2);
            expect(providerMetrics.successCount).toBe(1);
            expect(providerMetrics.failureCount).toBe(1);
            expect(providerMetrics.completionRatePercent).toBe(50);
            expect(providerMetrics.lastError).toBe('Timeout');
            expect(providerMetrics.latency.avgMs).toBe(250);
        });

        it('records agent metrics correctly', () => {
            collector.recordTaskExecution({
                success: true,
                durationMs: 150,
                agentRole: 'Critic'
            });

            const report = collector.getBaselineReport();
            const agentMetrics = report.agents['Critic']; // agents are not lowercased

            expect(agentMetrics).toBeDefined();
            expect(agentMetrics.totalTasks).toBe(1);
            expect(agentMetrics.successCount).toBe(1);
            expect(agentMetrics.latency.avgMs).toBe(150);
        });

        it('caps latencies array at 1000', () => {
            for (let i = 0; i < 1005; i++) {
                collector.recordTaskExecution({ success: true, durationMs: 10 });
            }
            const report = collector.getBaselineReport();
            expect(report.overallLatency.sampleCount).toBe(1000);
        });

        it('calculates completion rate to 2 decimal places properly', () => {
            // 2 successes, 1 failure -> 66.67%
            collector.recordTaskExecution({ success: true, durationMs: 10 });
            collector.recordTaskExecution({ success: true, durationMs: 10 });
            collector.recordTaskExecution({ success: false, durationMs: 10 });

            const report = collector.getBaselineReport();
            expect(report.overallCompletionRatePercent).toBe(66.67);
        });

        it('getSnapshot returns same data as getBaselineReport', () => {
            collector.recordTaskExecution({ success: true, durationMs: 100 });
            const snapshot = collector.getSnapshot();
            const report = collector.getBaselineReport();

            expect(snapshot.totalTasks).toBe(report.totalTasks);
            expect(snapshot.overallCompletionRatePercent).toBe(report.overallCompletionRatePercent);
        });

        it('calculates overall EMA correctly', () => {
            // 1st task: EMA = 100
            collector.recordTaskExecution({ success: true, durationMs: 100 });
            // 2nd task (alpha = 0.2): EMA = (0.2 * 200) + (0.8 * 100) = 40 + 80 = 120
            collector.recordTaskExecution({ success: true, durationMs: 200 });

            const report = collector.getBaselineReport();
            expect(report.overallLatency.emaMs).toBe(120);
        });
    });

    describe('SwarmTracer', () => {
        let tracer: SwarmTracer;

        beforeEach(() => {
            tracer = SwarmTracer.getInstance();
            tracer.clear();
            globalMetricsCollector.reset(); // clear global metrics collector too
        });

        it('logs event and injects id and timestamp', () => {
            tracer.logEvent({
                payload: { traceId: 'trace-1' },
                action: 'START'
            });
            const events = tracer.dumpTrace();
            expect(events.length).toBe(1);
            expect(events[0].id).toBeDefined();
            expect(events[0].timestamp).toBeDefined();
            expect(events[0].action).toBe('START');
        });

        it('auto-instruments metrics when durationMs is present and success', () => {
            tracer.logEvent({
                payload: { traceId: 'trace-2' },
                action: 'LLM_CALL',
                durationMs: 500,
                provider: 'anthropic',
                agentRole: 'Worker'
            });

            const report = globalMetricsCollector.getBaselineReport();
            expect(report.totalTasks).toBe(1);
            expect(report.successCount).toBe(1);
            expect(report.providers['anthropic']).toBeDefined();
            expect(report.agents['Worker']).toBeDefined();
        });

        it('auto-instruments metrics as failure if error is present', () => {
            tracer.logEvent({
                payload: { traceId: 'trace-3' },
                action: 'LLM_CALL',
                durationMs: 200,
                error: 'Rate limit exceeded'
            });

            const report = globalMetricsCollector.getBaselineReport();
            expect(report.totalTasks).toBe(1);
            expect(report.successCount).toBe(0);
            expect(report.failureCount).toBe(1);
        });

        it('auto-instruments metrics as failure if action contains failed', () => {
            tracer.logEvent({
                payload: { traceId: 'trace-4' },
                action: 'LLM_CALL_FAILED',
                durationMs: 200,
            });

            const report = globalMetricsCollector.getBaselineReport();
            expect(report.totalTasks).toBe(1);
            expect(report.successCount).toBe(0);
            expect(report.failureCount).toBe(1);
        });

        it('invokes callback when set', () => {
            const cb = vi.fn();
            tracer.setCallback(cb);

            tracer.logEvent({
                payload: { traceId: 'trace-4' },
                action: 'TEST'
            });

            expect(cb).toHaveBeenCalledTimes(1);
            const calledArg = cb.mock.calls[0][0];
            expect(calledArg.action).toBe('TEST');
            expect(calledArg.id).toBeDefined();
        });

        it('clears trace events', () => {
            tracer.logEvent({ payload: { traceId: 'trace-5' }, action: 'DUMMY' });
            expect(tracer.dumpTrace().length).toBe(1);

            tracer.clear();
            expect(tracer.dumpTrace().length).toBe(0);
        });
    });
});
