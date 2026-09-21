import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine/index.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('SwarmEngine: Speculative Parallel Execution & Conflict Resolution Integration', () => {
    beforeEach(() => {
        ProviderRegistry.register({
            providerName: 'mock-speculative',
            async call(options) {
                const prompt = options.prompt || '';
                if (options.systemInstruction?.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Speculative Synthesis Dashboard',
                        components: [
                            {
                                id: 'summary-card',
                                type: 'MetricCard',
                                props: { title: 'Speculative Speedup', value: '45%' }
                            }
                        ]
                    });
                }

                // Analyst response with slight delay to model execution
                await new Promise(r => setTimeout(r, 20));

                if (prompt.includes('Chunk 1')) {
                    return JSON.stringify({
                        insights: ['Database connection pool utilization at 85% in primary shard'],
                        anomalies: ['High write lock contention detected on accounts table'],
                        summary: 'Primary shard under contention'
                    });
                } else if (prompt.includes('Chunk 2')) {
                    return JSON.stringify({
                        insights: ['Replica latency is nominal and replication lag is 2ms'],
                        anomalies: [],
                        summary: 'Replication healthy'
                    });
                }

                return JSON.stringify({
                    insights: ['Nominal telemetry across evaluated partition'],
                    anomalies: [],
                    summary: 'Partition nominal'
                });
            }
        });
    });

    it('executes multi-chunk workloads speculatively in parallel and emits telemetry', async () => {
        // Multi-chunk dataset (> 32,000 chars per shard) to trigger chunk splitting
        const chunkContent1 = 'Server US-East telemetry region latency database query status ok normal\n'.repeat(500);
        const chunkContent2 = 'Server EU-Central telemetry region latency database query status ok normal\n'.repeat(500);
        const data = `${chunkContent1}\n${chunkContent2}`;

        const result = await executeSwarmWorkflow({
            task: 'Analyze regional latency and database contention',
            data,
            forceFullSwarm: true,
            settings: {
                speculativeParallel: true,
                maxSpeculativeConcurrency: 3,
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'mock-speculative', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'db-analyst', role: 'Database Specialist', provider: 'mock-speculative', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'perf-analyst', role: 'Performance Engineer', provider: 'mock-speculative', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.finalAnalysis.ui_title).toContain('Speculative');

        // Check for Speculative Parallel Execution event
        const specEvent = result.events.find(e => e.action === 'Speculative Parallel Execution');
        expect(specEvent).toBeDefined();
        expect(specEvent?.output?.totalChunks).toBeGreaterThan(1);
        expect(specEvent?.output?.concurrencyPeak).toBeGreaterThanOrEqual(1);
        expect(specEvent?.output?.latencyReductionPercent).toBeGreaterThanOrEqual(40);
    });

    it('falls back to sequential execution when speculativeParallel is false', async () => {
        const chunkContent1 = 'System log item status ok nominal code check\n'.repeat(500);
        const chunkContent2 = 'System log item status ok nominal code check\n'.repeat(500);
        const data = `${chunkContent1}\n${chunkContent2}`;

        const result = await executeSwarmWorkflow({
            task: 'Sequential execution fallback check',
            data,
            forceFullSwarm: true,
            settings: {
                speculativeParallel: false,
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'mock-speculative', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst', role: 'Infrastructure Specialist', provider: 'mock-speculative', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();

        // Verify Speculative event is NOT emitted
        const specEvent = result.events.find(e => e.action === 'Speculative Parallel Execution');
        expect(specEvent).toBeUndefined();

        // Verify legacy Batch Delay event IS emitted
        const delayEvent = result.events.find(e => e.action === 'Batch Delay');
        expect(delayEvent).toBeDefined();
    });
});
