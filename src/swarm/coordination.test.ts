import { describe, it, expect, beforeEach } from 'vitest';
import {
    AgentAdaptiveLearningRateManager,
    HighBandwidthMessageChannel,
    HierarchicalTaskDecomposer,
    HypothesisValidationLayer,
    ShapedRewardPolicy,
    globalLearningRateManager,
    globalMessageChannel,
    globalTaskDecomposer,
    globalHypothesisLayer,
    globalShapedRewardPolicy
} from './coordination.ts';
import { SharedKnowledgeGraph } from './knowledgeGraph.ts';

describe('AgentAdaptiveLearningRateManager', () => {
    let lrManager: AgentAdaptiveLearningRateManager;

    beforeEach(() => {
        lrManager = new AgentAdaptiveLearningRateManager({
            defaultLearningRate: 0.10,
            minLearningRate: 0.02,
            maxLearningRate: 0.40,
            emaAlpha: 0.2,
            accelerationFactor: 1.2,
            dampingFactor: 0.8
        });
    });

    it('should initialize default state for new agents', () => {
        const rate = lrManager.getLearningRate('agent-alpha');
        expect(rate).toBe(0.10);
        const state = lrManager.getOrCreateState('agent-alpha');
        expect(state.agentId).toBe('agent-alpha');
        expect(state.consecutiveSuccesses).toBe(0);
        expect(state.consecutiveFailures).toBe(0);
    });

    it('should damp learning rate upon consecutive high rewards (convergence settling)', () => {
        lrManager.recordAgentStep('agent-fast', 0.9);
        lrManager.recordAgentStep('agent-fast', 0.85);
        const step3 = lrManager.recordAgentStep('agent-fast', 0.95);

        // Consecutive successes >= 3 triggers damping (0.10 * 0.8 = 0.08)
        expect(step3.newRate).toBeLessThan(0.10);
        expect(step3.newRate).toBe(0.08);
    });

    it('should accelerate learning rate upon consecutive failures or high variance (exploration boost)', () => {
        lrManager.recordAgentStep('agent-stuck', 0.2);
        const step2 = lrManager.recordAgentStep('agent-stuck', 0.1);

        // Consecutive failures >= 2 triggers acceleration (0.10 * 1.2 = 0.12)
        expect(step2.newRate).toBeGreaterThan(0.10);
        expect(step2.newRate).toBe(0.12);
    });

    it('should clamp learning rate between min and max bounds', () => {
        for (let i = 0; i < 20; i++) {
            lrManager.recordAgentStep('agent-bound-test', 0.99);
        }
        expect(lrManager.getLearningRate('agent-bound-test')).toBeGreaterThanOrEqual(0.02);

        for (let i = 0; i < 30; i++) {
            lrManager.recordAgentStep('agent-high-bound', 0.05);
        }
        expect(lrManager.getLearningRate('agent-high-bound')).toBeLessThanOrEqual(0.40);
    });

    it('should reset all states cleanly', () => {
        lrManager.recordAgentStep('agent-1', 0.8);
        expect(lrManager.getAllStates()).toHaveLength(1);
        lrManager.reset();
        expect(lrManager.getAllStates()).toHaveLength(0);
    });
});

describe('HighBandwidthMessageChannel', () => {
    let channel: HighBandwidthMessageChannel;

    beforeEach(() => {
        channel = new HighBandwidthMessageChannel(4); // Small capacity for ring buffer testing
    });

    it('should publish and subscribe to specific topics', () => {
        const received: any[] = [];
        const unsub = channel.subscribe('task_progress', msg => received.push(msg.payload));

        channel.publish({
            senderId: 'agent-1',
            topic: 'task_progress',
            payload: { percent: 50 }
        });

        channel.publish({
            senderId: 'agent-2',
            topic: 'unrelated',
            payload: { secret: true }
        });

        expect(received).toHaveLength(1);
        expect(received[0].percent).toBe(50);

        unsub();
        channel.publish({
            senderId: 'agent-1',
            topic: 'task_progress',
            payload: { percent: 100 }
        });
        expect(received).toHaveLength(1);
    });

    it('should deliver messages to wildcard subscribers', () => {
        const wildcardReceived: string[] = [];
        channel.subscribe('*', msg => wildcardReceived.push(msg.topic));

        channel.publish({ senderId: 'a', topic: 'telemetry', payload: {} });
        channel.publish({ senderId: 'b', topic: 'finding', payload: {} });

        expect(wildcardReceived).toEqual(['telemetry', 'finding']);
    });

    it('should roll over ring buffer when capacity is reached', () => {
        channel.publish({ senderId: '1', topic: 't', payload: 'msg1' });
        channel.publish({ senderId: '2', topic: 't', payload: 'msg2' });
        channel.publish({ senderId: '3', topic: 't', payload: 'msg3' });
        channel.publish({ senderId: '4', topic: 't', payload: 'msg4' });
        channel.publish({ senderId: '5', topic: 't', payload: 'msg5' }); // Overwrites msg1

        const recent = channel.getRecentMessages(10);
        expect(recent).toHaveLength(4);
        expect(recent.map(m => m.payload)).toEqual(['msg5', 'msg4', 'msg3', 'msg2']);
    });
});

describe('HierarchicalTaskDecomposer', () => {
    let decomposer: HierarchicalTaskDecomposer;

    beforeEach(() => {
        decomposer = new HierarchicalTaskDecomposer();
    });

    it('should decompose macro-task into structured subtasks with execution waves', () => {
        const roles = ['Security Analyst', 'Performance Analyst', 'Infrastructure Analyst'];
        const plan = decomposer.decompose('Investigate payment latency spikes', roles);

        expect(plan.macroTask).toBe('Investigate payment latency spikes');
        expect(plan.subtasks.length).toBeGreaterThanOrEqual(3);
        expect(plan.executionWaves.length).toBeGreaterThanOrEqual(2);

        // First wave should be the infrastructure baseline profiling
        expect(plan.executionWaves[0]).toContain('sub-env-profile');

        // Synthesis subtask should depend on previous waves
        const synthesis = plan.subtasks.find(s => s.id === 'sub-synthesis');
        expect(synthesis).toBeDefined();
        expect(synthesis?.dependencies.length).toBeGreaterThan(0);
    });
});

describe('HypothesisValidationLayer', () => {
    let kg: SharedKnowledgeGraph;
    let hypoLayer: HypothesisValidationLayer;

    beforeEach(() => {
        kg = new SharedKnowledgeGraph();
        hypoLayer = new HypothesisValidationLayer(kg);
    });

    it('should propose hypotheses and merge duplicates', () => {
        const h1 = hypoLayer.proposeHypothesis({
            claim: 'Database connection pool starvation causes 504 errors',
            proposedBy: 'PerfAgent',
            confidence: 0.6,
            evidence: ['504 timeout logs']
        });

        expect(h1.status).toBe('proposed');
        expect(h1.confidence).toBe(0.6);

        // Propose duplicate claim
        const h2 = hypoLayer.proposeHypothesis({
            claim: 'Database connection pool starvation causes 504 errors',
            proposedBy: 'InfraAgent',
            confidence: 0.7,
            evidence: ['Pool max connections reached']
        });

        expect(h2.id).toBe(h1.id);
        expect(h2.evidence).toContain('504 timeout logs');
        expect(h2.evidence).toContain('Pool max connections reached');
    });

    it('should validate hypothesis and propagate finding into knowledge graph', () => {
        const h = hypoLayer.proposeHypothesis({
            claim: 'Redis eviction policy is misconfigured',
            proposedBy: 'CacheSpecialist',
            evidence: ['keys evicting prematurely']
        });

        const validated = hypoLayer.validateHypothesis(h.id, {
            isValid: true,
            validatedBy: 'PrincipalArchitect',
            feedback: 'Verified against redis.conf memory limit'
        });

        expect(validated?.status).toBe('validated');
        expect(validated?.confidence).toBeGreaterThan(0.6);

        // Check propagation into Knowledge Graph
        const node = kg.getNode(`node-${h.id}`);
        expect(node).toBeDefined();
        expect(node?.type).toBe('finding');
        expect(node?.label).toBe('Redis eviction policy is misconfigured');
        expect(node?.properties.validatedBy).toBe('PrincipalArchitect');
    });

    it('should refute hypothesis and prune unviable hypotheses', () => {
        const h = hypoLayer.proposeHypothesis({
            claim: 'DDoS attack is ongoing',
            proposedBy: 'SecurityJunior',
            confidence: 0.3
        });

        hypoLayer.validateHypothesis(h.id, {
            isValid: false,
            validatedBy: 'SecLead',
            feedback: 'Traffic is within normal organic bounds'
        });

        expect(h.status).toBe('refuted');
        expect(h.confidence).toBe(0.0);

        const pruneRes = hypoLayer.pruneRedundantHypotheses();
        expect(pruneRes.prunedCount).toBe(1);
        expect(h.status).toBe('pruned');
    });
});

describe('ShapedRewardPolicy', () => {
    let policy: ShapedRewardPolicy;

    beforeEach(() => {
        policy = new ShapedRewardPolicy(0.20, 0.15);
    });

    it('should balance extrinsic reward with novelty bonus and redundancy penalty', () => {
        const res = policy.calculateShapedReward({
            extrinsicReward: 0.8,
            noveltyScore: 0.5,      // + (0.5 * 0.20) = +0.10
            redundancyCount: 2,     // - (2 * 0.1 * 0.15) = -0.03
        });

        expect(res.components.extrinsic).toBe(0.8);
        expect(res.components.noveltyBonus).toBe(0.1);
        expect(res.components.redundancyPenalty).toBe(0.03);
        expect(res.shapedReward).toBe(0.87);
    });

    it('should clamp reward to range [-1.0, 1.0]', () => {
        const maxClamped = policy.calculateShapedReward({
            extrinsicReward: 1.0,
            noveltyScore: 1.0,
            redundancyCount: 0,
            noveltyWeight: 0.5
        });
        expect(maxClamped.shapedReward).toBe(1.0);

        const minClamped = policy.calculateShapedReward({
            extrinsicReward: -1.0,
            noveltyScore: 0,
            redundancyCount: 10,
            redundancyPenalty: 0.5
        });
        expect(minClamped.shapedReward).toBe(-1.0);
    });
});

describe('Global coordination instances', () => {
    it('should provide operational singleton instances', () => {
        expect(globalLearningRateManager).toBeInstanceOf(AgentAdaptiveLearningRateManager);
        expect(globalMessageChannel).toBeInstanceOf(HighBandwidthMessageChannel);
        expect(globalTaskDecomposer).toBeInstanceOf(HierarchicalTaskDecomposer);
        expect(globalHypothesisLayer).toBeInstanceOf(HypothesisValidationLayer);
        expect(globalShapedRewardPolicy).toBeInstanceOf(ShapedRewardPolicy);
    });
});
