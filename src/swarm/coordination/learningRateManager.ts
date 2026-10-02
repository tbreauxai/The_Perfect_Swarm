import type { AgentLearningState, AdaptiveLearningRateConfig } from './types.ts';

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
