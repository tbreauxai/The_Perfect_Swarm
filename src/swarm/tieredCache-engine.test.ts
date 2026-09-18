import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow, SwarmEngine } from './engine.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { globalTieredCache } from './tieredCache.ts';

describe('SwarmEngine: Tiered Caching & State-Compression Integration', () => {
    beforeEach(() => {
        globalTieredCache.clear();

        ProviderRegistry.register({
            providerName: 'tiered-mock',
            async call(options) {
                const prompt = options.prompt || '';
                const systemInst = options.systemInstruction || '';

                if (systemInst.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Tiered Cache Synthesis Dashboard',
                        components: [
                            {
                                id: 'c1',
                                type: 'InsightList',
                                props: {
                                    title: 'Cached Findings',
                                    insights: [
                                        { type: 'info', message: 'Engine execution produced new cached synthesis' }
                                    ]
                                }
                            }
                        ]
                    });
                }

                if (systemInst.includes('Critic') || prompt.includes('Verify whether this analysis faithfully represents')) {
                    return JSON.stringify({
                        pass: true,
                        computedRating: 95,
                        criticFeedback: 'Tiered caching analysis verified.'
                    });
                }

                return JSON.stringify({
                    summary: 'Specialist analysis nominal.',
                    insights: ['Resource patterns healthy', 'No memory leaks detected'],
                    anomalies: []
                });
            }
        });
    });

    it('populates cache on first run and serves subsequent identical requests from L1 Hot Cache', async () => {
        const task = 'Audit redis cluster memory usage and connection counts';
        const data = 'redis_01: 4.2GB RAM, 850 connections; redis_02: 3.8GB RAM, 720 connections';

        // 1st Execution: Cache Miss
        const res1 = await executeSwarmWorkflow({
            task,
            data,
            forceFullSwarm: true,
            settings: {
                tieredCacheSettings: {
                    enabled: true,
                    enableStateSnapshots: true
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'perf', role: 'Performance Engineer', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });

        expect(res1).toBeDefined();
        expect(res1.finalAnalysis).toBeDefined();
        expect(res1.tieredCache).toBeDefined();
        expect(res1.tieredCache!.hit).toBe(false);
        expect(res1.tieredCache!.snapshotId).toBeDefined();

        // Verify state snapshot event was emitted
        const snapEvents = res1.events.filter(e => e.action === 'State Snapshot Compressed');
        expect(snapEvents.length).toBe(1);
        expect(snapEvents[0].output.reductionPercent).toBeGreaterThanOrEqual(0);

        // 2nd Execution: L1 Hot Cache Hit
        const res2 = await executeSwarmWorkflow({
            task,
            data,
            settings: {
                tieredCacheSettings: {
                    enabled: true
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'perf', role: 'Performance Engineer', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });

        expect(res2).toBeDefined();
        expect(res2.tieredCache).toBeDefined();
        expect(res2.tieredCache!.hit).toBe(true);
        expect(res2.tieredCache!.tier).toBe('L1');
        expect(res2.finalAnalysis.ui_title).toBe('Tiered Cache Synthesis Dashboard');

        // Verify telemetry event for L1 hit
        const hitEvents = res2.events.filter(e => e.action === 'Tiered Cache Hit (L1)');
        expect(hitEvents.length).toBe(1);
        expect(hitEvents[0].output.tier).toBe('L1');
    });

    it('matches semantically similar queries from L2 Warm Semantic Cache with quantized embeddings', async () => {
        const baseTask = 'Investigate authorization JWT signature validation failures';
        const baseData = 'Token expired error code 401 on api gateway auth proxy';

        // Prime the cache
        const res1 = await executeSwarmWorkflow({
            task: baseTask,
            data: baseData,
            forceFullSwarm: true,
            settings: {
                tieredCacheSettings: {
                    enabled: true,
                    l2SimilarityThreshold: 0.65
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'sec', role: 'Security Architect', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });
        expect(res1.tieredCache!.hit).toBe(false);

        // Clear L1 to force L2 semantic search
        (globalTieredCache as any).l1Map.clear();

        // Similar phrasing query
        const similarTask = 'Investigate authorization JWT signature validation error';
        const similarData = 'Token expired error code 401 on gateway auth';

        const res2 = await executeSwarmWorkflow({
            task: similarTask,
            data: similarData,
            settings: {
                tieredCacheSettings: {
                    enabled: true,
                    l2SimilarityThreshold: 0.65
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'sec', role: 'Security Architect', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });

        expect(res2.tieredCache).toBeDefined();
        expect(res2.tieredCache!.hit).toBe(true);
        expect(res2.tieredCache!.tier).toBe('L2');
        expect(res2.tieredCache!.similarity).toBeGreaterThanOrEqual(0.65);

        const l2Events = res2.events.filter(e => e.action === 'Tiered Cache Hit (L2)');
        expect(l2Events.length).toBe(1);
    });

    it('bypasses cache when tieredCacheSettings.enabled is false', async () => {
        const engine = new SwarmEngine({
            tieredCacheSettings: {
                enabled: false
            }
        });

        const res = await engine.execute({
            task: 'Perform routine status check',
            data: 'All services green',
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'perf', role: 'Performance Engineer', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });

        expect(res.tieredCache).toBeUndefined();
        const hitEvents = res.events.filter(e => e.action.includes('Tiered Cache Hit'));
        expect(hitEvents.length).toBe(0);
    });

    it('bypasses cache short-circuit when forceFullSwarm is true', async () => {
        const task = 'Audit postgres locking and deadlock scenarios';
        const data = 'table_orders locked by transaction 8812';

        // Populate cache
        await executeSwarmWorkflow({
            task,
            data,
            settings: {
                tieredCacheSettings: { enabled: true },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'db', role: 'Database Specialist', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });

        // Run with forceFullSwarm: true
        const resForced = await executeSwarmWorkflow({
            task,
            data,
            forceFullSwarm: true,
            settings: {
                tieredCacheSettings: { enabled: true },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' },
                    { id: 'db', role: 'Database Specialist', provider: 'tiered-mock', model: 'mock-model', apiKey: 'k-tiered' }
                ]
            }
        });

        // Did not short-circuit, completed full workflow
        expect(resForced.tieredCache).toBeDefined();
        expect(resForced.tieredCache!.hit).toBe(false);
    });
});
