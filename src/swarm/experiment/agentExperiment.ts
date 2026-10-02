import type {
    ExperimentStatus,
    AllocationStrategy,
    AgentVariantConfig,
    ExecutionMetrics,
    VariantPerformance,
    CircuitBreakerConfig,
    PromotionCriteria,
    CompositeScoreWeights,
    StatisticalComparison,
    ExperimentDecision,
    ExperimentConfig
} from './types.ts';
import { StatisticalAnalyzer } from './statisticalAnalyzer.ts';

/**
 * Manages an individual A/B experiment with variants, traffic allocation,
 * metrics tracking, automated statistical promotion, and circuit breakers.
 */
export class AgentExperiment {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    status: ExperimentStatus = 'draft';

    private variants: Map<string, AgentVariantConfig> = new Map();
    private baselineVariantId: string = 'control';
    private activeVariantId: string = 'control';
    private metricsHistory: Map<string, ExecutionMetrics[]> = new Map();

    private allocationStrategy: AllocationStrategy = 'deterministic_hash';
    private circuitBreakerConfig: CircuitBreakerConfig;
    private promotionCriteria: PromotionCriteria;
    private compositeWeights: CompositeScoreWeights;

    constructor(config: ExperimentConfig) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description;
        this.allocationStrategy = config.allocationStrategy ?? 'deterministic_hash';

        this.circuitBreakerConfig = {
            maxErrorRate: config.circuitBreaker?.maxErrorRate ?? 0.20,
            minRlaifScore: config.circuitBreaker?.minRlaifScore ?? 0.60,
            maxLatencyDegradationPercent: config.circuitBreaker?.maxLatencyDegradationPercent ?? 50,
            minSamplesBeforeTrigger: config.circuitBreaker?.minSamplesBeforeTrigger ?? 5
        };

        this.promotionCriteria = {
            minSampleSize: config.promotionCriteria?.minSampleSize ?? 10,
            confidenceLevel: config.promotionCriteria?.confidenceLevel ?? 0.95,
            minImprovementPercent: config.promotionCriteria?.minImprovementPercent ?? 5,
            primaryMetric: config.promotionCriteria?.primaryMetric ?? 'composite'
        };

        this.compositeWeights = config.compositeWeights ?? {
            rlaifWeight: 0.50,
            latencyWeight: 0.30,
            tokenWeight: 0.20,
            baselineLatencyMs: 2000,
            baselineTokens: 4000
        };

        for (const variant of config.variants) {
            this.addVariant(variant);
        }

        if (this.variants.size > 0) {
            this.status = 'active';
        }
    }

    addVariant(variant: AgentVariantConfig): void {
        this.variants.set(variant.variantId, { ...variant });
        if (!this.metricsHistory.has(variant.variantId)) {
            this.metricsHistory.set(variant.variantId, []);
        }
        if (variant.isBaseline || this.variants.size === 1) {
            this.baselineVariantId = variant.variantId;
            this.activeVariantId = variant.variantId;
        }
    }

    getVariant(variantId: string): AgentVariantConfig | undefined {
        return this.variants.get(variantId);
    }

    getVariants(): AgentVariantConfig[] {
        return Array.from(this.variants.values());
    }

    getBaselineVariant(): AgentVariantConfig {
        return this.variants.get(this.baselineVariantId) || this.variants.values().next().value!;
    }

    getActiveVariant(): AgentVariantConfig {
        return this.variants.get(this.activeVariantId) || this.getBaselineVariant();
    }

    start(): void {
        this.status = 'active';
    }

    pause(): void {
        this.status = 'paused';
    }

    /**
     * Fast hash function (DJB2) for deterministic key routing.
     */
    private static hashKey(key: string): number {
        let hash = 5381;
        for (let i = 0; i < key.length; i++) {
            hash = ((hash << 5) + hash) + key.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    /**
     * Allocates a variant for an incoming task based on the configured allocation strategy.
     */
    allocateVariant(routingKey?: string): AgentVariantConfig {
        if (this.status !== 'active') {
            return this.getActiveVariant();
        }

        const activeVariants = Array.from(this.variants.values());
        if (activeVariants.length === 0) {
            throw new Error(`Experiment ${this.id} has no registered variants`);
        }
        if (activeVariants.length === 1) {
            return activeVariants[0];
        }

        // 1. Thompson Sampling / Bandit allocation
        if (this.allocationStrategy === 'thompson_sampling') {
            let bestVariant = activeVariants[0];
            let bestSample = -Infinity;

            for (const v of activeVariants) {
                const perf = this.getPerformance(v.variantId);
                // Sample from Gaussian conjugate or mean + uncertainty
                const mean = perf.compositeScore;
                const std = perf.sampleCount > 1 
                    ? StatisticalAnalyzer.calculateStdDev(perf.history.map(h => StatisticalAnalyzer.calculateCompositeScore(h, this.compositeWeights))) 
                    : 0.3;
                const sample = mean + (std / Math.sqrt(Math.max(1, perf.sampleCount))) * (Math.random() * 2 - 1);

                if (sample > bestSample) {
                    bestSample = sample;
                    bestVariant = v;
                }
            }
            return bestVariant;
        }

        // 2. Deterministic Hash routing (consistent user/task sharding)
        if (this.allocationStrategy === 'deterministic_hash' && routingKey) {
            const totalWeight = activeVariants.reduce((sum, v) => sum + Math.max(0.01, v.trafficWeight), 0);
            const hash = AgentExperiment.hashKey(routingKey);
            const slot = (hash % 10000) / 10000; // [0, 1)

            let cumulative = 0;
            for (const v of activeVariants) {
                cumulative += Math.max(0.01, v.trafficWeight) / totalWeight;
                if (slot < cumulative) {
                    return v;
                }
            }
            return activeVariants[activeVariants.length - 1];
        }

        // 3. Standard Weighted Random selection
        const totalWeight = activeVariants.reduce((sum, v) => sum + Math.max(0.01, v.trafficWeight), 0);
        const randomPoint = Math.random();
        let cumulative = 0;
        for (const v of activeVariants) {
            cumulative += Math.max(0.01, v.trafficWeight) / totalWeight;
            if (randomPoint <= cumulative) {
                return v;
            }
        }

        return activeVariants[0];
    }

    /**
     * Records production execution metrics, evaluates circuit breakers,
     * and automatically promotes winning candidate variants when statistical criteria pass.
     */
    recordOutcome(variantId: string, metrics: ExecutionMetrics): ExperimentDecision {
        const history = this.metricsHistory.get(variantId);
        if (!history) {
            this.metricsHistory.set(variantId, [metrics]);
        } else {
            history.push({
                ...metrics,
                timestamp: metrics.timestamp || new Date().toISOString()
            });
        }

        const now = new Date().toISOString();

        // 1. Immediate Circuit Breaker Check
        const breakerCheck = this.checkCircuitBreaker(variantId);
        if (breakerCheck.tripped) {
            this.status = 'rolled_back';
            this.activeVariantId = this.baselineVariantId;
            return {
                experimentId: this.id,
                status: this.status,
                winningVariantId: this.baselineVariantId,
                action: 'circuit_breaker_rollback',
                reason: breakerCheck.reason || 'Circuit breaker tripped due to degraded performance.',
                timestamp: now
            };
        }

        // 2. Statistical Promotion Evaluation
        if (this.status === 'active' && variantId !== this.baselineVariantId) {
            const promotionEval = this.evaluatePromotion(variantId);
            if (promotionEval.canPromote && promotionEval.winningVariantId) {
                this.status = 'concluded';
                this.activeVariantId = promotionEval.winningVariantId;
                return {
                    experimentId: this.id,
                    status: this.status,
                    winningVariantId: promotionEval.winningVariantId,
                    action: 'promoted',
                    reason: promotionEval.reason || `Variant ${promotionEval.winningVariantId} promoted with statistical significance.`,
                    timestamp: now,
                    comparison: promotionEval.comparison
                };
            }
        }

        return {
            experimentId: this.id,
            status: this.status,
            winningVariantId: this.activeVariantId,
            action: 'none',
            reason: `Recorded metrics for variant ${variantId}. Ongoing experiment.`,
            timestamp: now
        };
    }

    /**
     * Circuit breaker safety verification.
     * Evaluates error rate, RLAIF quality score, and latency spikes against baseline.
     */
    checkCircuitBreaker(variantId: string): { tripped: boolean; reason?: string } {
        const perf = this.getPerformance(variantId);
        const minSamples = this.circuitBreakerConfig.minSamplesBeforeTrigger ?? 5;

        if (perf.sampleCount < minSamples) {
            return { tripped: false };
        }

        // 1. Error Rate Circuit Breaker
        const maxErrorRate = this.circuitBreakerConfig.maxErrorRate ?? 0.20;
        if (perf.errorRate > maxErrorRate) {
            return {
                tripped: true,
                reason: `Circuit Breaker: Variant ${variantId} error rate (${(perf.errorRate * 100).toFixed(1)}%) exceeded threshold (${(maxErrorRate * 100).toFixed(1)}%).`
            };
        }

        // 2. Minimum Quality Rating Circuit Breaker
        const minQuality = this.circuitBreakerConfig.minRlaifScore ?? 0.60;
        if (perf.meanRlaifScore < (minQuality - 1e-6)) {
            return {
                tripped: true,
                reason: `Circuit Breaker: Variant ${variantId} average RLAIF score (${perf.meanRlaifScore.toFixed(3)}) fell below safety floor (${minQuality.toFixed(3)}).`
            };
        }

        // 3. Severe Latency Degradation Check vs Baseline
        if (variantId !== this.baselineVariantId) {
            const baselinePerf = this.getPerformance(this.baselineVariantId);
            if (baselinePerf.sampleCount >= minSamples && baselinePerf.meanDurationMs > 0) {
                const maxDegradation = this.circuitBreakerConfig.maxLatencyDegradationPercent ?? 50;
                const latencyDeltaPercent = ((perf.meanDurationMs - baselinePerf.meanDurationMs) / baselinePerf.meanDurationMs) * 100;
                if (latencyDeltaPercent > maxDegradation) {
                    return {
                        tripped: true,
                        reason: `Circuit Breaker: Variant ${variantId} latency degraded by ${latencyDeltaPercent.toFixed(1)}% vs baseline (threshold: ${maxDegradation}%).`
                    };
                }
            }
        }

        return { tripped: false };
    }

    /**
     * Evaluates whether a treatment variant has reached statistical significance
     * and superiority over the control baseline.
     */
    evaluatePromotion(treatmentId: string): {
        canPromote: boolean;
        winningVariantId?: string;
        reason?: string;
        comparison?: StatisticalComparison;
    } {
        const controlId = this.baselineVariantId;
        const comparison = this.compareVariants(treatmentId, controlId);

        const minSamples = this.promotionCriteria.minSampleSize ?? 10;
        const treatmentPerf = this.getPerformance(treatmentId);
        const controlPerf = this.getPerformance(controlId);

        if (treatmentPerf.sampleCount < minSamples || controlPerf.sampleCount < minSamples) {
            return {
                canPromote: false,
                reason: `Insufficient samples (treatment: ${treatmentPerf.sampleCount}/${minSamples}, control: ${controlPerf.sampleCount}/${minSamples}).`,
                comparison
            };
        }

        if (comparison.recommendation === 'promote') {
            return {
                canPromote: true,
                winningVariantId: treatmentId,
                reason: comparison.reason,
                comparison
            };
        }

        return {
            canPromote: false,
            reason: comparison.reason,
            comparison
        };
    }

    /**
     * Performs Welch's t-test and effect-size analysis between treatment and control.
     */
    compareVariants(treatmentId: string, controlId: string = this.baselineVariantId): StatisticalComparison {
        const treatmentPerf = this.getPerformance(treatmentId);
        const controlPerf = this.getPerformance(controlId);

        const primaryMetric = this.promotionCriteria.primaryMetric ?? 'composite';
        const minImprovement = (this.promotionCriteria.minImprovementPercent ?? 5) / 100.0;
        const alpha = 1.0 - (this.promotionCriteria.confidenceLevel ?? 0.95);

        let treatmentSeries: number[] = [];
        let controlSeries: number[] = [];

        if (primaryMetric === 'rlaifScore') {
            treatmentSeries = treatmentPerf.history.map(m => m.rlaifScore ?? 0.85);
            controlSeries = controlPerf.history.map(m => m.rlaifScore ?? 0.85);
        } else if (primaryMetric === 'durationMs') {
            // For duration, smaller is better (invert sign so higher = better)
            treatmentSeries = treatmentPerf.history.map(m => -m.durationMs);
            controlSeries = controlPerf.history.map(m => -m.durationMs);
        } else {
            // composite utility score
            treatmentSeries = treatmentPerf.history.map(m => StatisticalAnalyzer.calculateCompositeScore(m, this.compositeWeights));
            controlSeries = controlPerf.history.map(m => StatisticalAnalyzer.calculateCompositeScore(m, this.compositeWeights));
        }

        const tTest = StatisticalAnalyzer.welchTTest(treatmentSeries, controlSeries);
        const controlMean = StatisticalAnalyzer.calculateMean(controlSeries);
        const treatmentMean = StatisticalAnalyzer.calculateMean(treatmentSeries);
        const delta = treatmentMean - controlMean;
        const percentChange = controlMean !== 0 ? (delta / Math.abs(controlMean)) * 100 : 0;
        const isStatisticallySignificant = tTest.pValue < alpha;

        let recommendation: StatisticalComparison['recommendation'] = 'continue';
        let reason = `p=${tTest.pValue.toFixed(4)}, delta=${delta.toFixed(4)} (${percentChange.toFixed(1)}%).`;

        if (isStatisticallySignificant) {
            if (delta > 0 && (percentChange / 100.0) >= minImprovement) {
                recommendation = 'promote';
                reason = `Statistically significant improvement detected (p=${tTest.pValue.toFixed(4)} < ${alpha}, +${percentChange.toFixed(1)}% improvement). Recommend promotion.`;
            } else if (delta < 0) {
                recommendation = 'rollback';
                reason = `Statistically significant degradation detected (p=${tTest.pValue.toFixed(4)} < ${alpha}, ${percentChange.toFixed(1)}% change). Recommend rollback.`;
            } else {
                recommendation = 'continue';
                reason = `Statistically significant but below minimum required delta (${(minImprovement * 100).toFixed(1)}%). Continuing test.`;
            }
        } else {
            recommendation = 'continue';
            reason = `No statistically significant difference yet (p=${tTest.pValue.toFixed(4)} >= ${alpha}). Continuing test.`;
        }

        return {
            controlVariantId: controlId,
            treatmentVariantId: treatmentId,
            metric: primaryMetric,
            controlMean,
            treatmentMean,
            delta,
            percentChange,
            tStatistic: tTest.tStat,
            degreesOfFreedom: tTest.df,
            pValue: tTest.pValue,
            isStatisticallySignificant,
            confidenceInterval95: tTest.ci95,
            recommendation,
            reason
        };
    }

    /**
     * Computes consolidated performance metrics for a specific variant.
     */
    getPerformance(variantId: string): VariantPerformance {
        const history = this.metricsHistory.get(variantId) || [];
        const sampleCount = history.length;

        if (sampleCount === 0) {
            return {
                variantId,
                sampleCount: 0,
                successCount: 0,
                errorCount: 0,
                errorRate: 0,
                meanDurationMs: 0,
                meanRlaifScore: 0,
                meanTokens: 0,
                compositeScore: 0,
                history: []
            };
        }

        let errorCount = 0;
        let totalDuration = 0;
        let totalRlaif = 0;
        let totalTokens = 0;
        let totalComposite = 0;

        for (const m of history) {
            if (m.error) errorCount++;
            totalDuration += m.durationMs || 0;
            totalRlaif += m.rlaifScore ?? 0.85;
            totalTokens += m.tokensTotal || 0;
            totalComposite += StatisticalAnalyzer.calculateCompositeScore(m, this.compositeWeights);
        }

        return {
            variantId,
            sampleCount,
            successCount: sampleCount - errorCount,
            errorCount,
            errorRate: errorCount / sampleCount,
            meanDurationMs: totalDuration / sampleCount,
            meanRlaifScore: totalRlaif / sampleCount,
            meanTokens: totalTokens / sampleCount,
            compositeScore: totalComposite / sampleCount,
            history
        };
    }

    getAllPerformances(): Record<string, VariantPerformance> {
        const result: Record<string, VariantPerformance> = {};
        for (const variantId of this.variants.keys()) {
            result[variantId] = this.getPerformance(variantId);
        }
        return result;
    }

    rollback(reason: string): ExperimentDecision {
        this.status = 'rolled_back';
        this.activeVariantId = this.baselineVariantId;
        return {
            experimentId: this.id,
            status: this.status,
            winningVariantId: this.baselineVariantId,
            action: 'circuit_breaker_rollback',
            reason,
            timestamp: new Date().toISOString()
        };
    }

    promote(variantId: string, reason: string): ExperimentDecision {
        if (!this.variants.has(variantId)) {
            throw new Error(`Cannot promote non-existent variant ${variantId}`);
        }
        this.status = 'concluded';
        this.activeVariantId = variantId;
        return {
            experimentId: this.id,
            status: this.status,
            winningVariantId: variantId,
            action: 'promoted',
            reason,
            timestamp: new Date().toISOString()
        };
    }

    toJSON(): object {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            status: this.status,
            allocationStrategy: this.allocationStrategy,
            baselineVariantId: this.baselineVariantId,
            activeVariantId: this.activeVariantId,
            variants: Array.from(this.variants.values()),
            circuitBreakerConfig: this.circuitBreakerConfig,
            promotionCriteria: this.promotionCriteria,
            compositeWeights: this.compositeWeights,
            metricsHistory: Object.fromEntries(this.metricsHistory.entries())
        };
    }

    static fromJSON(data: any): AgentExperiment {
        const exp = new AgentExperiment({
            id: data.id,
            name: data.name,
            description: data.description,
            variants: data.variants || [],
            allocationStrategy: data.allocationStrategy,
            circuitBreaker: data.circuitBreakerConfig,
            promotionCriteria: data.promotionCriteria,
            compositeWeights: data.compositeWeights
        });
        exp.status = data.status || 'draft';
        exp.baselineVariantId = data.baselineVariantId || exp.baselineVariantId;
        exp.activeVariantId = data.activeVariantId || exp.activeVariantId;
        if (data.metricsHistory) {
            for (const [vId, hist] of Object.entries(data.metricsHistory)) {
                exp.metricsHistory.set(vId, hist as ExecutionMetrics[]);
            }
        }
        return exp;
    }
}
