import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine.js';
import { ProviderRegistry } from './providers/registry.js';
import { globalFeedbackEngine } from './feedback.js';
import { globalMetricsCollector } from './profiler.js';
import { globalTieredCache } from './tieredCache.js';

describe('SwarmEngine Feedback Loop & Policy Adaptation Integration', () => {
    beforeEach(() => {
        globalFeedbackEngine.reset();
        globalMetricsCollector.reset();
        globalTieredCache.clear();

        ProviderRegistry.register({
            providerName: 'mock-feedback-provider',
            async call(options) {
                return JSON.stringify({
                    ui_title: 'Feedback Analysis Test',
                    qualityScore: 0.95,
                    accuracyScore: 0.98,
                    components: [
                        {
                            id: '1',
                            type: 'InsightList',
                            props: {
                                title: 'Insights',
                                insights: [
                                    { type: 'info', message: 'Operational nominal' }
                                ]
                            }
                        }
                    ]
                });
            }
        });
    });

    const mockSettings = {
        geminiApiKey: 'mock-gemini-key',
        openRouterApiKey: 'mock-openrouter-key',
        agents: [
            { id: 'fb-mgr', role: 'Manager Node', provider: 'mock-feedback-provider', model: 'mock-v1', apiKey: 'mock-key' },
            { id: 'fb-spec-1', role: 'Security Analyst', provider: 'mock-feedback-provider', model: 'mock-v1', apiKey: 'mock-key' }
        ],
        critic: { id: 'fb-critic', role: 'Lead Critic', provider: 'mock-feedback-provider', model: 'mock-v1', apiKey: 'mock-key' }
    };

    it('captures performance metrics and returns feedback report on fast-path execution', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Ping database connection status',
            data: 'status=ok',
            settings: {
                ...mockSettings,
                appId: 'engine-feedback-test',
                forceFullSwarm: false
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.feedback).toBeDefined();
        expect(result.feedback?.reward.compositeReward).toBeGreaterThan(0.5);
        expect(result.feedback?.outcomeId).toBeDefined();
        expect(result.feedback?.tunedParameters).toBeDefined();

        const storedOutcome = globalFeedbackEngine.getKnowledgeRepository().getOutcome(result.feedback!.outcomeId);
        expect(storedOutcome).toBeDefined();
        expect(storedOutcome?.appId).toBe('engine-feedback-test');
    });

    it('logs analysis outcome and evaluates policy adaptation on full swarm workflow', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Analyze microservice bottleneck and resource allocation anomalies',
            data: 'cpu=98% memory=92% threads=400 node=prod-worker-1',
            settings: {
                ...mockSettings,
                appId: 'engine-feedback-full-test',
                forceFullSwarm: true
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.feedback).toBeDefined();
        expect(result.feedback?.reward).toBeDefined();
        expect(result.feedback?.reward.components.qualityReward).toBeGreaterThan(0);
        expect(result.feedback?.outcomeId).toBeDefined();

        const insights = globalFeedbackEngine.getKnowledgeRepository().getAggregatedInsights('engine-feedback-full-test');
        expect(insights.totalRuns).toBeGreaterThanOrEqual(1);
        expect(insights.avgReward).toBeDefined();
    });

    it('attaches drift alerts when latency or data anomalies occur', async () => {
        const detector = globalFeedbackEngine.getDriftDetector();
        // Trigger pre-existing latency baseline
        for (let i = 0; i < 10; i++) {
            detector.recordLatencyObservation(30);
        }

        const result = await executeSwarmWorkflow({
            task: 'Run complex stress simulation under high load',
            data: 'load_level=extreme',
            settings: {
                ...mockSettings,
                appId: 'drift-test-app',
                forceFullSwarm: true,
                feedbackSettings: {
                    enabled: true
                }
            }
        });

        expect(result.feedback).toBeDefined();
        expect(result.feedback?.tunedParameters).toBeDefined();
    });

    it('updates parameter policy and records evolution in shared knowledge repository', async () => {
        const initialPolicy = globalFeedbackEngine.getPolicyOptimizer().getCurrentPolicy();
        expect(initialPolicy).toBeDefined();

        // Run sequential workflows to trigger evolutionary feedback loop
        for (let i = 0; i < 3; i++) {
            await executeSwarmWorkflow({
                task: `Periodic analytics sweep ${i}`,
                data: `iteration=${i}`,
                settings: {
                    ...mockSettings,
                    appId: 'evolution-test-app',
                    forceFullSwarm: false
                }
            });
        }

        const repo = globalFeedbackEngine.getKnowledgeRepository();
        const outcomes = repo.queryOutcomes({ appId: 'evolution-test-app' });
        expect(outcomes.length).toBe(3);

        const insights = repo.getAggregatedInsights('evolution-test-app');
        expect(insights.totalRuns).toBe(3);
        expect(insights.bestParameters).toBeDefined();
    });
});
