import type { PerformanceMetricsSnapshot, RewardSignal, RewardWeights, TunableParameters } from './types.ts';
import { DEFAULT_TUNABLE_PARAMETERS, PARAMETER_BOUNDS } from './types.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';
/**
 * Evaluates composite reward signals and tunes swarm policy parameters using evolutionary mutation
 * ((1+lambda)-ES) and contextual exploration-exploitation.
 */
export class PolicyOptimizer {
    private currentPolicy: TunableParameters;
    private bestPolicy: TunableParameters;
    private bestReward: number = -Infinity;
    private rewardHistory: number[] = [];
    private generation: number = 0;
    private mutationStep: number = 0.1; // Adapts via 1/5th success rule
    private successfulMutations: number = 0;
    private totalMutations: number = 0;

    private weights: RewardWeights = {
        quality: 0.35,
        accuracy: 0.35,
        latency: 0.15,
        cost: 0.05,
        tokenSavings: 0.10
    };

    public constructor(initialParameters?: Partial<TunableParameters>, weights?: Partial<RewardWeights>) {
        this.currentPolicy = { ...DEFAULT_TUNABLE_PARAMETERS, ...initialParameters };
        this.bestPolicy = { ...this.currentPolicy };
        if (weights) {
            this.weights = { ...this.weights, ...weights };
        }
    }

    public calculateReward(metrics: PerformanceMetricsSnapshot): RewardSignal {
        const quality = metrics.qualityScore ?? 0.8;
        const failovers = metrics.failoverCount ?? 0;
        const hardErrors = metrics.hardErrorCount !== undefined
            ? metrics.hardErrorCount
            : Math.max(0, (metrics.errorCount ?? 0) - failovers);

        // Accuracy term uses hard errors only; failovers get a small separate penalty (-0.02 each, capped at 0.06)
        const failoverPenalty = Math.min(0.06, failovers * 0.02);
        const baseAccuracy = metrics.accuracyScore ?? (hardErrors === 0 ? 0.9 : Math.max(0.1, 1 - hardErrors * 0.3));
        const accuracy = Math.max(0.1, baseAccuracy - failoverPenalty);

        const normalizedLatencyPenalty = Math.min(1.0, metrics.durationMs / 120000);
        const normalizedCostPenalty = Math.min(1.0, metrics.tokensConsumed / 100000);
        const normalizedSavingsReward = Math.min(1.0, metrics.tokenSavings / 4000);

        const qualityPart = quality * this.weights.quality;
        const accuracyPart = accuracy * this.weights.accuracy;
        const latencyPart = -normalizedLatencyPenalty * this.weights.latency;
        const costPart = -normalizedCostPenalty * this.weights.cost;
        const savingsPart = normalizedSavingsReward * this.weights.tokenSavings;

        const rawReward = qualityPart + accuracyPart + latencyPart + costPart + savingsPart;
        // Bound to [-1.0, 1.0]
        const compositeReward = Math.max(-1.0, Math.min(1.0, Math.round(rawReward * 1000) / 1000));

        return {
            compositeReward,
            components: {
                qualityReward: Math.round(qualityPart * 1000) / 1000,
                accuracyReward: Math.round(accuracyPart * 1000) / 1000,
                latencyPenalty: Math.round(latencyPart * 1000) / 1000,
                costPenalty: Math.round(costPart * 1000) / 1000,
                savingsReward: Math.round(savingsPart * 1000) / 1000,
                failoverPenalty: Math.round(-failoverPenalty * this.weights.accuracy * 1000) / 1000
            },
            weights: { ...this.weights },
            timestamp: Date.now()
        };
    }

    /**
     * Mutates a parent parameter set within defined bounds.
     */
    public mutate(parent: TunableParameters, rate: number = this.mutationStep): TunableParameters {
        const child: TunableParameters = { ...parent };
        const keys = Object.keys(PARAMETER_BOUNDS) as Array<keyof TunableParameters>;

        for (const key of keys) {
            // Apply probabilistic mutation
            if (Math.random() < 0.5) {
                const bounds = PARAMETER_BOUNDS[key];
                const span = bounds.max - bounds.min;
                // Gaussian-like perturbation (-1 to 1)
                const delta = (Math.random() - 0.5) * 2 * rate * span;
                let val = child[key] + delta;
                val = Math.max(bounds.min, Math.min(bounds.max, val));

                if (bounds.isInteger) {
                    val = Math.round(val);
                } else {
                    val = Math.round(val * 100) / 100;
                }
                child[key] = val;
            }
        }
        return child;
    }

    /**
     * Updates policy using evolutionary selection and Rechenberg's 1/5th adaptation rule.
     */
    public updateWithFeedback(reward: RewardSignal, proposedParams?: TunableParameters): {
        updated: boolean;
        currentPolicy: TunableParameters;
        generation: number;
        mutationStep: number;
    } {
        const score = reward.compositeReward;
        this.rewardHistory.push(score);
        if (this.rewardHistory.length > 1000) {
            this.rewardHistory.shift();
        }
        this.generation++;
        this.totalMutations++;

        let updated = false;

        if (proposedParams && score > this.bestReward) {
            this.bestReward = score;
            this.bestPolicy = { ...proposedParams };
            this.currentPolicy = { ...proposedParams };
            this.successfulMutations++;
            updated = true;
        } else if (!proposedParams) {
            // Baseline observation
            if (score > this.bestReward || this.bestReward === -Infinity) {
                this.bestReward = score;
                this.bestPolicy = { ...this.currentPolicy };
            }
        }

        // Rechenberg 1/5 rule every 10 iterations
        if (this.totalMutations % 10 === 0) {
            const successRatio = this.successfulMutations / 10;
            if (successRatio > 0.2) {
                this.mutationStep = Math.min(0.5, this.mutationStep * 1.2);
            } else {
                this.mutationStep = Math.max(0.02, this.mutationStep * 0.8);
            }
            this.successfulMutations = 0;
        }

        return {
            updated,
            currentPolicy: { ...this.currentPolicy },
            generation: this.generation,
            mutationStep: Math.round(this.mutationStep * 1000) / 1000
        };
    }

    public proposeNextParameters(): TunableParameters {
        // Epsilon-greedy evolutionary exploration
        if (Math.random() < this.currentPolicy.explorationFactor) {
            return this.mutate(this.bestPolicy, this.mutationStep);
        }
        return { ...this.bestPolicy };
    }

    public getCurrentPolicy(): TunableParameters {
        return { ...this.currentPolicy };
    }

    public getBestPolicy(): TunableParameters {
        return { ...this.bestPolicy };
    }

    public setPolicy(params: Partial<TunableParameters>): void {
        this.currentPolicy = { ...this.currentPolicy, ...params };
        this.bestPolicy = { ...this.currentPolicy };
    }

    public reset(): void {
        this.currentPolicy = { ...DEFAULT_TUNABLE_PARAMETERS };
        this.bestPolicy = { ...this.currentPolicy };
        this.bestReward = -Infinity;
        this.rewardHistory = [];
        this.generation = 0;
        this.mutationStep = 0.1;
        this.successfulMutations = 0;
        this.totalMutations = 0;
    }
}

/**
 * Sequential statistical change-point detection (Page-Hinkley test) and embedding centroid divergence detector.
 */
