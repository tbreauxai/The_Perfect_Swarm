import type { ExecutionMetrics, CompositeScoreWeights } from './types.ts';

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
