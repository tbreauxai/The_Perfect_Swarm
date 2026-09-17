import { describe, it, expect } from 'vitest';
import {
    DependencyGraph,
    ConflictResolver,
    SpeculativeExecutionCoordinator,
    type SpeculativeTask
} from './speculative.ts';

describe('DependencyGraph: Subtask DAG & Independence Analysis', () => {
    it('manages task states and dependency promotions', () => {
        const graph = new DependencyGraph();
        graph.addNode({
            id: 'task-1',
            chunkIndex: 0,
            dependencies: [],
            payload: 'root'
        });
        graph.addNode({
            id: 'task-2',
            chunkIndex: 1,
            dependencies: ['task-1'],
            payload: 'dependent'
        });

        expect(graph.getReadyNodes()).toHaveLength(1);
        expect(graph.getReadyNodes()[0].id).toBe('task-1');

        graph.markRunning('task-1');
        expect(graph.getNode('task-1')?.status).toBe('running');

        graph.markCompleted('task-1', { data: 'processed' });
        expect(graph.getNode('task-1')?.status).toBe('completed');
        expect(graph.getNode('task-2')?.status).toBe('ready');
        expect(graph.getReadyNodes()).toHaveLength(1);
        expect(graph.getReadyNodes()[0].id).toBe('task-2');
    });

    it('detects cycles and reverts invalid dependencies', () => {
        const graph = new DependencyGraph();
        graph.addNode({ id: 'a', chunkIndex: 0, dependencies: [], payload: 'A' });
        graph.addNode({ id: 'b', chunkIndex: 1, dependencies: ['a'], payload: 'B' });

        expect(() => {
            graph.addDependency('a', 'b'); // cycle a -> b -> a
        }).toThrow(/Cycle detected/);

        expect(graph.hasCycles()).toBe(false);
    });

    it('partitions independent tasks into parallel execution batches', () => {
        const graph = new DependencyGraph();
        // 3 independent tasks, then 2 tasks depending on earlier ones
        graph.addNode({ id: 'ind-1', chunkIndex: 0, dependencies: [], payload: 'T1' });
        graph.addNode({ id: 'ind-2', chunkIndex: 1, dependencies: [], payload: 'T2' });
        graph.addNode({ id: 'ind-3', chunkIndex: 2, dependencies: [], payload: 'T3' });

        graph.addNode({ id: 'dep-1', chunkIndex: 3, dependencies: ['ind-1', 'ind-2'], payload: 'T4' });
        graph.addNode({ id: 'dep-2', chunkIndex: 4, dependencies: ['ind-3'], payload: 'T5' });

        const batches = graph.getExecutionBatches();
        expect(batches).toHaveLength(2);
        expect(batches[0].map(n => n.id).sort()).toEqual(['ind-1', 'ind-2', 'ind-3']);
        expect(batches[1].map(n => n.id).sort()).toEqual(['dep-1', 'dep-2']);
    });

    it('identifies independent data chunks vs sequential pipeline intent', () => {
        const independentChunks = [
            'Server region US-East CPU telemetry: 45% load',
            'Server region EU-West CPU telemetry: 52% load',
            'Server region AP-South CPU telemetry: 48% load'
        ];
        const indGraph = DependencyGraph.fromChunks(independentChunks, 'Analyze cluster load distribution');
        const indBatches = indGraph.getExecutionBatches();
        expect(indBatches).toHaveLength(1);
        expect(indBatches[0]).toHaveLength(3); // All 3 can run concurrently

        const seqChunks = [
            'Step 1: Extract database dump',
            'Step 2: Transform schema from step 1',
            'Step 3: Load into target warehouse'
        ];
        const seqGraph = DependencyGraph.fromChunks(seqChunks, 'Step by step pipeline execution');
        const seqBatches = seqGraph.getExecutionBatches();
        expect(seqBatches.length).toBeGreaterThan(1);
    });
});

describe('ConflictResolver: Speculative Contradiction & Deduplication', () => {
    const resolver = new ConflictResolver();

    it('detects and deduplicates redundant parallel insights', () => {
        const reports = [
            {
                role: 'Infrastructure Specialist',
                insights: ['Database connection pool exhausted due to high traffic volume'],
                anomalies: [],
                summary: 'DB pool alert'
            },
            {
                role: 'Performance Analyst',
                insights: ['Database connection pool exhausted due to peak traffic volume spikes'],
                anomalies: [],
                summary: 'DB pool capacity issue'
            }
        ];

        const conflicts = resolver.detectConflicts(reports);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].conflictType).toBe('duplicate');

        const reconciled = resolver.reconcileReports(reports);
        expect(reconciled.duplicateCount).toBe(1);
        expect(reconciled.insights).toHaveLength(1);
        expect(reconciled.insights[0]).toContain('Database connection pool exhausted');
    });

    it('resolves contradictions with conservative pessimistic safety-first policy', () => {
        const reports = [
            {
                role: 'Security Specialist',
                insights: [],
                anomalies: ['Critical authentication token leak vulnerability detected in request headers'],
                summary: 'Security threat detected'
            },
            {
                role: 'Performance Analyst',
                insights: ['Authentication response latency is nominal and optimal (<10ms)'],
                anomalies: [],
                summary: 'Auth speed is good'
            }
        ];

        const conflicts = resolver.detectConflicts(reports);
        expect(conflicts.length).toBeGreaterThan(0);
        expect(conflicts[0].conflictType).toBe('contradiction');

        const resolved = resolver.resolveConflicts(conflicts, { strategy: 'conservative_pessimistic' });
        expect(resolved).toHaveLength(1);
        expect(resolved[0].resolvedClaim).toContain('Critical authentication token leak vulnerability');
        expect(resolved[0].rationale).toContain('Conservative safety-first policy');

        const reconciled = resolver.reconcileReports(reports, { strategy: 'conservative_pessimistic' });
        expect(reconciled.anomalies).toHaveLength(1);
        expect(reconciled.anomalies[0]).toContain('Critical authentication token leak');
    });

    it('resolves contradictions with confidence-weighted specialist scoring', () => {
        const reports = [
            {
                role: 'Database Specialist',
                insights: ['Database lock wait timeout exceeded due to write contention'],
                anomalies: [],
                summary: 'DB contention'
            },
            {
                role: 'Frontend Specialist',
                insights: ['Database operation returned healthy status code 200 without delays'],
                anomalies: [],
                summary: 'UI looks normal'
            }
        ];

        const capabilityScores: Record<string, number> = {
            'Database Specialist': 0.95,
            'Frontend Specialist': 0.40
        };

        const conflicts = resolver.detectConflicts(reports);
        expect(conflicts).toHaveLength(1);

        const resolved = resolver.resolveConflicts(conflicts, {
            strategy: 'confidence_weighted',
            capabilityScorer: (role) => capabilityScores[role] || 0.5
        });

        expect(resolved[0].resolvedClaim).toContain('Database lock wait timeout exceeded');
        expect(resolved[0].contributingSources).toContain('Database Specialist');
    });
});

describe('SpeculativeExecutionCoordinator: Latency Reduction & Concurrency', () => {
    it('executes independent subtasks concurrently and achieves 40-60%+ latency reduction', async () => {
        const coordinator = new SpeculativeExecutionCoordinator();

        // 3 independent tasks, each taking ~40ms
        const tasks: SpeculativeTask[] = [
            {
                id: 'subtask-0',
                chunkIndex: 0,
                payload: 'shard-0',
                execute: async () => {
                    await new Promise(r => setTimeout(r, 40));
                    return {
                        role: 'Analyst A',
                        insights: ['Memory utilization stable at 45% in region A'],
                        anomalies: [],
                        summary: 'Region A normal'
                    };
                }
            },
            {
                id: 'subtask-1',
                chunkIndex: 1,
                payload: 'shard-1',
                execute: async () => {
                    await new Promise(r => setTimeout(r, 40));
                    return {
                        role: 'Analyst B',
                        insights: ['Memory utilization stable at 46% in region B'],
                        anomalies: [],
                        summary: 'Region B normal'
                    };
                }
            },
            {
                id: 'subtask-2',
                chunkIndex: 2,
                payload: 'shard-2',
                execute: async () => {
                    await new Promise(r => setTimeout(r, 40));
                    return {
                        role: 'Analyst C',
                        insights: ['Memory utilization stable at 47% in region C'],
                        anomalies: [],
                        summary: 'Region C normal'
                    };
                }
            }
        ];

        const result = await coordinator.executeSpeculative(tasks, {
            maxConcurrency: 3,
            staggerDelayMs: 0
        });

        expect(result.results).toHaveLength(3);
        expect(result.totalTasks).toBe(3);
        expect(result.concurrencyPeak).toBeGreaterThanOrEqual(2);

        // Serial baseline would be: ~120ms task time + 2 x 2000ms delay = ~4120ms
        // Concurrent actual duration should be ~40-80ms
        expect(result.actualWallClockDurationMs).toBeLessThan(300);
        expect(result.serialDurationEstimateMs).toBeGreaterThan(4000);
        expect(result.latencyReductionPercent).toBeGreaterThanOrEqual(50); // > 50% speedup!
        expect(result.latencyReductionPercent).toBeLessThanOrEqual(100);

        // Verify reconciled outputs
        expect(result.reconciledReport.insights.length).toBeGreaterThan(0);
    });

    it('respects maxConcurrency bounds', async () => {
        const coordinator = new SpeculativeExecutionCoordinator();
        let inFlight = 0;
        let peakInFlight = 0;

        const tasks: SpeculativeTask[] = Array.from({ length: 6 }, (_, idx) => ({
            id: `task-${idx}`,
            chunkIndex: idx,
            payload: `item-${idx}`,
            execute: async () => {
                inFlight++;
                if (inFlight > peakInFlight) peakInFlight = inFlight;
                await new Promise(r => setTimeout(r, 25));
                inFlight--;
                return {
                    role: `Worker-${idx}`,
                    insights: [`Output from worker ${idx}`],
                    anomalies: [],
                    summary: `Done ${idx}`
                };
            }
        }));

        const result = await coordinator.executeSpeculative(tasks, {
            maxConcurrency: 2,
            staggerDelayMs: 0
        });

        expect(result.results).toHaveLength(6);
        expect(result.concurrencyPeak).toBeLessThanOrEqual(2);
        expect(peakInFlight).toBeLessThanOrEqual(2);
    });
});
