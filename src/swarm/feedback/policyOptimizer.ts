import type {
    PerformanceMetricsSnapshot,
    RewardSignal,
    RewardWeights,
    TunableParameters,
    GradedOutcomeObservation,
    CalibrationResult
} from './types.ts';
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

    public getWeights(): RewardWeights {
        return { ...this.weights };
    }

    public setWeights(weights: Partial<RewardWeights>): void {
        this.weights = { ...this.weights, ...weights };
    }

    public calculateCompositeRewardWithWeights(metrics: PerformanceMetricsSnapshot, weights: RewardWeights): number {
        const quality = metrics.qualityScore ?? 0.8;
        const failovers = metrics.failoverCount ?? 0;
        const hardErrors = metrics.hardErrorCount !== undefined
            ? metrics.hardErrorCount
            : Math.max(0, (metrics.errorCount ?? 0) - failovers);

        const failoverPenalty = Math.min(0.06, failovers * 0.02);
        const baseAccuracy = metrics.accuracyScore ?? (hardErrors === 0 ? 0.9 : Math.max(0.1, 1 - hardErrors * 0.3));
        const accuracy = Math.max(0.1, baseAccuracy - failoverPenalty);

        const normalizedLatencyPenalty = Math.min(1.0, metrics.durationMs / 120000);
        const normalizedCostPenalty = Math.min(1.0, metrics.tokensConsumed / 100000);
        const normalizedSavingsReward = Math.min(1.0, metrics.tokenSavings / 4000);

        const qualityPart = quality * weights.quality;
        const accuracyPart = accuracy * weights.accuracy;
        const latencyPart = -normalizedLatencyPenalty * weights.latency;
        const costPart = -normalizedCostPenalty * weights.cost;
        const savingsPart = normalizedSavingsReward * weights.tokenSavings;

        const rawReward = qualityPart + accuracyPart + latencyPart + costPart + savingsPart;
        return Math.max(-1.0, Math.min(1.0, Math.round(rawReward * 1000) / 1000));
    }

    public computeCorrelation(
        observations: GradedOutcomeObservation[],
        customWeights?: RewardWeights
    ): { correlation: number; mse: number } {
        if (!observations || observations.length === 0) {
            return { correlation: 0, mse: 0 };
        }

        const weights = customWeights || this.weights;
        const n = observations.length;
        const xs: number[] = [];
        const ys: number[] = [];

        for (const obs of observations) {
            const rawReward = this.calculateCompositeRewardWithWeights(obs.metrics, weights);
            const predNorm = Math.max(0, Math.min(1, (rawReward + 1) / 2));

            let target = 0.5;
            if (obs.outcome === 'win') target = 1.0;
            else if (obs.outcome === 'loss') target = 0.0;
            else if (obs.outcome === 'push') target = 0.5;
            else if (typeof obs.outcome === 'number') target = Math.max(0, Math.min(1, obs.outcome));

            xs.push(predNorm);
            ys.push(target);
        }

        let sumSquaredError = 0;
        for (let i = 0; i < n; i++) {
            sumSquaredError += Math.pow(xs[i] - ys[i], 2);
        }
        const mse = Math.round((sumSquaredError / n) * 10000) / 10000;

        if (n < 2) {
            return { correlation: 0, mse };
        }

        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = ys.reduce((a, b) => a + b, 0) / n;

        let cov = 0;
        let varX = 0;
        let varY = 0;

        for (let i = 0; i < n; i++) {
            const dx = xs[i] - meanX;
            const dy = ys[i] - meanY;
            cov += dx * dy;
            varX += dx * dx;
            varY += dy * dy;
        }

        if (varX <= 1e-9 || varY <= 1e-9) {
            return { correlation: 0, mse };
        }

        const correlation = Math.round((cov / Math.sqrt(varX * varY)) * 10000) / 10000;
        return { correlation, mse };
    }

    public calibrateRewardWeights(
        observations: GradedOutcomeObservation[],
        options?: { iterations?: number; autoApply?: boolean }
    ): CalibrationResult {
        const initial = this.computeCorrelation(observations, this.weights);
        if (!observations || observations.length < 2) {
            return {
                optimalWeights: { ...this.weights },
                initialCorrelation: initial.correlation,
                calibratedCorrelation: initial.correlation,
                initialMse: initial.mse,
                calibratedMse: initial.mse,
                sampleSize: observations ? observations.length : 0,
                applied: false
            };
        }

        const iterations = options?.iterations ?? 400;
        let bestWeights = { ...this.weights };
        let bestScore = initial.correlation - (initial.mse * 0.5);
        let bestCorr = initial.correlation;
        let bestMse = initial.mse;

        const weightKeys: Array<keyof RewardWeights> = ['quality', 'accuracy', 'latency', 'cost', 'tokenSavings'];

        const MIN_BOUNDS: RewardWeights = {
            quality: 0.10,
            accuracy: 0.15,
            latency: 0.02,
            cost: 0.01,
            tokenSavings: 0.02
        };

        const MAX_BOUNDS: RewardWeights = {
            quality: 0.60,
            accuracy: 0.65,
            latency: 0.35,
            cost: 0.20,
            tokenSavings: 0.25
        };

        for (let iter = 0; iter < iterations; iter++) {
            const candidate: RewardWeights = { ...bestWeights };
            const k1 = weightKeys[Math.floor(Math.random() * weightKeys.length)];
            const k2 = weightKeys[Math.floor(Math.random() * weightKeys.length)];

            const step = (Math.random() - 0.5) * 0.10;
            candidate[k1] = Math.min(MAX_BOUNDS[k1], Math.max(MIN_BOUNDS[k1], candidate[k1] + step));
            if (k1 !== k2) {
                candidate[k2] = Math.min(MAX_BOUNDS[k2], Math.max(MIN_BOUNDS[k2], candidate[k2] - step));
            }

            const total = candidate.quality + candidate.accuracy + candidate.latency + candidate.cost + candidate.tokenSavings;
            if (total > 0) {
                candidate.quality = Math.max(MIN_BOUNDS.quality, Math.round((candidate.quality / total) * 1000) / 1000);
                candidate.accuracy = Math.max(MIN_BOUNDS.accuracy, Math.round((candidate.accuracy / total) * 1000) / 1000);
                candidate.latency = Math.max(MIN_BOUNDS.latency, Math.round((candidate.latency / total) * 1000) / 1000);
                candidate.cost = Math.max(MIN_BOUNDS.cost, Math.round((candidate.cost / total) * 1000) / 1000);
                const remainder = 1.0 - (candidate.quality + candidate.accuracy + candidate.latency + candidate.cost);
                candidate.tokenSavings = Math.max(MIN_BOUNDS.tokenSavings, Math.round(remainder * 1000) / 1000);
            }

            const evalRes = this.computeCorrelation(observations, candidate);
            const score = evalRes.correlation - (evalRes.mse * 0.5);

            if (score > bestScore) {
                bestScore = score;
                bestCorr = evalRes.correlation;
                bestMse = evalRes.mse;
                bestWeights = { ...candidate };
            }
        }

        const autoApply = options?.autoApply !== false;
        const improved = bestCorr > initial.correlation || bestMse < initial.mse;
        if (autoApply && improved) {
            this.weights = { ...bestWeights };
        }

        return {
            optimalWeights: { ...bestWeights },
            initialCorrelation: initial.correlation,
            calibratedCorrelation: bestCorr,
            initialMse: initial.mse,
            calibratedMse: bestMse,
            sampleSize: observations.length,
            applied: autoApply && improved
        };
    }
}

/**
 * Sequential statistical change-point detection (Page-Hinkley test) and embedding centroid divergence detector.
 */
