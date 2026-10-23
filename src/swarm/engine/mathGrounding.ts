/**
 * @file mathGrounding.ts
 * @description Pre-Execution Deterministic Math & Forecasting Grounding Engine.
 * Automatically executes deterministic statistical, forecasting, Monte Carlo bootstrap,
 * and implied probability/Kelly calculations before specialist LLM seats run, injecting
 * verified ground-truth anchors into Analyst, Critic, and Manager prompts.
 */

import type { DatasetSketch } from '../profiler/columnarSketcher.ts';
import {
    holtWintersForecastTool,
    autocorrelationRegimeTool,
    kellyEdgeSizerTool,
    monteCarloBootstrapTool
} from '../tools/forecastingTools.ts';

export interface SeriesGroundingAnchor {
    name: string;
    sampleSize: number;
    mean: number;
    stdDev: number;
    ci95: [number, number];
    vaR95: number;
    forecastNext3: number[];
    forecastIntervalStep1: [number, number];
    growthRegime: string;
    persistenceRegime: string;
    hurstExponent: number;
    lag1R: number;
    structuralBreakIndex: number | null;
}

export interface OddsGroundingAnchor {
    rawOdds: string;
    impliedProbability: number;
    decimalOdds: number;
}

export interface QuantitativeGroundingReport {
    seriesAnchors: SeriesGroundingAnchor[];
    oddsAnchors: OddsGroundingAnchor[];
    corroboratedNumbers: number[];
    promptBlock: string;
    processingTimeMs: number;
}

/**
 * Extracts numeric series from raw text/CSV/JSON or inline task numbers and computes
 * deterministic forecasting + Monte Carlo confidence intervals prior to LLM invocation.
 */
export function runDeterministicMathGrounding(
    task: string,
    rawInput: string,
    sketch?: DatasetSketch
): QuantitativeGroundingReport {
    const startMs = Date.now();
    const seriesMap = new Map<string, number[]>();

    // 1. Extract numeric columns from structured DatasetSketch or tabular lines
    const combinedText = `${task || ''}\n${(rawInput || '').slice(0, 120000)}`;
    const lines = (rawInput || '').trim().split(/\r?\n/).filter(l => l.trim().length > 0);

    if (sketch && sketch.columns.some(c => c.type === 'numeric') && lines.length >= 4) {
        const isCsv = sketch.format === 'CSV';
        const isPipe = sketch.format === 'PipeTable';
        if (isCsv || isPipe) {
            const delim = isPipe ? '|' : ',';
            const headerCells = lines[0].replace(/^\|/, '').replace(/\|$/, '').split(delim).map(s => s.trim());
            const numCols = sketch.columns
                .map((col, idx) => ({ col, idx }))
                .filter(item => item.col.type === 'numeric')
                .slice(0, 4);

            for (const { col, idx } of numCols) {
                const vals: number[] = [];
                for (let r = 1; r < Math.min(lines.length, 2500); r++) {
                    const parts = lines[r].replace(/^\|/, '').replace(/\|$/, '').split(delim);
                    const cell = (parts[idx] ?? '').replace(/[$%,]/g, '').trim();
                    const n = Number(cell);
                    if (cell !== '' && Number.isFinite(n)) vals.push(n);
                }
                if (vals.length >= 5) {
                    seriesMap.set(headerCells[idx] || col.name, vals);
                }
            }
        }
    }

    // 2. Fallback: Extract inline numeric sequences from task or unstructured payload
    if (seriesMap.size === 0) {
        const inlineMatches = combinedText.match(/(?:[-+]?\d+(?:\.\d+)?(?:\s*,\s*|\s+)){4,}[-+]?\d+(?:\.\d+)?/g);
        if (inlineMatches) {
            inlineMatches.slice(0, 2).forEach((seq, idx) => {
                const nums = (seq.match(/[-+]?\d+(?:\.\d+)?/g) || [])
                    .map(Number)
                    .filter(n => Number.isFinite(n));
                if (nums.length >= 5) {
                    seriesMap.set(`inline_series_${idx + 1}`, nums);
                }
            });
        }
    }

    const seriesAnchors: SeriesGroundingAnchor[] = [];
    const corroboratedNumbers: number[] = [];

    for (const [name, vals] of seriesMap.entries()) {
        try {
            const hw = holtWintersForecastTool.execute({ series: vals, horizon: 3 }) as any;
            const ac = autocorrelationRegimeTool.execute({ series: vals, maxLag: 3 }) as any;
            const mc = monteCarloBootstrapTool.execute({ numbers: vals, iterations: 400, seed: 42 }) as any;

            let sum = 0;
            for (const v of vals) sum += v;
            const mean = Number((sum / vals.length).toFixed(4));
            let m2 = 0;
            for (const v of vals) m2 += (v - mean) * (v - mean);
            const stdDev = Number(Math.sqrt(m2 / vals.length).toFixed(4));

            const step1 = hw.predictionIntervals95?.[0] || { lower95: hw.pointForecasts[0], upper95: hw.pointForecasts[0] };
            seriesAnchors.push({
                name,
                sampleSize: vals.length,
                mean,
                stdDev,
                ci95: [mc.ci95Lower, mc.ci95Upper],
                vaR95: mc.vaR95,
                forecastNext3: hw.pointForecasts,
                forecastIntervalStep1: [step1.lower95, step1.upper95],
                growthRegime: hw.regime,
                persistenceRegime: ac.regimeClassification,
                hurstExponent: ac.hurstExponent,
                lag1R: ac.lag1Autocorrelation,
                structuralBreakIndex: ac.structuralBreakIndex
            });

            corroboratedNumbers.push(mean, stdDev, mc.ci95Lower, mc.ci95Upper, ...hw.pointForecasts);
        } catch {
            // Skip malformed series
        }
    }

    // 3. Extract American/Decimal Odds Anchors when present in task or payload
    const oddsAnchors: OddsGroundingAnchor[] = [];
    const americanOddsRegex = /\b([+-][1-9]\d{2,3})\b/g;
    const seenOdds = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = americanOddsRegex.exec(combinedText)) !== null && oddsAnchors.length < 8) {
        const rawOdds = match[1];
        if (seenOdds.has(rawOdds)) continue;
        seenOdds.add(rawOdds);
        try {
            const kelly = kellyEdgeSizerTool.execute({ estimatedWinProb: 0.5, odds: rawOdds, format: 'american' }) as any;
            oddsAnchors.push({
                rawOdds,
                impliedProbability: kelly.impliedMarketProb,
                decimalOdds: kelly.decimalOdds
            });
            corroboratedNumbers.push(kelly.impliedMarketProb, kelly.decimalOdds);
        } catch {
            // Ignore non-odds numbers
        }
    }

    // 4. Render Prompt Block
    const promptLines: string[] = [];
    if (seriesAnchors.length > 0 || oddsAnchors.length > 0) {
        promptLines.push('[Verified Deterministic Math & Forecasting Grounding (Zero-Hallucination Reference)]:');
        for (const s of seriesAnchors) {
            const breakText = s.structuralBreakIndex !== null ? ` | Structural Break at obs #${s.structuralBreakIndex + 1}` : '';
            promptLines.push(
                `• Series '${s.name}' (n=${s.sampleSize}): mean=${s.mean}, sd=${s.stdDev}, 95% Bootstrap CI=[${s.ci95[0]}, ${s.ci95[1]}], VaR95=${s.vaR95} | ` +
                `Holt-Winters 3-Step Forecast=[${s.forecastNext3.join(', ')}] (Step-1 95% PI: [${s.forecastIntervalStep1[0]}, ${s.forecastIntervalStep1[1]}], Regime: ${s.growthRegime}) | ` +
                `Autocorrelation: lag1=${s.lag1R}, Hurst=${s.hurstExponent} (${s.persistenceRegime})${breakText}`
            );
        }
        if (oddsAnchors.length > 0) {
            promptLines.push(
                `• Implied Market Odds Anchors: ` +
                oddsAnchors.map(o => `${o.rawOdds} => ${(o.impliedProbability * 100).toFixed(1)}% implied (dec ${o.decimalOdds})`).join(' | ')
            );
        }
        promptLines.push('Directive: Anchor quantitative claims, trend projections, and edge calculations to these deterministic metrics.');
    }

    return {
        seriesAnchors,
        oddsAnchors,
        corroboratedNumbers,
        promptBlock: promptLines.join('\n'),
        processingTimeMs: Date.now() - startMs
    };
}
