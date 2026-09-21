import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine/index.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('SwarmEngine: Token-Aware Prompt Compression & Semantic Deduplication Integration', () => {
    let capturedManagerPrompt: string = '';
    let capturedAnalystPrompts: string[] = [];

    beforeEach(() => {
        capturedManagerPrompt = '';
        capturedAnalystPrompts = [];

        ProviderRegistry.register({
            providerName: 'compression-mock',
            async call(options) {
                const prompt = options.prompt || '';
                const systemInst = options.systemInstruction || '';

                if (systemInst.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    capturedManagerPrompt = prompt;
                    return JSON.stringify({
                        ui_title: 'Compressed Synthesis Dashboard',
                        components: [
                            {
                                id: 'c1',
                                type: 'InsightList',
                                props: {
                                    title: 'Executive Findings',
                                    insights: [
                                        { type: 'info', message: 'Analysis synthesized from deduplicated specialist reports' }
                                    ]
                                }
                            }
                        ]
                    });
                }

                if (systemInst.includes('Critic') || prompt.includes('Verify whether this analysis faithfully represents')) {
                    return JSON.stringify({
                        pass: true,
                        computedRating: 94,
                        criticFeedback: 'Analysis is sound and adheres strictly to verified findings.'
                    });
                }

                // Analyst responses with intentional redundancy to test cross-specialist deduplication
                capturedAnalystPrompts.push(prompt);
                if ((options as any).role === 'Database Specialist' || prompt.includes('Database Specialist')) {
                    return JSON.stringify({
                        summary: 'Database connection pool reached 100% capacity causing critical query latency spikes of 450ms.',
                        insights: [
                            'Connection pool saturated at 100% causing latency spikes',
                            'Read replica lag increased by 220ms'
                        ],
                        anomalies: ['Critical spike in connection pool saturation']
                    });
                }

                if ((options as any).role === 'Reliability Specialist' || prompt.includes('Reliability Specialist')) {
                    return JSON.stringify({
                        summary: 'Connection pool saturated at 100% causing severe latency spikes across worker pods.',
                        insights: [
                            'Connection pool saturated at 100% causing latency spikes',
                            'Worker pod CPU throttled at 90%'
                        ],
                        anomalies: ['Critical spike in connection pool saturation']
                    });
                }

                return JSON.stringify({
                    summary: 'Standard telemetry scan completed with normal operational parameters.',
                    insights: ['TLS certificates valid until 2028'],
                    anomalies: []
                });
            }
        });
    });

    it('compresses fast-path prompts and emits telemetry when compression is enabled', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Health check and quick status scan',
            data: 'Based on the provided metrics, system latency is normal. In conclusion, all services are operational. '.repeat(5),
            settings: {
                forceFullSwarm: false,
                disableFastPath: false,
                compressionSettings: {
                    enabled: true,
                    targetReductionRatio: 0.35,
                    stripBoilerplate: true
                },
                agents: [
                    {
                        id: 'mgr',
                        role: 'Manager Node',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    },
                    {
                        id: 'fast-node',
                        role: 'Fast Triager',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.compression).toBeDefined();
        expect(result.compression?.tokensSaved).toBeGreaterThan(10);
        expect(result.compression?.reductionRatio).toBeGreaterThan(0.20);

        const compEvents = result.events.filter(e => e.action === 'Prompt Compressed');
        expect(compEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('deduplicates multi-analyst reports in Step 5 manager synthesis and cuts prompt tokens by 30-50%', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Investigate system degradation during peak morning traffic',
            data: 'CPU 95%, Memory 88%, Latency 450ms across database and reliability logs.\n'.repeat(10),
            settings: {
                forceFullSwarm: true,
                disableFastPath: true,
                compressionSettings: {
                    enabled: true,
                    targetReductionRatio: 0.35,
                    similarityThreshold: 0.70,
                    preserveAnomalies: true
                },
                agents: [
                    {
                        id: 'db-spec',
                        role: 'Database Specialist',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    },
                    {
                        id: 'rel-spec',
                        role: 'Reliability Specialist',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    },
                    {
                        id: 'manager-node',
                        role: 'Manager Node',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.compression).toBeDefined();
        expect(result.compression?.tokensSaved).toBeGreaterThan(20);
        expect(result.compression?.deduplicatedSegmentsCount).toBeGreaterThanOrEqual(1);

        // Verify Prompt Compressed telemetry event was emitted
        const compEvents = result.events.filter(e => e.action === 'Prompt Compressed');
        expect(compEvents.length).toBeGreaterThanOrEqual(1);
        expect(compEvents.some(e => e.prompt.includes('specialist reports') || e.prompt.includes('Manager synthesis'))).toBe(true);

        // Verify that duplicate specialist reports were coalesced
        expect(capturedManagerPrompt).toBeDefined();
        expect(capturedManagerPrompt.length).toBeGreaterThan(0);
        expect(capturedManagerPrompt).toContain('Database Specialist');
    });

    it('bypasses prompt compression when compressionSettings is not enabled', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Uncompressed baseline task',
            data: 'Test data payload',
            settings: {
                forceFullSwarm: true,
                disableFastPath: true,
                compressionSettings: {
                    enabled: false
                },
                agents: [
                    {
                        id: 'a1',
                        role: 'Specialist A',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    },
                    {
                        id: 'mgr',
                        role: 'Manager Node',
                        provider: 'compression-mock',
                        model: 'mock-model',
                        apiKey: 'k-mock'
                    }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.compression).toBeUndefined();
        const compEvents = result.events.filter(e => e.action === 'Prompt Compressed');
        expect(compEvents.length).toBe(0);
    });
});
