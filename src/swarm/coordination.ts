/**
 * @file coordination.ts
 * @description Advanced hierarchical coordination, adaptive learning rates per agent,
 * high-bandwidth interagent ring channels, hierarchical task decomposition,
 * hypothesis validation layer, and curiosity-shaped reinforcement learning.
 */

import { globalKnowledgeGraph, type SharedKnowledgeGraph } from './knowledgeGraph.ts';

export interface AgentLearningState {
    agentId: string;
    learningRate: number;
    emaReward: number;
    rewardVariance: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    totalUpdates: number;
}

export interface AdaptiveLearningRateConfig {
    defaultLearningRate?: number;
    minLearningRate?: number;
    maxLearningRate?: number;
    emaAlpha?: number;
    accelerationFactor?: number;
    dampingFactor?: number;
}

/**
 * Manages adaptive learning rates per individual agent/specialist to accelerate convergence.
 */
export class AgentAdaptiveLearningRateManager {
    private static instance: AgentAdaptiveLearningRateManager;
    private agentStates: Map<string, AgentLearningState> = new Map();

    private defaultRate: number;
    private minRate: number;
    private maxRate: number;
    private emaAlpha: number;
    private accelerationFactor: number;
    private dampingFactor: number;

    public constructor(config?: AdaptiveLearningRateConfig) {
        this.defaultRate = config?.defaultLearningRate ?? 0.10;
        this.minRate = config?.minLearningRate ?? 0.01;
        this.maxRate = config?.maxLearningRate ?? 0.50;
        this.emaAlpha = config?.emaAlpha ?? 0.20;
        this.accelerationFactor = config?.accelerationFactor ?? 1.15;
        this.dampingFactor = config?.dampingFactor ?? 0.85;
    }

    public static getInstance(): AgentAdaptiveLearningRateManager {
        if (!AgentAdaptiveLearningRateManager.instance) {
            AgentAdaptiveLearningRateManager.instance = new AgentAdaptiveLearningRateManager();
        }
        return AgentAdaptiveLearningRateManager.instance;
    }

    public getLearningRate(agentId: string): number {
        const state = this.getOrCreateState(agentId);
        return state.learningRate;
    }

    public recordAgentStep(agentId: string, reward: number): {
        agentId: string;
        oldRate: number;
        newRate: number;
        emaReward: number;
        rewardVariance: number;
    } {
        const state = this.getOrCreateState(agentId);
        const oldRate = state.learningRate;

        // Update reward EMA and variance (Welford-like)
        const delta = reward - state.emaReward;
        state.emaReward += this.emaAlpha * delta;
        state.rewardVariance = (1 - this.emaAlpha) * (state.rewardVariance + this.emaAlpha * delta * delta);
        state.totalUpdates++;

        // Success vs failure streak
        if (reward >= 0.70) {
            state.consecutiveSuccesses++;
            state.consecutiveFailures = 0;
        } else if (reward < 0.40) {
            state.consecutiveFailures++;
            state.consecutiveSuccesses = 0;
        } else {
            state.consecutiveSuccesses = 0;
            state.consecutiveFailures = 0;
        }

        // Adaptive rule:
        // High variance or repeated failures -> increase rate to explore out of suboptimal regions
        // Consistent successes -> damp rate to settle into optimum
        if (state.consecutiveSuccesses >= 3) {
            state.learningRate = Math.max(this.minRate, state.learningRate * this.dampingFactor);
        } else if (state.consecutiveFailures >= 2 || state.rewardVariance > 0.15) {
            state.learningRate = Math.min(this.maxRate, state.learningRate * this.accelerationFactor);
        }

        state.learningRate = Math.round(state.learningRate * 1000) / 1000;

        return {
            agentId,
            oldRate,
            newRate: state.learningRate,
            emaReward: Math.round(state.emaReward * 1000) / 1000,
            rewardVariance: Math.round(state.rewardVariance * 1000) / 1000
        };
    }

    public getOrCreateState(agentId: string): AgentLearningState {
        if (!this.agentStates.has(agentId)) {
            this.agentStates.set(agentId, {
                agentId,
                learningRate: this.defaultRate,
                emaReward: 0.50,
                rewardVariance: 0.05,
                consecutiveSuccesses: 0,
                consecutiveFailures: 0,
                totalUpdates: 0
            });
        }
        return this.agentStates.get(agentId)!;
    }

    public getAllStates(): AgentLearningState[] {
        return Array.from(this.agentStates.values());
    }

    public reset(): void {
        this.agentStates.clear();
    }
}

export interface InteragentMessage {
    id: string;
    senderId: string;
    targetId: string | 'broadcast';
    topic: string;
    payload: any;
    timestamp: number;
    latencyNs?: number;
}

/**
 * Circular ring-buffer message bus for ultra-low latency, high-bandwidth interagent communication.
 */
export class HighBandwidthMessageChannel {
    private capacity: number;
    private ringBuffer: Array<InteragentMessage | null>;
    private head: number = 0;
    private tail: number = 0;
    private size: number = 0;
    private subscribers: Map<string, Array<(msg: InteragentMessage) => void>> = new Map();

    public constructor(capacity: number = 1024) {
        this.capacity = capacity;
        this.ringBuffer = new Array(capacity).fill(null);
    }

    public publish(messageInput: {
        senderId: string;
        targetId?: string;
        topic: string;
        payload: any;
    }): InteragentMessage {
        const msg: InteragentMessage = {
            id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            senderId: messageInput.senderId,
            targetId: messageInput.targetId || 'broadcast',
            topic: messageInput.topic,
            payload: messageInput.payload,
            timestamp: Date.now()
        };

        this.ringBuffer[this.tail] = msg;
        this.tail = (this.tail + 1) % this.capacity;

        if (this.size < this.capacity) {
            this.size++;
        } else {
            this.head = (this.head + 1) % this.capacity; // Overwrite oldest
        }

        this.dispatch(msg);
        return msg;
    }

    public subscribe(topic: string, listener: (msg: InteragentMessage) => void): () => void {
        if (!this.subscribers.has(topic)) {
            this.subscribers.set(topic, []);
        }
        this.subscribers.get(topic)!.push(listener);

        return () => {
            const list = this.subscribers.get(topic) || [];
            this.subscribers.set(topic, list.filter(l => l !== listener));
        };
    }

    private dispatch(msg: InteragentMessage): void {
        // Topic listeners
        const topicListeners = this.subscribers.get(msg.topic) || [];
        for (const listener of topicListeners) {
            try { listener(msg); } catch (err) { console.warn('[MessageChannel] Listener error:', err); }
        }

        // Wildcard / broadcast listeners
        const wildcard = this.subscribers.get('*') || [];
        for (const listener of wildcard) {
            try { listener(msg); } catch (err) { console.warn('[MessageChannel] Listener error:', err); }
        }
    }

    public getRecentMessages(count: number = 20): InteragentMessage[] {
        const msgs: InteragentMessage[] = [];
        const n = Math.min(this.size, count);
        for (let i = 0; i < n; i++) {
            const idx = (this.tail - 1 - i + this.capacity) % this.capacity;
            const msg = this.ringBuffer[idx];
            if (msg) msgs.push(msg);
        }
        return msgs;
    }

    public clear(): void {
        this.ringBuffer.fill(null);
        this.head = 0;
        this.tail = 0;
        this.size = 0;
        this.subscribers.clear();
    }
}

export interface StrategicSubtask {
    id: string;
    title: string;
    assignedRole: string;
    dependencies: string[];
    priority: number;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    outputSnippet?: string;
}

export interface TaskDecompositionPlan {
    macroTask: string;
    strategySummary: string;
    subtasks: StrategicSubtask[];
    executionWaves: string[][]; // Array of subtask ID batches executable in parallel
    timestamp: number;
}

/**
 * Higher-level agent task decomposition engine breaking macro-tasks into strategic subtasks.
 */
export class HierarchicalTaskDecomposer {
    public decompose(macroTask: string, availableRoles: string[]): TaskDecompositionPlan {
        const roles = availableRoles.length > 0 ? availableRoles : ['Security Analyst', 'Performance Analyst', 'Infrastructure Analyst'];
        const subtasks: StrategicSubtask[] = [];

        // 1. Telemetry and Environment Profiling (prerequisite)
        subtasks.push({
            id: 'sub-env-profile',
            title: `Profile environment baselines for ${macroTask}`,
            assignedRole: roles.find(r => r.toLowerCase().includes('infra')) || roles[0],
            dependencies: [],
            priority: 1,
            status: 'pending'
        });

        // 2. Domain-Specific In-Depth Audits (dependent on 1)
        const auditRoles = roles.filter(r => !r.toLowerCase().includes('infra'));
        if (auditRoles.length === 0) auditRoles.push(roles[0]);

        for (let i = 0; i < auditRoles.length; i++) {
            const role = auditRoles[i];
            subtasks.push({
                id: `sub-audit-${i + 1}`,
                title: `Execute deep specialist audit: ${role}`,
                assignedRole: role,
                dependencies: ['sub-env-profile'],
                priority: 2,
                status: 'pending'
            });
        }

        // 3. Synthesis & Mitigation Formulation (dependent on all audits)
        subtasks.push({
            id: 'sub-synthesis',
            title: `Synthesize multi-domain findings and mitigation actions for ${macroTask}`,
            assignedRole: 'Manager Node',
            dependencies: subtasks.map(s => s.id),
            priority: 3,
            status: 'pending'
        });

        const waves = this.computeWaves(subtasks);

        return {
            macroTask,
            strategySummary: `Decomposed into ${subtasks.length} strategic subtasks across ${waves.length} sequential execution waves.`,
            subtasks,
            executionWaves: waves,
            timestamp: Date.now()
        };
    }

    private computeWaves(subtasks: StrategicSubtask[]): string[][] {
        const completed = new Set<string>();
        const remaining = new Map<string, StrategicSubtask>(subtasks.map(s => [s.id, s]));
        const waves: string[][] = [];

        while (remaining.size > 0) {
            const currentWave: string[] = [];
            for (const [id, task] of remaining.entries()) {
                const canExecute = task.dependencies.every(dep => completed.has(dep));
                if (canExecute) {
                    currentWave.push(id);
                }
            }

            if (currentWave.length === 0) {
                // Cycle or unresolvable dependency fallback
                currentWave.push(Array.from(remaining.keys())[0]);
            }

            for (const id of currentWave) {
                completed.add(id);
                remaining.delete(id);
            }
            waves.push(currentWave);
        }

        return waves;
    }
}

export type HypothesisStatus = 'proposed' | 'validated' | 'refuted' | 'pruned';

export interface Hypothesis {
    id: string;
    claim: string;
    proposedBy: string;
    confidence: number; // 0.0 - 1.0
    evidence: string[];
    status: HypothesisStatus;
    validationFeedback?: string;
    timestamp: number;
}

/**
 * Hierarchical decision-making layer allowing lower-level agents to propose hypotheses
 * and higher-level agents/critics to arbitrate, validate, or prune them.
 */
export class HypothesisValidationLayer {
    private hypotheses: Map<string, Hypothesis> = new Map();
    private knowledgeGraph: SharedKnowledgeGraph;

    public constructor(kg: SharedKnowledgeGraph = globalKnowledgeGraph) {
        this.knowledgeGraph = kg;
    }

    public proposeHypothesis(input: {
        claim: string;
        proposedBy: string;
        confidence?: number;
        evidence?: string[];
    }): Hypothesis {
        const claimNormalized = input.claim.trim();
        // Check for redundant identical hypothesis
        for (const existing of this.hypotheses.values()) {
            if (existing.claim.toLowerCase() === claimNormalized.toLowerCase() && existing.status !== 'refuted') {
                // Merge evidence and adjust confidence
                if (input.evidence) {
                    existing.evidence = Array.from(new Set([...existing.evidence, ...input.evidence]));
                }
                existing.confidence = Math.min(1.0, (existing.confidence + (input.confidence ?? 0.5)) / 2 + 0.1);
                return existing;
            }
        }

        const id = `hypo-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const hypothesis: Hypothesis = {
            id,
            claim: claimNormalized,
            proposedBy: input.proposedBy,
            confidence: input.confidence ?? 0.6,
            evidence: input.evidence || [],
            status: 'proposed',
            timestamp: Date.now()
        };

        this.hypotheses.set(id, hypothesis);
        return hypothesis;
    }

    public validateHypothesis(id: string, decision: {
        isValid: boolean;
        validatedBy: string;
        feedback?: string;
        confidenceAdjustment?: number;
    }): Hypothesis | undefined {
        const hypothesis = this.hypotheses.get(id);
        if (!hypothesis) return undefined;

        if (decision.isValid) {
            hypothesis.status = 'validated';
            hypothesis.confidence = Math.min(1.0, (hypothesis.confidence + (decision.confidenceAdjustment ?? 0.3)));
            hypothesis.validationFeedback = decision.feedback || `Validated by ${decision.validatedBy}`;

            // Propagate validated finding to the Shared Knowledge Graph!
            this.knowledgeGraph.addNode({
                id: `node-${hypothesis.id}`,
                type: 'finding',
                label: hypothesis.claim,
                confidence: hypothesis.confidence,
                properties: {
                    validatedBy: decision.validatedBy,
                    evidence: hypothesis.evidence,
                    originalHypothesisId: hypothesis.id
                }
            });
        } else {
            hypothesis.status = 'refuted';
            hypothesis.confidence = Math.max(0.0, hypothesis.confidence - 0.5);
            hypothesis.validationFeedback = decision.feedback || `Refuted by ${decision.validatedBy}`;
        }

        return hypothesis;
    }

    public pruneRedundantHypotheses(): { prunedCount: number; remainingCount: number } {
        let pruned = 0;
        for (const [id, h] of this.hypotheses.entries()) {
            if (h.status === 'refuted' || h.confidence < 0.25) {
                h.status = 'pruned';
                pruned++;
            }
        }
        return {
            prunedCount: pruned,
            remainingCount: Array.from(this.hypotheses.values()).filter(h => h.status !== 'pruned').length
        };
    }

    public getHypotheses(status?: HypothesisStatus): Hypothesis[] {
        let list = Array.from(this.hypotheses.values());
        if (status) {
            list = list.filter(h => h.status === status);
        }
        return list;
    }

    public clear(): void {
        this.hypotheses.clear();
    }
}

export interface ShapedRewardParams {
    extrinsicReward: number; // Task outcome accuracy & SLA score
    noveltyScore: number;    // Unexplored state/parameter novelty
    redundancyCount: number; // Duplicated queries or redundant actions
    noveltyWeight?: number;  // beta parameter
    redundancyPenalty?: number; // gamma parameter
}

/**
 * Reinforcement-learning based reward shaping that balances novel strategy exploration
 * with proven tactic exploitation.
 */
export class ShapedRewardPolicy {
    private beta: number; // Novelty exploration weight
    private gamma: number; // Redundancy penalty weight

    public constructor(beta: number = 0.20, gamma: number = 0.15) {
        this.beta = beta;
        this.gamma = gamma;
    }

    public calculateShapedReward(params: ShapedRewardParams): {
        shapedReward: number;
        components: {
            extrinsic: number;
            noveltyBonus: number;
            redundancyPenalty: number;
        };
    } {
        const noveltyBonus = Math.min(1.0, Math.max(0, params.noveltyScore)) * (params.noveltyWeight ?? this.beta);
        const redundancyPenalty = Math.min(1.0, params.redundancyCount * 0.1) * (params.redundancyPenalty ?? this.gamma);

        const raw = params.extrinsicReward + noveltyBonus - redundancyPenalty;
        const shapedReward = Math.max(-1.0, Math.min(1.0, Math.round(raw * 1000) / 1000));

        return {
            shapedReward,
            components: {
                extrinsic: params.extrinsicReward,
                noveltyBonus: Math.round(noveltyBonus * 1000) / 1000,
                redundancyPenalty: Math.round(redundancyPenalty * 1000) / 1000
            }
        };
    }
}

export const globalLearningRateManager = AgentAdaptiveLearningRateManager.getInstance();
export const globalMessageChannel = new HighBandwidthMessageChannel();
export const globalTaskDecomposer = new HierarchicalTaskDecomposer();
export const globalHypothesisLayer = new HypothesisValidationLayer();
export const globalShapedRewardPolicy = new ShapedRewardPolicy();
