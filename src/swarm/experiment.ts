/**
 * Continuous Learning Loops & Automated A/B Testing Engine.
 * Provides statistical evaluation of agent configurations, prompt variants,
 * and specialist architectures against production metrics (RLAIF quality,
 * latency, token efficiency, and error rates) with automated promotion
 * and fail-safe circuit breaker rollbacks.
 */

import type { AgentConfig } from './types.ts';

export type ExperimentStatus = 'draft' | 'active' | 'paused' | 'concluded' | 'rolled_back';

export type AllocationStrategy = 'random' | 'deterministic_hash' | 'thompson_sampling' | 'epsilon_greedy';

export interface AgentVariantConfig {
    variantId: string;
    name: string;
    description?: string;
    isBaseline?: boolean;
    trafficWeight: number; // e.g. 0.50 (normalized against all active variants)
    agents?: AgentConfig[];
    systemPrompts?: Record<string, string>; // role/id -> custom system prompt
    parameters?: {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        [key: string]: any;
    };
    metadata?: Record<string, any>;
}

export interface ExecutionMetrics {
    durationMs: number;
    tokensTotal?: number;
    rlaifScore?: number; // 0.0 - 1.0 from Critic verification loop
    userRating?: number; // 0.0 - 1.0 optional external feedback
    error?: boolean;
    errorMessage?: string;
    anomaliesCount?: number;
    insightsCount?: number;
    metadata?: Record<string, any>;
    timestamp?: string;
}

export interface VariantPerformance {
    variantId: string;
    sampleCount: number;
    successCount: number;
    errorCount: number;
    errorRate: number;
    meanDurationMs: number;
    meanRlaifScore: number;
    meanTokens: number;
    compositeScore: number;
    history: ExecutionMetrics[];
}

export interface CircuitBreakerConfig {
    maxErrorRate?: number;                 // default: 0.20 (20% error threshold)
    minRlaifScore?: number;                // default: 0.60 (minimum acceptable quality rating)
    maxLatencyDegradationPercent?: number;  // default: 50% slower than baseline
    minSamplesBeforeTrigger?: number;      // default: 5 samples before circuit breaker can trip
}

export interface PromotionCriteria {
    minSampleSize?: number;                // default: 10 samples per variant
    confidenceLevel?: number;              // default: 0.95 (alpha = 0.05)
    minImprovementPercent?: number;        // default: 5% (0.05 improvement in primary metric)
    primaryMetric?: 'composite' | 'rlaifScore' | 'durationMs'; // default: 'composite'
}

export interface CompositeScoreWeights {
    rlaifWeight?: number;       // default: 0.50
    latencyWeight?: number;     // default: 0.30
    tokenWeight?: number;       // default: 0.20
    baselineLatencyMs?: number; // default: 2000ms
    baselineTokens?: number;    // default: 4000 tokens
}

export interface StatisticalComparison {
    controlVariantId: string;
    treatmentVariantId: string;
    metric: 'rlaifScore' | 'durationMs' | 'tokens' | 'composite';
    controlMean: number;
    treatmentMean: number;
    delta: number;
    percentChange: number;
    tStatistic: number;
    degreesOfFreedom: number;
    pValue: number;
    isStatisticallySignificant: boolean;
    confidenceInterval95: [number, number];
    recommendation: 'promote' | 'continue' | 'rollback' | 'inconclusive';
    reason: string;
}

export interface ExperimentDecision {
    experimentId: string;
    status: ExperimentStatus;
    winningVariantId?: string;
    action: 'none' | 'promoted' | 'circuit_breaker_rollback' | 'traffic_rebalanced';
    reason: string;
    timestamp: string;
    comparison?: StatisticalComparison;
}

export interface ExperimentConfig {
    id: string;
    name: string;
    description?: string;
    variants: AgentVariantConfig[];
    allocationStrategy?: AllocationStrategy;
    circuitBreaker?: CircuitBreakerConfig;
    promotionCriteria?: PromotionCriteria;
    compositeWeights?: CompositeScoreWeights;
}

/**
 * Pure statistical math utilities for A/B testing:
 * Sample variance, Welch's t-test, normal CDF, and composite utility scoring.
 */
export class StatisticalAnalyzer {
    static calculateMean(values: number[]): number {
        if (!values || values.length === 0) return 0;
        const sum = values.reduce((acc, v) => acc + v, 0);
        return sum / values.length;
    }

    static calculateVariance(values: number[], precomputedMean?: number): number {
        if (!values || values.length < 2) return 0;
        const mean = precomputedMean ?? StatisticalAnalyzer.calculateMean(values);
        const sumSquareDiffs = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0);
        return sumSquareDiffs / (values.length - 1);
    }

    static calculateStdDev(values: number[], precomputedMean?: number): number {
        return Math.sqrt(StatisticalAnalyzer.calculateVariance(values, precomputedMean));
    }

    /**
     * Standard Normal Cumulative Distribution Function (CDF)
     * using Abramowitz & Stegun polynomial approximation (error < 1.5e-7).
     */
    static normalCdf(z: number): number {
        const sign = z < 0 ? -1 : 1;
        const absZ = Math.abs(z);
        const p = 0.3275911;
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const t = 1.0 / (1.0 + p * (absZ / Math.SQRT2));
        const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ / 2.0);
        return 0.5 * (1.0 + sign * erf);
    }

    /**
     * Critical t-value for two-tailed 95% confidence interval given degrees of freedom.
     */
    static getCriticalT95(df: number): number {
        if (df <= 1) return 12.706;
        if (df <= 2) return 4.303;
        if (df <= 3) return 3.182;
        if (df <= 4) return 2.776;
        if (df <= 5) return 2.571;
        if (df <= 10) return 2.228;
        if (df <= 20) return 2.086;
        if (df <= 30) return 2.042;
        if (df <= 60) return 2.000;
        if (df <= 120) return 1.980;
        return 1.960;
    }

    /**
     * Welch's t-test for comparing two independent samples with unequal variances.
     * Computes t-statistic, degrees of freedom via Welch-Satterthwaite, two-tailed p-value,
     * and 95% confidence interval for the difference of means (treatment - control).
     */
    static welchTTest(
        treatment: number[],
        control: number[]
    ): { tStat: number; df: number; pValue: number; ci95: [number, number] } {
        const n1 = treatment.length;
        const n2 = control.length;

        if (n1 < 2 || n2 < 2) {
            return { tStat: 0, df: 1, pValue: 1.0, ci95: [0, 0] };
        }

        const mean1 = StatisticalAnalyzer.calculateMean(treatment);
        const mean2 = StatisticalAnalyzer.calculateMean(control);
        const var1 = StatisticalAnalyzer.calculateVariance(treatment, mean1);
        const var2 = StatisticalAnalyzer.calculateVariance(control, mean2);

        const v1 = var1 / n1;
        const v2 = var2 / n2;
        const se = Math.sqrt(v1 + v2);
        const delta = mean1 - mean2;

        if (se === 0 || isNaN(se)) {
            if (delta === 0) {
                return { tStat: 0, df: n1 + n2 - 2, pValue: 1.0, ci95: [0, 0] };
            }
            return {
                tStat: delta > 0 ? 100 : -100,
                df: n1 + n2 - 2,
                pValue: 0.0,
                ci95: [delta, delta]
            };
        }

        const tStat = delta / se;

        // Welch-Satterthwaite equation for degrees of freedom
        const numerator = Math.pow(v1 + v2, 2);
        const denominator = (Math.pow(v1, 2) / (n1 - 1)) + (Math.pow(v2, 2) / (n2 - 1));
        const df = denominator > 0 ? Math.max(1, numerator / denominator) : 1;

        // Approximate Student's t distribution p-value via transform to standard normal
        const z = Math.abs(tStat) * (1.0 - 1.0 / (4.0 * df)) / Math.sqrt(1.0 + (Math.pow(tStat, 2) / (2.0 * df)));
        const pValue = Math.max(0, Math.min(1, 2.0 * (1.0 - StatisticalAnalyzer.normalCdf(z))));

        // 95% Confidence Interval for delta (treatmentMean - controlMean)
        const tCrit = StatisticalAnalyzer.getCriticalT95(df);
        const marginOfError = tCrit * se;
        const ci95: [number, number] = [delta - marginOfError, delta + marginOfError];

        return { tStat, df, pValue, ci95 };
    }

    /**
     * Computes a normalized composite utility score (0.0 to 1.0) balancing:
     * - RLAIF verification score (positive)
     * - Latency efficiency (positive when low)
     * - Token efficiency (positive when low)
     * - Error penalty (severe reduction on failure)
     */
    static calculateCompositeScore(
        metrics: ExecutionMetrics,
        weights?: CompositeScoreWeights
    ): number {
        if (metrics.error) {
            return 0.05; // Base floor for hard failures
        }

        const rlaifWeight = weights?.rlaifWeight ?? 0.50;
        const latencyWeight = weights?.latencyWeight ?? 0.30;
        const tokenWeight = weights?.tokenWeight ?? 0.20;
        const baselineLatency = weights?.baselineLatencyMs ?? 2000;
        const baselineTokens = weights?.baselineTokens ?? 4000;

        // 1. RLAIF Quality component [0, 1]
        const rlaifPart = Math.max(0, Math.min(1, metrics.rlaifScore ?? 0.85));

        // 2. Latency component [0, 1] (shorter duration = higher score)
        const dur = Math.max(0, metrics.durationMs);
        const latencyPart = Math.max(0, 1.0 - (dur / (2.0 * baselineLatency)));

        // 3. Token efficiency component [0, 1] (fewer tokens = higher score)
        const tokens = Math.max(0, metrics.tokensTotal ?? baselineTokens);
        const tokenPart = Math.max(0, 1.0 - (tokens / (2.0 * baselineTokens)));

        const totalWeight = rlaifWeight + latencyWeight + tokenWeight;
        const score = (
            (rlaifPart * rlaifWeight) +
            (latencyPart * latencyWeight) +
            (tokenPart * tokenWeight)
        ) / totalWeight;

        return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
    }
}

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

/**
 * Global registry and coordinator for continuous A/B testing and agent configuration optimization.
 */
export class AgentExperimentManager {
    private experiments: Map<string, AgentExperiment> = new Map();
    private activeExperimentId?: string;

    createExperiment(config: ExperimentConfig): AgentExperiment {
        const exp = new AgentExperiment(config);
        this.experiments.set(exp.id, exp);
        if (!this.activeExperimentId || exp.status === 'active') {
            this.activeExperimentId = exp.id;
        }
        return exp;
    }

    getExperiment(id: string): AgentExperiment | undefined {
        return this.experiments.get(id);
    }

    getActiveExperiment(): AgentExperiment | undefined {
        if (!this.activeExperimentId) {
            for (const exp of this.experiments.values()) {
                if (exp.status === 'active') {
                    this.activeExperimentId = exp.id;
                    return exp;
                }
            }
            return undefined;
        }
        return this.experiments.get(this.activeExperimentId);
    }

    setActiveExperiment(id: string): void {
        if (!this.experiments.has(id)) {
            throw new Error(`Experiment ${id} not found in manager registry`);
        }
        this.activeExperimentId = id;
    }

    resolveVariantForTask(
        task: string,
        appId?: string
    ): { experiment?: AgentExperiment; variant?: AgentVariantConfig } {
        const exp = this.getActiveExperiment();
        if (!exp) return {};
        const key = `${appId || 'default'}:${task}`;
        const variant = exp.allocateVariant(key);
        return { experiment: exp, variant };
    }

    recordExecutionMetrics(
        experimentId: string,
        variantId: string,
        metrics: ExecutionMetrics
    ): ExperimentDecision | undefined {
        const exp = this.experiments.get(experimentId);
        if (!exp) return undefined;
        return exp.recordOutcome(variantId, metrics);
    }

    exportState(): object {
        const exps: Record<string, object> = {};
        for (const [id, exp] of this.experiments.entries()) {
            exps[id] = exp.toJSON();
        }
        return {
            activeExperimentId: this.activeExperimentId,
            experiments: exps
        };
    }

    importState(data: any): void {
        if (!data || !data.experiments) return;
        this.experiments.clear();
        for (const [id, expData] of Object.entries(data.experiments)) {
            this.experiments.set(id, AgentExperiment.fromJSON(expData));
        }
        this.activeExperimentId = data.activeExperimentId;
    }

    clear(): void {
        this.experiments.clear();
        this.activeExperimentId = undefined;
    }
}

export const globalAgentExperimentManager = new AgentExperimentManager();
