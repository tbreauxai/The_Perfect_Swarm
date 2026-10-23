/**
 * @file forecastingTools.ts
 * @description Deterministic quantitative forecasting, time-series regime detection, Kelly edge sizing,
 * and Monte Carlo bootstrap confidence interval tools. Zero external dependencies.
 */

import type { SwarmTool } from './types.ts';

function round4(n: number): number {
    return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

/**
 * 1. Holt-Winters Double Exponential Smoothing Forecast Tool
 */
export const holtWintersForecastTool: SwarmTool<
    { series: number[]; horizon?: number; alpha?: number; beta?: number },
    {
        horizon: number;
        pointForecasts: number[];
        predictionIntervals95: Array<{ step: number; point: number; lower95: number; upper95: number }>;
        level: number;
        trend: number;
        rmse: number;
        regime: 'accelerating_growth' | 'steady_uptrend' | 'flat_consolidation' | 'steady_downtrend' | 'accelerating_decline';
    }
> = {
    name: 'holt_winters_forecast',
    description: 'Computes Holt-Winters double exponential smoothing point forecasts, 95% prediction intervals, RMSE, and growth regime.',
    parameters: {
        series: {
            type: 'array',
            description: 'Ordered numeric time series (minimum 3 observations)',
            required: true
        },
        horizon: {
            type: 'number',
            description: 'Number of future steps to forecast (default 3)',
            required: false
        },
        alpha: {
            type: 'number',
            description: 'Level smoothing factor in (0, 1] (default 0.45)',
            required: false
        },
        beta: {
            type: 'number',
            description: 'Trend smoothing factor in (0, 1] (default 0.25)',
            required: false
        }
    },
    execute({ series, horizon = 3, alpha = 0.45, beta = 0.25 }) {
        if (!Array.isArray(series)) {
            throw new Error('holt_winters_forecast requires a numeric series array.');
        }
        const clean = series.map(Number).filter(n => Number.isFinite(n));
        if (clean.length < 3) {
            throw new Error('holt_winters_forecast requires at least 3 valid numeric observations.');
        }

        const h = Math.max(1, Math.min(24, Math.floor(Number(horizon) || 3)));
        const a = Math.max(0.05, Math.min(0.95, Number(alpha) || 0.45));
        const b = Math.max(0.05, Math.min(0.95, Number(beta) || 0.25));

        let level = clean[0];
        let trend = clean[1] - clean[0];
        let sse = 0;

        for (let t = 1; t < clean.length; t++) {
            const y = clean[t];
            const prevLevel = level;
            const oneStepPred = prevLevel + trend;
            const err = y - oneStepPred;
            sse += err * err;

            level = a * y + (1 - a) * (prevLevel + trend);
            trend = b * (level - prevLevel) + (1 - b) * trend;
        }

        const rmse = Math.sqrt(sse / Math.max(1, clean.length - 1));
        const pointForecasts: number[] = [];
        const predictionIntervals95: Array<{ step: number; point: number; lower95: number; upper95: number }> = [];

        for (let step = 1; step <= h; step++) {
            const point = level + step * trend;
            const stepSigma = rmse * Math.sqrt(1 + step * a * a * (1 + step * b));
            const margin = 1.96 * stepSigma;
            pointForecasts.push(round4(point));
            predictionIntervals95.push({
                step,
                point: round4(point),
                lower95: round4(point - margin),
                upper95: round4(point + margin)
            });
        }

        const relTrend = Math.abs(level) > 1e-6 ? trend / Math.abs(level) : trend;
        let regime: 'accelerating_growth' | 'steady_uptrend' | 'flat_consolidation' | 'steady_downtrend' | 'accelerating_decline' = 'flat_consolidation';
        if (relTrend > 0.08) regime = 'accelerating_growth';
        else if (relTrend > 0.015) regime = 'steady_uptrend';
        else if (relTrend < -0.08) regime = 'accelerating_decline';
        else if (relTrend < -0.015) regime = 'steady_downtrend';

        return {
            horizon: h,
            pointForecasts,
            predictionIntervals95,
            level: round4(level),
            trend: round4(trend),
            rmse: round4(rmse),
            regime
        };
    }
};

/**
 * 2. Autocorrelation & Structural Break Regime Detector Tool
 */
export const autocorrelationRegimeTool: SwarmTool<
    { series: number[]; maxLag?: number },
    {
        lag1Autocorrelation: number;
        lagCorrelations: Array<{ lag: number; r: number }>;
        hurstExponent: number;
        regimeClassification: 'persistent_trending' | 'mean_reverting' | 'random_walk';
        structuralBreakIndex: number | null;
        cusumMaxShiftSigma: number;
    }
> = {
    name: 'autocorrelation_regime',
    description: 'Computes lag autocorrelations, Hurst exponent persistence, and CUSUM structural break point on a numeric series.',
    parameters: {
        series: {
            type: 'array',
            description: 'Ordered numeric series (minimum 5 observations)',
            required: true
        },
        maxLag: {
            type: 'number',
            description: 'Maximum lag to evaluate (default 3)',
            required: false
        }
    },
    execute({ series, maxLag = 3 }) {
        if (!Array.isArray(series)) {
            throw new Error('autocorrelation_regime requires a numeric series array.');
        }
        const clean = series.map(Number).filter(n => Number.isFinite(n));
        if (clean.length < 5) {
            throw new Error('autocorrelation_regime requires at least 5 numeric observations.');
        }

        const n = clean.length;
        const mean = clean.reduce((s, v) => s + v, 0) / n;
        let denom = 0;
        for (let i = 0; i < n; i++) {
            const d = clean[i] - mean;
            denom += d * d;
        }
        const stdDev = Math.sqrt(denom / n);

        const kMax = Math.max(1, Math.min(Math.floor(n / 2), Number(maxLag) || 3));
        const lagCorrelations: Array<{ lag: number; r: number }> = [];

        for (let lag = 1; lag <= kMax; lag++) {
            if (denom < 1e-12) {
                lagCorrelations.push({ lag, r: 0 });
                continue;
            }
            let num = 0;
            for (let t = lag; t < n; t++) {
                num += (clean[t] - mean) * (clean[t - lag] - mean);
            }
            lagCorrelations.push({ lag, r: round4(num / denom) });
        }

        // Rescaled Range (R/S) Hurst approximation + CUSUM break detection
        let cumDev = 0;
        let maxCum = -Infinity;
        let minCum = Infinity;
        let maxAbsCum = 0;
        let breakIdx: number | null = null;

        for (let i = 0; i < n; i++) {
            cumDev += clean[i] - mean;
            if (cumDev > maxCum) maxCum = cumDev;
            if (cumDev < minCum) minCum = cumDev;
            if (Math.abs(cumDev) > maxAbsCum) {
                maxAbsCum = Math.abs(cumDev);
                breakIdx = i;
            }
        }

        const rangeR = maxCum - minCum;
        const hurstRaw = stdDev > 1e-9 && rangeR > 0
            ? Math.log(rangeR / stdDev) / Math.log(n)
            : 0.5;
        const hurstExponent = round4(Math.max(0.05, Math.min(0.95, hurstRaw)));
        const lag1 = lagCorrelations[0]?.r ?? 0;

        let regimeClassification: 'persistent_trending' | 'mean_reverting' | 'random_walk' = 'random_walk';
        if (hurstExponent >= 0.57 || lag1 >= 0.25) {
            regimeClassification = 'persistent_trending';
        } else if (hurstExponent <= 0.43 || lag1 <= -0.20) {
            regimeClassification = 'mean_reverting';
        }

        const cusumMaxShiftSigma = stdDev > 1e-9 ? round4(maxAbsCum / (stdDev * Math.sqrt(n))) : 0;
        const structuralBreakIndex = cusumMaxShiftSigma >= 1.15 ? breakIdx : null;

        return {
            lag1Autocorrelation: lag1,
            lagCorrelations,
            hurstExponent,
            regimeClassification,
            structuralBreakIndex,
            cusumMaxShiftSigma
        };
    }
};

/**
 * 3. Kelly Criterion & Expected Value (EV) Edge Sizer Tool
 */
export const kellyEdgeSizerTool: SwarmTool<
    { estimatedWinProb: number; odds: number | string; format?: 'decimal' | 'american' | 'fractional' },
    {
        estimatedWinProb: number;
        impliedMarketProb: number;
        decimalOdds: number;
        edgePercent: number;
        expectedValuePercent: number;
        fullKellyFraction: number;
        halfKellyFraction: number;
        quarterKellyFraction: number;
        recommendation: 'strong_edge' | 'moderate_edge' | 'marginal_edge' | 'no_play';
    }
> = {
    name: 'kelly_edge_sizer',
    description: 'Calculates implied market probability, edge %, expected value (EV %), and full/half/quarter Kelly criterion stake sizing.',
    parameters: {
        estimatedWinProb: {
            type: 'number',
            description: 'Estimated true probability in (0, 1) (or percentage 1..99)',
            required: true
        },
        odds: {
            type: 'string',
            description: 'Market odds (e.g. -110, +150, 1.91, "3/2")',
            required: true
        },
        format: {
            type: 'string',
            description: 'Optional odds format ("decimal", "american", "fractional")',
            required: false
        }
    },
    execute({ estimatedWinProb, odds, format }) {
        let p = Number(estimatedWinProb);
        if (!Number.isFinite(p) || p <= 0) {
            throw new Error('estimatedWinProb must be a positive probability.');
        }
        if (p > 1) p = p / 100;
        p = Math.max(0.001, Math.min(0.999, p));

        let fmt = format;
        const oddsStr = String(odds).trim();
        if (!fmt) {
            if (oddsStr.includes('/')) fmt = 'fractional';
            else if (Number(oddsStr) >= 100 || Number(oddsStr) <= -100 || oddsStr.startsWith('+') || oddsStr.startsWith('-')) fmt = 'american';
            else fmt = 'decimal';
        }

        let decimalOdds = 2.0;
        if (fmt === 'fractional') {
            const [num, den] = oddsStr.split('/').map(Number);
            if (!num || !den) throw new Error('Invalid fractional odds.');
            decimalOdds = num / den + 1;
        } else if (fmt === 'american') {
            const am = Number(oddsStr);
            if (!am || Number.isNaN(am)) throw new Error('Invalid American odds.');
            decimalOdds = am > 0 ? am / 100 + 1 : 100 / Math.abs(am) + 1;
        } else {
            decimalOdds = Number(oddsStr);
            if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) throw new Error('Decimal odds must be > 1.0.');
        }

        const impliedMarketProb = 1 / decimalOdds;
        const b = decimalOdds - 1;
        const q = 1 - p;
        const rawKelly = b > 0 ? (b * p - q) / b : 0;
        const fullKellyFraction = Math.max(0, round4(rawKelly));
        const edgePercent = round4((p - impliedMarketProb) * 100);
        const expectedValuePercent = round4((p * decimalOdds - 1) * 100);

        let recommendation: 'strong_edge' | 'moderate_edge' | 'marginal_edge' | 'no_play' = 'no_play';
        if (edgePercent >= 5.0) recommendation = 'strong_edge';
        else if (edgePercent >= 2.5) recommendation = 'moderate_edge';
        else if (edgePercent >= 0.75) recommendation = 'marginal_edge';

        return {
            estimatedWinProb: round4(p),
            impliedMarketProb: round4(impliedMarketProb),
            decimalOdds: round4(decimalOdds),
            edgePercent,
            expectedValuePercent,
            fullKellyFraction,
            halfKellyFraction: round4(fullKellyFraction * 0.5),
            quarterKellyFraction: round4(fullKellyFraction * 0.25),
            recommendation
        };
    }
};

/**
 * 4. Deterministic Seeded Monte Carlo Bootstrap Confidence Interval Tool
 */
export const monteCarloBootstrapTool: SwarmTool<
    { numbers: number[]; iterations?: number; threshold?: number; seed?: number },
    {
        sampleSize: number;
        iterations: number;
        bootstrapMean: number;
        standardError: number;
        ci95Lower: number;
        ci95Upper: number;
        vaR95: number;
        cVaR95: number;
        probAboveThreshold?: number;
    }
> = {
    name: 'monte_carlo_bootstrap',
    description: 'Runs deterministic seeded Monte Carlo bootstrap resampling to estimate 95% confidence intervals, standard error, VaR(95%), and tail probabilities.',
    parameters: {
        numbers: {
            type: 'array',
            description: 'Numeric observations to resample',
            required: true
        },
        iterations: {
            type: 'number',
            description: 'Bootstrap iterations (default 500, max 2000)',
            required: false
        },
        threshold: {
            type: 'number',
            description: 'Optional target value to compute P(X > threshold)',
            required: false
        },
        seed: {
            type: 'number',
            description: 'Optional PRNG seed for deterministic reproducibility (default 42)',
            required: false
        }
    },
    execute({ numbers, iterations = 500, threshold, seed = 42 }) {
        if (!Array.isArray(numbers)) {
            throw new Error('monte_carlo_bootstrap requires an array of numbers.');
        }
        const clean = numbers.map(Number).filter(n => Number.isFinite(n));
        if (clean.length < 2) {
            throw new Error('monte_carlo_bootstrap requires at least 2 valid numbers.');
        }

        const n = clean.length;
        const iters = Math.max(50, Math.min(2000, Math.floor(Number(iterations) || 500)));

        // Fast deterministic Park-Miller / LCG PRNG
        let state = (Math.abs(Math.floor(Number(seed) || 42)) % 2147483647) || 42;
        const nextRand = () => {
            state = (state * 48271) % 2147483647;
            return (state - 1) / 2147483646;
        };

        const sampleMeans: number[] = new Array(iters);
        for (let b = 0; b < iters; b++) {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                const idx = Math.floor(nextRand() * n);
                sum += clean[idx];
            }
            sampleMeans[b] = sum / n;
        }

        sampleMeans.sort((a, b) => a - b);
        const bootstrapMean = sampleMeans.reduce((s, v) => s + v, 0) / iters;
        let sqDiff = 0;
        for (let b = 0; b < iters; b++) {
            const d = sampleMeans[b] - bootstrapMean;
            sqDiff += d * d;
        }
        const standardError = Math.sqrt(sqDiff / Math.max(1, iters - 1));
        const ci95Lower = sampleMeans[Math.floor(iters * 0.025)];
        const ci95Upper = sampleMeans[Math.min(iters - 1, Math.floor(iters * 0.975))];

        // Empirical 5th percentile Value-at-Risk & Expected Shortfall (CVaR)
        const sortedObs = [...clean].sort((a, b) => a - b);
        const varIdx = Math.max(0, Math.floor(n * 0.05));
        const vaR95 = sortedObs[varIdx];
        const tailSlice = sortedObs.slice(0, varIdx + 1);
        const cVaR95 = tailSlice.reduce((s, v) => s + v, 0) / tailSlice.length;

        let probAboveThreshold: number | undefined = undefined;
        if (threshold !== undefined && Number.isFinite(Number(threshold))) {
            const tVal = Number(threshold);
            const countAbove = clean.filter(v => v > tVal).length;
            probAboveThreshold = round4(countAbove / n);
        }

        return {
            sampleSize: n,
            iterations: iters,
            bootstrapMean: round4(bootstrapMean),
            standardError: round4(standardError),
            ci95Lower: round4(ci95Lower),
            ci95Upper: round4(ci95Upper),
            vaR95: round4(vaR95),
            cVaR95: round4(cVaR95),
            ...(probAboveThreshold !== undefined ? { probAboveThreshold } : {})
        };
    }
};
