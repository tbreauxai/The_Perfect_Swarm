import { describe, it, expect } from 'vitest';
import { sketchDataset, planAdaptiveProviderShards } from './columnarSketcher.ts';
import {
    holtWintersForecastTool,
    autocorrelationRegimeTool,
    kellyEdgeSizerTool,
    monteCarloBootstrapTool,
} from '../tools/forecastingTools.ts';
import { runDeterministicMathGrounding } from '../engine/mathGrounding.ts';
import { computeCalibratedEnsemble, countVerifiedCitations } from '../engine/predictionEnsemble.ts';
import { extractAnalystConsensus } from '../engine/consensusPipeline.ts';
import type { Agent } from '../agent.ts';

describe('Columnar Sketcher & Adaptive Provider Sharding', () => {
    const generateLargeCsv = (rows: number): string => {
        const lines = ['timestamp,region,revenue,latency_ms,error_rate'];
        for (let i = 1; i <= rows; i++) {
            const rev = i === 45 ? 950000 : 10000 + i * 120; // Row 45 is an extreme z-score outlier
            const lat = i === 88 ? 1950 : 110 + (i % 15);
            const err = i === 88 ? 0.25 : 0.01;
            const reg = i % 2 === 0 ? 'US-East' : 'EU-West';
            lines.push(`2026-01-${String((i % 28) + 1).padStart(2, '0')},${reg},${rev},${lat},${err}`);
        }
        return lines.join('\n');
    };

    it('sketches a multi-row CSV, extracts quantiles/correlations, and preserves anomaly rows', () => {
        const csv = generateLargeCsv(160);
        const sketch = sketchDataset(csv);

        expect(sketch.format).toBe('CSV');
        expect(sketch.totalRows).toBe(160);
        expect(sketch.columns.length).toBe(5);
        expect(sketch.compressionRatio).toBeGreaterThan(0.2);

        const revenueCol = sketch.columns.find(c => c.name === 'revenue');
        expect(revenueCol?.type).toBe('numeric');
        expect(revenueCol?.median).toBeDefined();
        expect(revenueCol?.p75).toBeDefined();

        expect(sketch.anomalyRows.length).toBeGreaterThanOrEqual(2);
        expect(sketch.digestText).toContain('Columnar Dataset Sketch');
        expect(sketch.digestText).toContain('Top Statistical Outlier Rows');
    });

    it('plans provider-aware adaptive shards sized to specialist TPM headroom', () => {
        const csv = generateLargeCsv(250);
        const sketch = sketchDataset(csv);
        const plan = planAdaptiveProviderShards({
            rawInput: csv,
            chunks: [csv.slice(0, 3000), csv.slice(3000)],
            sketch,
            analysts: [
                { id: 'a1', role: 'Analyst 1', provider: 'groq' },
                { id: 'a2', role: 'Analyst 2', provider: 'gemini' },
            ],
            enablePreAggregationSketch: true,
            enableProviderSharding: true,
        });

        expect(plan.shards.length).toBeGreaterThanOrEqual(1);
        expect(plan.shards[0]).toContain('Columnar Dataset Sketch');
        expect(plan.seatAllocations.length).toBe(2);
        expect(plan.seatAllocations[0].providerMaxInputTokens).toBeLessThan(plan.seatAllocations[1].providerMaxInputTokens);
    });
});

describe('Quantitative Forecasting & Monte Carlo Tools', () => {
    it('executes Holt-Winters double exponential smoothing forecast with prediction intervals', async () => {
        const series = [100, 108, 115, 123, 131, 140, 148, 157, 165, 174];
        const res = await holtWintersForecastTool.execute({ series, horizon: 3 });

        expect(res.pointForecasts).toHaveLength(3);
        expect(res.predictionIntervals95).toHaveLength(3);
        expect(res.predictionIntervals95[0].point).toBeGreaterThan(174);
        expect(res.predictionIntervals95[0].upper95).toBeGreaterThan(res.predictionIntervals95[0].lower95);
    });

    it('detects trending vs mean-reverting regime via autocorrelation and Hurst exponent', async () => {
        const trending = Array.from({ length: 24 }, (_, i) => 50 + i * 7.5);
        const res = await autocorrelationRegimeTool.execute({ series: trending, maxLag: 4 });

        expect(res.hurstExponent).toBeGreaterThan(0.5);
        expect(res.regimeClassification).toBe('persistent_trending');
    });

    it('computes fractional Kelly criterion and Expected Value edge', async () => {
        const res = await kellyEdgeSizerTool.execute({
            estimatedWinProb: 0.62,
            odds: 2.0,
            format: 'decimal',
        });

        expect(res.expectedValuePercent).toBeCloseTo(24, 1);
        expect(res.fullKellyFraction).toBeCloseTo(0.24, 2);
        expect(res.halfKellyFraction).toBeCloseTo(0.12, 2);
        expect(res.recommendation).toBe('strong_edge');
    });

    it('runs deterministic seeded Monte Carlo bootstrap simulation', async () => {
        const numbers = [100, 103, 101, 105, 109, 108, 112, 116, 115, 120, 124];
        const res1 = await monteCarloBootstrapTool.execute({ numbers, iterations: 300, seed: 99 });
        const res2 = await monteCarloBootstrapTool.execute({ numbers, iterations: 300, seed: 99 });

        expect(res1.bootstrapMean).toBe(res2.bootstrapMean);
        expect(res1.ci95Upper).toBeGreaterThan(res1.ci95Lower);
    });
});

describe('Deterministic Math Grounding & Brier-Calibrated Ensemble Pooling', () => {
    it('generates pre-execution math grounding report from numeric series in dataset', () => {
        const csv = [
            'day,active_users,revenue',
            '1,1020,5100',
            '2,1080,5400',
            '3,1150,5750',
            '4,1210,6050',
            '5,1290,6450',
            '6,1360,6800',
            '7,1440,7200',
            '8,1510,7550',
        ].join('\n');

        const sketch = sketchDataset(csv);
        const report = runDeterministicMathGrounding('Forecast revenue', csv, sketch);
        expect(report.seriesAnchors.length).toBeGreaterThanOrEqual(2);
        const activeUsersAnchor = report.seriesAnchors.find(a => a.name === 'active_users');
        expect(activeUsersAnchor?.forecastNext3[0]).toBeGreaterThan(1510);
        expect(report.promptBlock).toContain('Verified Deterministic Math & Forecasting Grounding');
    });

    it('computes Brier-calibrated log-odds probability pooling and verified citation weighting', () => {
        const reports = [
            [{
                summary: 'Row 8 shows spike (R8, R12) with 72% win probability and z = 3.12.',
                winProbHome: 0.72,
                confidence: 0.88,
                edge: 4.5,
                metrics: [{ label: 'Target Revenue', value: 215000 }]
            }],
            [{
                summary: 'Forecast confirms upward momentum on R8 with 68% probability.',
                winProbHome: 0.68,
                confidence: 0.82,
                edge: 3.8,
                metrics: [{ label: 'Target Revenue', value: 218000 }]
            }],
            [{
                summary: 'Outlier analyst without citations.',
                winProbHome: 0.45,
                confidence: 0.55,
                edge: -1.0,
                metrics: [{ label: 'Target Revenue', value: 160000 }]
            }]
        ];
        const analysts = [
            { id: 'a1', role: 'Quant Analyst', provider: 'gemini', modelName: 'gemini-3.5-flash' },
            { id: 'a2', role: 'Forecasting Specialist', provider: 'groq', modelName: 'llama-3.3-70b' },
            { id: 'a3', role: 'General Analyst', provider: 'mistral', modelName: 'mistral-small-latest' }
        ] as unknown as Agent[];

        const ensemble = computeCalibratedEnsemble(reports, analysts);
        expect(ensemble).toBeDefined();
        expect(ensemble!.seatWeights.length).toBe(3);
        expect(ensemble!.pooledProbability).toBeGreaterThan(0.60);
        expect(ensemble!.totalVerifiedCitations).toBeGreaterThan(0);

        const consensus = extractAnalystConsensus(reports, analysts, 'Forecast Target Revenue');
        expect(consensus.evidenceWeightedScore).toBeDefined();
        expect(consensus.verifiedCitationsCount).toBeGreaterThan(0);
        expect(consensus.calibratedEnsemble?.pooledProbability).toBeDefined();
        expect(countVerifiedCitations(reports[0][0])).toBeGreaterThanOrEqual(2);
    });
});
