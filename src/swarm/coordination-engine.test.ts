import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { globalKnowledgeGraph } from './knowledgeGraph.ts';
import {
    globalHypothesisLayer,
    globalLearningRateManager,
    globalMessageChannel,
    globalTaskDecomposer
} from './coordination.ts';
import { globalTieredCache } from './tieredCache.ts';
import { globalMetricsCollector } from './profiler.ts';

describe('SwarmEngine Hierarchical Coordination Integration', () => {
    beforeEach(() => {
        globalKnowledgeGraph.clear();
        globalHypothesisLayer.clear();
        globalLearningRateManager.reset();
        globalMessageChannel.clear();
        globalTieredCache.clear();
        globalMetricsCollector.reset();

        ProviderRegistry.register({
            providerName: 'mock-coordination-provider',
            async call(options) {
                // If it's an analyst call, return analyst schema with insights
                if (options.prompt.includes('Task:') || options.systemInstruction?.includes('Specialist')) {
                    return JSON.stringify({
                        specialist_role: 'Security Analyst',
                        summary: 'Analyzed security perimeter and network posture.',
                        insights: [
                            'Weak cipher suite negotiated on port 443',
                            'Unauthenticated endpoint discovered in auth gateway'
                        ],
                        anomalies: [
                            'Abrupt spike in failed login attempts'
                        ]
                    });
                }

                // Manager synthesis response
                return JSON.stringify({
                    ui_title: 'Executive Security Audit',
                    executive_summary: 'Comprehensive audit completed across perimeter and internal services.',
                    components: [
                        {
                            id: 'c1',
                            type: 'InsightList',
                            props: {
                                title: 'Key Findings',
                                insights: [
                                    { type: 'warning', message: 'Weak cipher suite detected' }
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
            { id: 'coord-mgr', role: 'Manager Node', provider: 'mock-coordination-provider', model: 'mock-m1', apiKey: 'mock-key' },
            { id: 'coord-spec-1', role: 'Security Analyst', provider: 'mock-coordination-provider', model: 'mock-m1', apiKey: 'mock-key' },
            { id: 'coord-spec-2', role: 'Performance Analyst', provider: 'mock-coordination-provider', model: 'mock-m1', apiKey: 'mock-key' }
        ],
        critic: { id: 'coord-critic', role: 'Lead Critic', provider: 'mock-coordination-provider', model: 'mock-m1', apiKey: 'mock-key' }
    };

    it('should execute full swarm with hierarchical decomposition, hypothesis validation, and adaptive learning rates', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Perform root cause analysis of infrastructure latency',
            data: 'CPU=95%, Latency=450ms, Memory=82%',
            forceFullSwarm: true,
            settings: {
                ...mockSettings,
                appId: 'test-coord-full',
                coordinationSettings: {
                    enabled: true,
                    adaptiveLearningRates: true,
                    hierarchicalDecomposition: true,
                    hypothesisValidation: true,
                    rewardShaping: true
                }
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.coordination).toBeDefined();

        // 1. Hierarchical Task Decomposition
        expect(result.coordination?.taskDecomposition).toBeDefined();
        expect(result.coordination?.taskDecomposition?.macroTask).toBe('Perform root cause analysis of infrastructure latency');
        expect(result.coordination?.taskDecomposition?.subtasks.length).toBeGreaterThanOrEqual(3);
        expect(result.coordination?.taskDecomposition?.executionWaves.length).toBeGreaterThanOrEqual(2);

        const decompEvent = result.events.find(e => e.action === 'Hierarchical Task Decomposition');
        expect(decompEvent).toBeDefined();

        // 2. Hypothesis Proposal and Validation
        expect(result.coordination?.hypothesesCount).toBeGreaterThan(0);
        expect(result.coordination?.validatedHypothesesCount).toBeGreaterThan(0);

        const hypoEvent = result.events.find(e => e.action === 'Hypotheses Validated & Propagated');
        expect(hypoEvent).toBeDefined();

        // 3. Shared Knowledge Graph Updates
        expect(result.coordination?.knowledgeGraphVersion).toBeGreaterThan(0);
        expect(result.coordination?.totalNodes).toBeGreaterThan(0);
        const stats = globalKnowledgeGraph.getStats();
        expect(stats.totalNodes).toBeGreaterThan(0);
        expect(stats.nodeTypes.finding).toBeGreaterThan(0);

        // 4. Adaptive Learning Rates
        expect(result.coordination?.agentLearningRates).toBeDefined();
        expect(result.coordination?.agentLearningRates['Security Analyst']).toBeDefined();
        expect(result.coordination?.agentLearningRates['Manager Node']).toBeDefined();

        const rateEvent = result.events.find(e => e.action === 'Agent Learning Rates Updated');
        expect(rateEvent).toBeDefined();

        // 5. Shaped Reward
        expect(result.coordination?.shapedReward).toBeDefined();
        expect(result.coordination?.shapedReward?.shapedReward).toBeDefined();
        expect(result.coordination?.shapedReward?.components.extrinsic).toBeDefined();
        expect(result.coordination?.shapedReward?.components.noveltyBonus).toBeGreaterThanOrEqual(0);
    });

    it('should attach coordination metadata on fast-path execution', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Fast ping test',
            data: 'ping=pong',
            forceFullSwarm: false,
            settings: {
                ...mockSettings,
                appId: 'test-coord-fast',
                coordinationSettings: {
                    enabled: true
                }
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.coordination).toBeDefined();
        expect(result.coordination?.knowledgeGraphVersion).toBeDefined();
        expect(result.coordination?.agentLearningRates).toBeDefined();
    });

    it('should attach coordination metadata on tiered cache hit', async () => {
        // Preload cache entry
        globalTieredCache.set('Cached Query', { ui_title: 'Cached Fast Result' }, 'Cached Query');

        const result = await executeSwarmWorkflow({
            task: 'Cached Query',
            forceFullSwarm: false,
            settings: {
                ...mockSettings,
                appId: 'test-coord-cache',
                tieredCacheSettings: { enabled: true },
                coordinationSettings: { enabled: true }
            }
        });

        expect(result.tieredCache?.hit).toBe(true);
        expect(result.coordination).toBeDefined();
        expect(result.coordination?.knowledgeGraphVersion).toBeDefined();
    });

    it('should omit coordination metadata when explicitly disabled', async () => {
        const result = await executeSwarmWorkflow({
            task: 'Perform security scan',
            forceFullSwarm: true,
            settings: {
                ...mockSettings,
                appId: 'test-coord-disabled',
                coordinationSettings: {
                    enabled: false
                }
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        expect(result.coordination).toBeUndefined();
    });
});
