/**
 * @file predictionEnsemble.ts
 * @description Brier-Calibrated Bayesian & Extremized Log-Odds Prediction Ensemble Pooler
 * and Citation/Evidence Verification Scorer.
 * Combines numeric probabilities and edges across specialist seats weighted by historical
 * Brier skill, cross-provider diversity, and verified row/metric citations.
 */

import type { Agent } from '../agent.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { clampProbability as clampProb, logit, invLogit } from '../math/probabilityMath.ts';

export interface SeatCalibrationWeight {
    seatRole: string;
    provider: string;
    rawProbability?: number;
    rawEdge?: number;
    verifiedCitationsCount: number;
    brierSkillScore: number;
    normalizedWeight: number;
}

export interface CalibratedEnsembleDigest {
    pooledProbability: number;
    rawMeanProbability: number;
    extremizingFactorK: number;
    confidenceInterval95: [number, number];
    pooledEdgePercent: number;
    independentProvidersCount: number;
    totalVerifiedCitations: number;
    seatWeights: SeatCalibrationWeight[];
}



/**
 * Counts verified row ID citations (`R1..Rn`) and quantitative grounding matches in a seat's report.
 */
export function countVerifiedCitations(reportObj: any): number {
    const text = typeof reportObj === 'string' ? reportObj : JSON.stringify(reportObj || '');
    const rowMatches = text.match(/\bR\d+\b/g) || [];
    const uniqueRows = new Set(rowMatches).size;
    const toolResultMatches = (text.match(/\[Tool Result:/g) || []).length;
    const pctOrZMatches = (text.match(/\b(?:z\s*=\s*[-+]?\d+\.\d+|r\s*=\s*[-+]?\d+\.\d+|CI\s*=\s*\[|\d+(?:\.\d+)?%)/gi) || []).length;
    return uniqueRows + toolResultMatches * 2 + Math.min(4, pctOrZMatches);
}

/**
 * Extracts a numeric probability / confidence estimate and edge from an analyst report or scorecard.
 */
function extractSeatProbabilityAndEdge(reports: any[]): { prob?: number; edge?: number; citations: number } {
    let prob: number | undefined;
    let edge: number | undefined;
    let citations = 0;

    for (const r of reports || []) {
        if (!r) continue;
        citations += countVerifiedCitations(r);

        if (typeof r === 'object') {
            if (r.scorecard && typeof r.scorecard === 'object') {
                if (typeof r.scorecard.confidence === 'number') prob = clampProb(r.scorecard.confidence);
                if (typeof r.scorecard.edge === 'number') edge = r.scorecard.edge;
            }
            if (typeof r.winProbHome === 'number') prob = clampProb(r.winProbHome);
            else if (typeof r.win_prob_home === 'number') prob = clampProb(r.win_prob_home);
            else if (typeof r.probability === 'number') prob = clampProb(r.probability);
            else if (typeof r.confidence === 'number' && prob === undefined) prob = clampProb(r.confidence);

            if (typeof r.edge === 'number' && edge === undefined) edge = r.edge;
        }

        const str = typeof r === 'string' ? r : JSON.stringify(r);
        if (prob === undefined) {
            const probMatch = str.match(/(?:win[_\s]?prob(?:ability)?|probability|confidence)[:\s"]*([0-9]+(?:\.[0-9]+)?)\s*(%)?/i);
            if (probMatch && probMatch[1]) {
                const raw = parseFloat(probMatch[1]);
                if (Number.isFinite(raw)) {
                    prob = probMatch[2] === '%' || raw > 1 ? clampProb(raw / 100) : clampProb(raw);
                }
            }
        }
        if (edge === undefined) {
            const edgeMatch = str.match(/(?:edge|ev)[:\s"]*([+-]?[0-9]+(?:\.[0-9]+)?)\s*%/i);
            if (edgeMatch && edgeMatch[1]) {
                const parsedEdge = parseFloat(edgeMatch[1]);
                if (Number.isFinite(parsedEdge)) edge = parsedEdge;
            }
        }
    }

    return { prob, edge, citations };
}

/**
 * Computes Brier-weighted Bayesian / extremized log-odds probability pooling across all specialist seats.
 */
export function computeCalibratedEnsemble(
    allAnalystReports: any[][],
    analysts: Agent[]
): CalibratedEnsembleDigest {
    const activeCount = Math.min(allAnalystReports.length, analysts.length);
    const rawSeats: Array<{
        seatRole: string;
        provider: string;
        prob?: number;
        edge?: number;
        citations: number;
        brierSkillScore: number;
        rawWeight: number;
    }> = [];

    const providerCounts = new Map<string, number>();
    for (let i = 0; i < activeCount; i++) {
        const p = (analysts[i]?.provider || 'unknown').toLowerCase();
        providerCounts.set(p, (providerCounts.get(p) || 0) + 1);
    }

    for (let i = 0; i < activeCount; i++) {
        const analyst = analysts[i];
        const role = analyst?.role || `Analyst ${i + 1}`;
        const provider = (analyst?.provider || 'unknown').toLowerCase();
        const { prob, edge, citations } = extractSeatProbabilityAndEdge(allAnalystReports[i] || []);

        // Historical capability/Brier proxy from globalSpecialistProfiler (0.35..0.98)
        const baseSkill = Math.max(0.35, Math.min(0.98, globalSpecialistProfiler.getCapabilityScore(role) || 0.75));
        // Evidence & cross-provider independence boost
        const citationBoost = Math.min(0.20, citations * 0.03);
        const providerFreq = providerCounts.get(provider) || 1;
        const diversityMultiplier = 1 / Math.sqrt(providerFreq);

        const brierSkillScore = Number(Math.min(0.99, baseSkill + citationBoost * 0.5).toFixed(3));
        const rawWeight = (baseSkill + citationBoost) * diversityMultiplier;

        rawSeats.push({
            seatRole: role,
            provider,
            prob,
            edge,
            citations,
            brierSkillScore,
            rawWeight
        });
    }

    const totalRawWeight = rawSeats.reduce((s, x) => s + x.rawWeight, 0) || 1;
    const seatWeights: SeatCalibrationWeight[] = rawSeats.map(s => ({
        seatRole: s.seatRole,
        provider: s.provider,
        rawProbability: s.prob !== undefined ? Number(s.prob.toFixed(4)) : undefined,
        rawEdge: s.edge !== undefined ? Number(s.edge.toFixed(2)) : undefined,
        verifiedCitationsCount: s.citations,
        brierSkillScore: s.brierSkillScore,
        normalizedWeight: Number((s.rawWeight / totalRawWeight).toFixed(4))
    }));

    const totalVerifiedCitations = seatWeights.reduce((s, x) => s + x.verifiedCitationsCount, 0);
    const independentProvidersCount = providerCounts.size;

    const seatsWithProb = seatWeights.filter(s => s.rawProbability !== undefined);
    if (seatsWithProb.length === 0) {
        return {
            pooledProbability: 0.5,
            rawMeanProbability: 0.5,
            extremizingFactorK: 1.0,
            confidenceInterval95: [0.42, 0.58],
            pooledEdgePercent: 0,
            independentProvidersCount,
            totalVerifiedCitations,
            seatWeights
        };
    }

    const probWeightSum = seatsWithProb.reduce((s, x) => s + x.normalizedWeight, 0) || 1;
    let weightedLogOdds = 0;
    let rawMean = 0;
    let weightedEdge = 0;
    let edgeWeightSum = 0;

    for (const s of seatsWithProb) {
        const w = s.normalizedWeight / probWeightSum;
        const p = s.rawProbability!;
        weightedLogOdds += w * logit(p);
        rawMean += p / seatsWithProb.length;
    }

    for (const s of seatWeights) {
        if (s.rawEdge !== undefined) {
            weightedEdge += s.rawEdge * s.normalizedWeight;
            edgeWeightSum += s.normalizedWeight;
        }
    }

    // Extremizing factor k > 1 when multiple independent providers agree on the same side of 0.5
    const sameSideCount = seatsWithProb.filter(s =>
        (s.rawProbability! >= 0.5 && weightedLogOdds >= 0) ||
        (s.rawProbability! < 0.5 && weightedLogOdds < 0)
    ).length;
    const agreementRatio = sameSideCount / seatsWithProb.length;
    const extremizingFactorK = seatsWithProb.length > 1 && agreementRatio >= 0.75
        ? Number((1.0 + Math.min(0.28, (independentProvidersCount - 1) * 0.09 + (agreementRatio - 0.5) * 0.25)).toFixed(3))
        : 1.0;

    const pooledProbability = Number(invLogit(extremizingFactorK * weightedLogOdds).toFixed(4));
    const rawMeanProbability = Number(rawMean.toFixed(4));

    // Compute empirical weighted dispersion for 95% credible band
    let varSum = 0;
    for (const s of seatsWithProb) {
        const w = s.normalizedWeight / probWeightSum;
        const diff = s.rawProbability! - pooledProbability;
        varSum += w * diff * diff;
    }
    const stdErr = Math.max(0.025, Math.sqrt(varSum / Math.max(1, seatsWithProb.length)));
    const ciLower = Number(Math.max(0.01, pooledProbability - 1.96 * stdErr).toFixed(4));
    const ciUpper = Number(Math.min(0.99, pooledProbability + 1.96 * stdErr).toFixed(4));

    const pooledEdgePercent = edgeWeightSum > 0
        ? Number((weightedEdge / edgeWeightSum).toFixed(2))
        : 0;

    return {
        pooledProbability,
        rawMeanProbability,
        extremizingFactorK,
        confidenceInterval95: [ciLower, ciUpper],
        pooledEdgePercent,
        independentProvidersCount,
        totalVerifiedCitations,
        seatWeights
    };
}
