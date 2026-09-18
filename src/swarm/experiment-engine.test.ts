import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { AgentExperimentManager, AgentExperiment } from './experiment.ts';

describe('SwarmEngine: Continuous Learning & Automated A/B Testing Integration', () => {
    let experimentManager: AgentExperimentManager;
    let testExperiment: AgentExperiment;

    beforeEach(() => {
        experimentManager = new AgentExperimentManager();
        testExperiment = experimentManager.createExperiment({
            id: 'engine-ab-test',
            name: 'Specialist Prompt & Configuration Test',
            allocationStrategy: 'deterministic_hash',
            promotionCriteria: {
                minSampleSize: 3,
                minImprovementPercent: 5,
                confidenceLevel: 0.95,
                primaryMetric: 'composite'
            },
            circuitBreaker: {
                maxErrorRate: 0.30,
                minRlaifScore: 0.60,
                minSamplesBeforeTrigger: 5
            },
            variants: [
                {
                    variantId: 'control',
                    name: 'Control Baseline',
                    trafficWeight: 0.5,
                    isBaseline: true
                },
                {
                    variantId: 'treatment-fast',
                    name: 'Optimized Treatment',
                    trafficWeight: 0.5,
                    parameters: {
                        temperature: 0.2
                    },
                    systemPrompts: {
                        'Security Specialist': 'You are an ultra-concise specialized security analyst.'
                    }
                }
            ]
        });

        // Register custom mock provider
        ProviderRegistry.register({
            providerName: 'experiment-mock',
            async call(options) {
                const prompt = options.prompt || '';
                const systemInst = options.systemInstruction || '';

                if (systemInst.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Experiment Synthesis Dashboard',
                        components: [
                            {
                                id: 'c1',
                                type: 'InsightList',
                                props: {
                                    title: 'Findings',
                                    insights: [
                                        { type: 'info', message: 'Analysis nominal under experiment variant' }
                                    ]
                                }
                            }
                        ]
                    });
                }

                // Specialist response
                return JSON.stringify({
                    insights: ['Security controls verified under test variant'],
                    anomalies: [],
                    summary: 'Variant-aware specialist analysis complete'
                });
            }
        });
    });

    it('dispatches active variant and attaches experiment telemetry on fast-path tasks', async () => {
        const events: any[] = [];
        const result = await executeSwarmWorkflow({
            task: 'Ping database cluster health',
            data: 'status=ok',
            settings: {
                appId: 'test-ab-app',
                experimentSettings: {
                    experimentManager,
                    experimentId: 'engine-ab-test',
                    routingKey: 'fixed-routing-key'
                },
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'experiment-mock', model: 'mock-v1', apiKey: 'k-mgr' },
                    { id: 'sec', role: 'Security Specialist', provider: 'experiment-mock', model: 'mock-v1', apiKey: 'k-sec' }
                ]
            },
            onEvent: (evt) => events.push(evt)
        });

        expect(result.experiment).toBeDefined();
        expect(result.experiment?.experimentId).toBe('engine-ab-test');
        expect(['control', 'treatment-fast']).toContain(result.experiment?.variantId);

        const dispatchEvent = events.find(e => e.action === 'Agent A/B Variant Dispatched');
        expect(dispatchEvent).toBeDefined();
        expect(dispatchEvent.output.experimentId).toBe('engine-ab-test');

        const evalEvent = events.find(e => e.action === 'Agent Experiment Evaluated');
        expect(evalEvent).toBeDefined();

        // Check metrics recorded in experiment
        const perf = testExperiment.getPerformance(result.experiment!.variantId);
        expect(perf.sampleCount).toBe(1);
    });

    it('executes full multi-agent swarm workflow under variant configuration and captures metrics', async () => {
        const events: any[] = [];
        const result = await executeSwarmWorkflow({
            task: 'Comprehensive multi-specialist security and performance audit',
            data: 'server_metrics_line_1=ok\nserver_metrics_line_2=warn',
            forceFullSwarm: true,
            settings: {
                appId: 'test-ab-full',
                forceFullSwarm: true,
                experimentSettings: {
                    experimentManager,
                    experimentId: 'engine-ab-test',
                    routingKey: 'treatment-target'
                },
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'experiment-mock', model: 'mock-v1', apiKey: 'k-mgr' },
                    { id: 'sec', role: 'Security Specialist', provider: 'experiment-mock', model: 'mock-v1', apiKey: 'k-sec' },
                    { id: 'perf', role: 'Performance Engineer', provider: 'experiment-mock', model: 'mock-v1', apiKey: 'k-perf' }
                ]
            },
            onEvent: (evt) => events.push(evt)
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.finalAnalysis.ui_title).toBe('Experiment Synthesis Dashboard');
        expect(result.experiment).toBeDefined();

        const dispatchEvent = events.find(e => e.action === 'Agent A/B Variant Dispatched');
        expect(dispatchEvent).toBeDefined();

        const evalEvent = events.find(e => e.action === 'Agent Experiment Evaluated');
        expect(evalEvent).toBeDefined();
    });

    it('honors disableABTesting and bypasses experiment allocation', async () => {
        const events: any[] = [];
        const result = await executeSwarmWorkflow({
            task: 'Check worker uptime',
            data: 'uptime=100%',
            settings: {
                experimentSettings: {
                    experimentManager,
                    disableABTesting: true
                },
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'experiment-mock', model: 'mock-v1', apiKey: 'k-mgr' }
                ]
            },
            onEvent: (evt) => events.push(evt)
        });

        expect(result.experiment).toBeUndefined();
        const dispatchEvent = events.find(e => e.action === 'Agent A/B Variant Dispatched');
        expect(dispatchEvent).toBeUndefined();
    });
});
