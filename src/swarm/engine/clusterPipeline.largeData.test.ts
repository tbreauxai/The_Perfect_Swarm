import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './index.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Hierarchical Map-Reduce & Specialist Wave Scheduling (clusterPipeline.ts)', () => {
    let currentInFlight = 0;
    let peakInFlight = 0;
    const executedChunkIndices: number[] = [];
    const executedRoles: string[] = [];

    beforeEach(() => {
        currentInFlight = 0;
        peakInFlight = 0;
        executedChunkIndices.length = 0;
        executedRoles.length = 0;

        ProviderRegistry.register({
            providerName: 'mock-wave-provider',
            async call(options) {
                const prompt = options.prompt || '';
                if (options.systemInstruction?.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Hierarchical Wave Synthesis',
                        summary: 'All waves consolidated cleanly',
                        components: [
                            { id: 'wave-metrics', type: 'MetricCard', props: { title: 'Waves', value: 'Complete' } }
                        ]
                    });
                }

                currentInFlight++;
                if (currentInFlight > peakInFlight) {
                    peakInFlight = currentInFlight;
                }

                if (options.role) {
                    executedRoles.push(options.role);
                }

                // Match chunk index from prompt: "Data Chunk [X/Y]:" or "Chunk X/Y"
                const match = prompt.match(/Data Chunk \[(\d+)\/\d+\]/i) || prompt.match(/Chunk (\d+)\/\d+/i);
                if (match) {
                    executedChunkIndices.push(parseInt(match[1], 10) - 1);
                }

                // Simulate brief async work
                await new Promise(r => setTimeout(r, 10));

                currentInFlight--;

                return JSON.stringify({
                    insights: [`Wave findings for ${options.role}`],
                    anomalies: [],
                    summary: `Summary for ${options.role}`
                });
            }
        });
    });

    it('processes 10+ chunks in bounded specialist waves with intermediate progress events', async () => {
        // Generate payload that produces 10 distinct chunks (10 * 8000 tokens = ~80000 tokens = ~320,000 chars)
        const line = 'metric_data_record_identifier_timestamp_value_status_'.repeat(20); // ~1080 chars = ~270 tokens
        const lines: string[] = [];
        for (let i = 0; i < 300; i++) {
            lines.push(`record_${i}: ${line}`);
        }
        const largePayload = lines.join('\n');

        const stagePayloads: any[] = [];

        const result = await executeSwarmWorkflow({
            task: 'Analyze high-volume multi-chunk telemetry in bounded waves',
            data: largePayload,
            forceFullSwarm: true,
            onStage: (payload) => {
                stagePayloads.push(payload);
            },
            settings: {
                speculativeParallel: false,
                waveBatchSize: 4,
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'mock-wave-provider', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-1', role: 'Database Specialist', provider: 'mock-wave-provider', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-2', role: 'Network Specialist', provider: 'mock-wave-provider', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-3', role: 'Security Analyst', provider: 'mock-wave-provider', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-4', role: 'Performance Engineer', provider: 'mock-wave-provider', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();

        // 1. Verify bounded concurrency: peak in-flight calls should not exceed waveBatchSize (4)
        expect(peakInFlight).toBeLessThanOrEqual(4);

        // 2. Verify all chunks are evaluated (10 chunks total)
        expect(new Set(executedChunkIndices).size).toBeGreaterThanOrEqual(10);

        // 3. Verify no active analyst is starved
        const analystRoles = executedRoles.filter(r => r !== 'Manager Node');
        expect(new Set(analystRoles).size).toBe(4);

        // 4. Verify wave progress stages and events were emitted
        const waveStageEvents = stagePayloads.filter(s => s.stage === 'wave_progress');
        expect(waveStageEvents.length).toBeGreaterThanOrEqual(2);

        // 5. Verify wave scheduler context event was logged
        const events = result.events || [];
        const waveEvents = events.filter((e: any) => e.agentRole === 'Hierarchical Wave Scheduler');
        expect(waveEvents.length).toBeGreaterThanOrEqual(1);
    });
});
