import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow, SwarmEngine } from './engine/index.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('SwarmEngine: Adaptive Load-Balancing & Task-Scheduling Integration', () => {
    beforeEach(() => {
        ProviderRegistry.register({
            providerName: 'scheduler-mock',
            async call(options) {
                const prompt = options.prompt || '';
                const systemInst = options.systemInstruction || '';

                if (systemInst.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Scheduled Synthesis Dashboard',
                        components: [
                            {
                                id: 'c1',
                                type: 'InsightList',
                                props: {
                                    title: 'Executive Findings',
                                    insights: [
                                        { type: 'info', message: 'Analysis synthesized from scheduled specialist reports' }
                                    ]
                                }
                            }
                        ]
                    });
                }

                if (systemInst.includes('Critic') || prompt.includes('Verify whether this analysis faithfully represents')) {
                    return JSON.stringify({
                        pass: true,
                        computedRating: 92,
                        criticFeedback: 'Scheduled analysis verified.'
                    });
                }

                return JSON.stringify({
                    summary: 'Specialist resource allocation telemetry nominal.',
                    insights: ['Worker pod throughput optimal', 'Memory headroom preserved'],
                    anomalies: []
                });
            }
        });
    });

    it('executes scheduled analyst tasks and reports scheduling metrics when enabled', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Audit microservice memory consumption patterns',
            data: 'CPU load 45%, memory usage 82% on container-worker-1, io_wait 12ms',
            forceFullSwarm: true,
            settings: {
                schedulingSettings: {
                    enabled: true,
                    strategy: 'work-stealing',
                    maxConcurrency: 2,
                    enableRateLimiting: false
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' },
                    { id: 'perf', role: 'Performance Engineer', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' },
                    { id: 'infra', role: 'Infrastructure Analyst', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' }
                ]
            }
        });

        expect(result).toBeDefined();
        expect(result.finalAnalysis).toBeDefined();

        // Verify scheduling metrics
        expect(result.scheduling).toBeDefined();
        expect(result.scheduling!.totalTasks).toBeGreaterThan(0);
        expect(result.scheduling!.successfulTasks).toBe(result.scheduling!.totalTasks);
        expect(result.scheduling!.failedTasks).toBe(0);
        expect(result.scheduling!.totalExecutionMs).toBeGreaterThanOrEqual(0);

        // Verify telemetry events
        const scheduledEvents = result.events.filter(e => e.action === 'Task Scheduled');
        expect(scheduledEvents.length).toBeGreaterThan(0);

        const summaryEvents = result.events.filter(e => e.action === 'Adaptive Task Scheduling');
        expect(summaryEvents.length).toBe(1);
        expect(summaryEvents[0].output.strategy).toBe('work-stealing');
    });

    it('schedules multi-chunk tasks with priority and fair distribution', async () => {
        // Multi-chunk dataset
        const multiChunkData = Array.from({ length: 4 }, (_, i) => `Server node-${i + 1}: RAM 9${i}%, network_tx 120MB/s, disk_iops 450`).join('\n\n---CHUNK_BOUNDARY---\n\n');

        const engine = new SwarmEngine({
            schedulingSettings: {
                enabled: true,
                strategy: 'priority',
                maxConcurrency: 2,
                enableRateLimiting: false
            }
        });

        const result = await engine.execute({
            task: 'Analyze multi-node cluster performance anomalies',
            data: multiChunkData,
            forceFullSwarm: true,
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' },
                    { id: 'db', role: 'Database Specialist', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' },
                    { id: 'sys', role: 'Systems Engineer', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' }
                ]
            }
        });

        expect(result.scheduling).toBeDefined();
        expect(result.scheduling!.totalTasks).toBeGreaterThan(1);
        expect(result.scheduling!.successfulTasks).toBe(result.scheduling!.totalTasks);

        const summaryEvent = result.events.find(e => e.action === 'Adaptive Task Scheduling');
        expect(summaryEvent).toBeDefined();
        expect(summaryEvent!.output.strategy).toBe('priority');
    });

    it('applies rate-limit backpressure pacing when enabled', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Rapid health check under tight provider rate limits',
            data: 'Cluster status nominal',
            forceFullSwarm: true,
            settings: {
                schedulingSettings: {
                    enabled: true,
                    strategy: 'least-loaded',
                    enableRateLimiting: true,
                    rateLimits: {
                        'scheduler-mock': { maxRpm: 120, maxTpm: 50000 }
                    }
                },
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' },
                    { id: 'sec', role: 'Security Analyst', provider: 'scheduler-mock', model: 'mock-model', apiKey: 'k-sched' }
                ]
            }
        });

        expect(result.scheduling).toBeDefined();
        expect(result.scheduling!.totalTasks).toBeGreaterThan(0);
        expect(result.scheduling!.totalBackpressureDelayMs).toBeGreaterThanOrEqual(0);
    });
});
