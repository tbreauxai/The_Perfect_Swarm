import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine/index.ts';
import { ProviderRegistry } from './providers/registry';
import { globalUnifiedProfiler, globalMetricsCollector, PerformanceAnomalyDetector } from './profiler';
import { globalTieredCache } from './tieredCache';

describe('SwarmEngine: Baseline Profiling & Metrics Collection Integration', () => {
    beforeEach(() => {
        globalUnifiedProfiler.reset();
        globalMetricsCollector.reset();
        globalTieredCache.clear();

        ProviderRegistry.register({
            providerName: 'mock-profiler-provider',
            async call(options) {
                return JSON.stringify({
                    ui_title: 'Profiler Analysis Test',
                    components: [
                        { id: '1', type: 'InsightList', props: { title: 'Insights', insights: [{ type: 'info', message: 'Operational nominal' }] } }
                    ]
                });
            }
        });
    });

    it('attaches unifiedBaselines to workflow result when profiling is enabled', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Profile system resource baseline',
            data: 'status=healthy, load=0.15',
            settings: {
                profilingSettings: { enabled: true },
                agents: [
                    { id: 'p-mgr', role: 'Manager Node', provider: 'mock-profiler-provider', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.unifiedBaselines).toBeDefined();
        expect(result.unifiedBaselines?.totalWorkflows).toBeGreaterThanOrEqual(1);
        expect(result.unifiedBaselines?.workflowDuration.sampleCount).toBeGreaterThanOrEqual(1);
        expect(result.unifiedBaselines?.taskMetrics).toBeDefined();
        expect(result.unifiedBaselines?.resourceUtilization).toBeDefined();
    });

    it('omits unifiedBaselines when profilingSettings.enabled is explicitly false', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Disable profiling test',
            data: 'test=off',
            settings: {
                profilingSettings: { enabled: false },
                agents: [
                    { id: 'p-mgr', role: 'Manager Node', provider: 'mock-profiler-provider', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.unifiedBaselines).toBeUndefined();
    });

    it('records tiered cache hit telemetry into unifiedBaselines', async () => {
        const query = 'cached tiered query for profiling';
        globalTieredCache.set(query, {
            ui_title: 'Tiered Cached Profiler Result',
            components: []
        });

        const result = await executeSwarmWorkflow({
            task: query,
            data: '',
            settings: {
                forceFullSwarm: false,
                tieredCacheSettings: { enabled: true },
                profilingSettings: { enabled: true },
                agents: [
                    { id: 'p-mgr', role: 'Manager Node', provider: 'mock-profiler-provider', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.tieredCache?.hit).toBe(true);
        expect(result.unifiedBaselines).toBeDefined();
        expect(result.unifiedBaselines?.subsystems.cache?.l1Hits).toBeGreaterThanOrEqual(1);
    });

    it('detects latency anomalies using PerformanceAnomalyDetector on elevated latency', () => {
        const detector = new PerformanceAnomalyDetector();
        const baseSamples = [5, 6, 7, 5, 6, 8, 7, 6, 5, 7, 6, 5];
        detector.calibrate(baseSamples);

        const bounds = detector.getBaselines();
        expect(bounds.p95).toBeGreaterThan(0);

        const anomaly = detector.checkLatency('CustomSubsystem', bounds.p95 * 2.5);
        expect(anomaly).not.toBeNull();
        expect(anomaly?.subsystem).toBe('CustomSubsystem');
    });
});
