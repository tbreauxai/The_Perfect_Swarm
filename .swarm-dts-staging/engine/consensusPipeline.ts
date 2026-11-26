/**
 * @file consensusPipeline.ts
 * @description Runtime Cross-Analyst Consensus Synthesis & Disagreement Arbitration.
 * Computes semantic similarity, identifies majority consensus findings, flags critical
 * minority dissenting observations, and provides structured consensus directives to the Manager Node.
 * Pure TypeScript, zero external runtime dependencies.
 */

import type { Agent } from '../agent.js';
import type { SwarmContext } from '../context.js';
import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.js';
import {
    computeCalibratedEnsemble,
    countVerifiedCitations,
    type CalibratedEnsembleDigest
} from './predictionEnsemble.js';

export type { CalibratedEnsembleDigest };

export interface SeatConflictProposal {
    seatRole: string;
    sideRole: 'home' | 'away' | 'over' | 'under';
    rowId?: string;
    pickLabel: string;
}

export interface SeatConflictEntry {
    eventId: string;
    matchup?: string;
    homeTeam?: string;
    awayTeam?: string;
    seats: SeatConflictProposal[];
    tag: 'seat_conflict';
}

export interface AnalystConsensusDigest {
    totalAnalysts: number;
    consensusScore: number; // 0.0 to 1.0 (mean agreement ratio)
    evidenceWeightedScore?: number; // 0.0 to 1.0 (weighted by verified citations & Brier skill)
    agreementLevel: 'strong' | 'moderate' | 'divergent';
    majorityFindings: string[]; // Findings supported by >= 50% of analysts
    dissentingOpinions: string[]; // High-signal findings flagged by only 1 analyst
    unanimousFindings: string[]; // Findings supported by 100% of analysts
    confidenceScore: number; // 0.0 to 1.0
    summaryText: string;
    verifiedCitationsCount?: number;
    citationCountsBySeat?: Record<string, number>;
    calibratedEnsemble?: CalibratedEnsembleDigest;
    sampleVariance?: number;
    sampleStdDev?: number;
    isContested?: boolean;
    seatConflicts?: SeatConflictEntry[];
}

const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
    'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
    'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
    'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
    'his', 'how', 'i', 'if', 'in', 'into', 'is', 'isn', 'it', 'its', 'itself', 'just', 'me', 'more',
    'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
    'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'should', 'so', 'some', 'such', 'than',
    'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
    'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn', 'we', 'were',
    'weren', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you',
    'your', 'yours', 'yourself', 'yourselves'
]);

function normalizeWord(word: string): string {
    const w = word.toLowerCase();
    if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
    if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
    return w;
}

/**
 * Tokenizes text into normalized content word stems.
 */
function tokenize(text: string): string[] {
    if (!text || typeof text !== 'string') return [];
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_\-\s]/g, ' ')
        .split(/\s+/)
        .map(normalizeWord)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Computes balanced Jaccard and containment/overlap similarity between two token sets.
 */
function computeSimilarity(tokensA: Set<string>, tokensB: Set<string>): number {
    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

    let intersection = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0.0;
    const overlap = intersection / Math.min(tokensA.size, tokensB.size);
    return (jaccard * 0.4) + (overlap * 0.6);
}

/**
 * Flattens analyst report structures into an array of distinct insight strings.
 */
export function extractAnalystInsights(reports: any[]): string[] {
    const insights: string[] = [];
    if (!Array.isArray(reports)) return insights;

    for (const r of reports) {
        if (!r) continue;
        if (typeof r === 'string') {
            const lines = r.split('\n').map(l => l.trim()).filter(l => l.length > 10);
            insights.push(...lines);
        } else if (typeof r === 'object') {
            if (Array.isArray(r.insights)) {
                insights.push(...r.insights.map((i: any) => typeof i === 'string' ? i : JSON.stringify(i)));
            }
            if (Array.isArray(r.anomalies)) {
                insights.push(...r.anomalies.map((a: any) => `[Anomaly] ${typeof a === 'string' ? a : JSON.stringify(a)}`));
            }
            if (Array.isArray(r.findings)) {
                insights.push(...r.findings.map((f: any) => typeof f === 'string' ? f : JSON.stringify(f)));
            }
            if (r.summary && typeof r.summary === 'string') {
                insights.push(r.summary);
            }
        }
    }

    return Array.from(new Set(insights.filter(i => i.trim().length > 0)));
}

function normalizeTeamTextForMatch(text: string): string {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function teamNameMatchesPickText(teamName: string, pickText: string): boolean {
    const normTeam = normalizeTeamTextForMatch(teamName);
    const normPick = normalizeTeamTextForMatch(pickText);
    if (!normTeam || !normPick) return false;
    if (normPick.includes(normTeam)) return true;
    const words = normTeam.split(' ').filter(w => w.length >= 4);
    const mascot = words[words.length - 1];
    if (mascot && new RegExp(`\\b${mascot}\\b`, 'i').test(normPick)) return true;
    return false;
}

/**
 * S1.3: Detects when two distinct non-critic proposer seats propose opposing sides
 * (`home` vs `away`, or `over` vs `under`) on the same `event_id`.
 */
export function detectOpposingSeatConflicts(
    allAnalystReports: any[][],
    analysts: Agent[],
    headers: GameHeader[] = []
): SeatConflictEntry[] {
    const activeCount = Math.min(allAnalystReports.length, analysts.length);
    if (activeCount < 2) return [];

    const headerById = new Map<string, GameHeader>();
    const rowToMeta = new Map<string, { eventId: string; optionText: string }>();
    for (const h of headers || []) {
        if (!h?.eventId) continue;
        headerById.set(h.eventId, h);
        for (const opt of h.options || []) {
            const id = String(opt?.id || '').toUpperCase().trim();
            if (id) rowToMeta.set(id, { eventId: h.eventId, optionText: String(opt?.text || '') });
        }
    }

    const proposalsByEvent = new Map<string, SeatConflictProposal[]>();

    for (let i = 0; i < activeCount; i++) {
        const seatRole = String(analysts[i]?.role || `Analyst ${i + 1}`).trim();
        const roleLower = seatRole.toLowerCase();
        if (roleLower.includes('critic') || roleLower.includes('risk')) continue;

        const reports = Array.isArray(allAnalystReports[i]) ? allAnalystReports[i] : [];
        const seatPicks: any[] = [];
        for (const r of reports) {
            if (!r || typeof r !== 'object' || (r as any)._placeholder === true) continue;
            const rLabel = String((r as any).seat || (r as any).role || '').toLowerCase();
            if (rLabel.includes('critic') || rLabel.includes('risk')) continue;
            if (Array.isArray((r as any).picks)) seatPicks.push(...(r as any).picks);
            if ((r as any).scorecard?.pick) seatPicks.push((r as any).scorecard.pick);
            if (Array.isArray((r as any).scorecards)) {
                for (const sc of (r as any).scorecards) {
                    if (sc?.pick) seatPicks.push(sc.pick);
                    if (Array.isArray(sc?.picks)) seatPicks.push(...sc.picks);
                }
            }
        }

        for (const pk of seatPicks) {
            if (!pk) continue;
            const rawText = typeof pk === 'string'
                ? pk
                : [pk.row, pk.rowId, pk.row_id, pk.side, pk.pick, pk.selection, pk.team, pk.market, pk.label, pk.matchup]
                    .filter(Boolean)
                    .join(' ');
            const rowMatch = (typeof pk === 'object' ? String(pk.row || pk.rowId || pk.row_id || '') : '').match(/\b(R\d+)\b/i)
                || rawText.match(/\b(R\d+)\b/i);
            const rowId = rowMatch ? rowMatch[1].toUpperCase() : undefined;
            const rowMeta = rowId ? rowToMeta.get(rowId) : undefined;

            let eventId = (typeof pk === 'object'
                ? String(pk.eventId || pk.event_id || pk.gameId || pk.game_id || '').trim()
                : '') || rowMeta?.eventId || '';

            const combinedText = [rawText, rowMeta?.optionText].filter(Boolean).join(' ').trim();
            if (!eventId) {
                for (const h of headers || []) {
                    if (
                        (h.eventId && combinedText.toLowerCase().includes(h.eventId.toLowerCase())) ||
                        teamNameMatchesPickText(h.home, combinedText) ||
                        teamNameMatchesPickText(h.away, combinedText)
                    ) {
                        eventId = h.eventId;
                        break;
                    }
                }
            }
            if (!eventId) continue;

            const hdr = headerById.get(eventId);
            let sideRole: 'home' | 'away' | 'over' | 'under' | undefined;
            if (/\bover\b/i.test(combinedText) && !/\bML\b/i.test(combinedText) && !/\bovertime\b/i.test(combinedText)) {
                sideRole = 'over';
            } else if (/\bunder\b/i.test(combinedText) && !/\bML\b/i.test(combinedText)) {
                sideRole = 'under';
            } else {
                const pickTargetText = [
                    typeof pk === 'object' ? [pk.side, pk.pick, pk.selection, pk.team, pk.label].filter(Boolean).join(' ') : pk,
                    rowMeta?.optionText
                ].filter(Boolean).join(' ').trim();
                const matchesHome = hdr ? teamNameMatchesPickText(hdr.home, pickTargetText) : false;
                const matchesAway = hdr ? teamNameMatchesPickText(hdr.away, pickTargetText) : false;
                if (matchesHome && !matchesAway) {
                    sideRole = 'home';
                } else if (matchesAway && !matchesHome) {
                    sideRole = 'away';
                } else if (/\baway\b/i.test(pickTargetText) && !/\bhome\b/i.test(pickTargetText)) {
                    sideRole = 'away';
                } else if (/\bhome\b/i.test(pickTargetText) && !/\baway\b/i.test(pickTargetText)) {
                    sideRole = 'home';
                }
            }
            if (!sideRole) continue;

            const pickLabel = (
                (typeof pk === 'object'
                    ? [rowId, pk.side || pk.pick || pk.selection || pk.team || rowMeta?.optionText].filter(Boolean).join(' ')
                    : String(pk)) || rowMeta?.optionText || sideRole
            ).trim();

            const list = proposalsByEvent.get(eventId) || [];
            if (!list.some(x => x.seatRole === seatRole && x.sideRole === sideRole)) {
                list.push({ seatRole, sideRole, ...(rowId ? { rowId } : {}), pickLabel });
                proposalsByEvent.set(eventId, list);
            }
        }
    }

    const conflicts: SeatConflictEntry[] = [];
    for (const [eventId, seats] of proposalsByEvent.entries()) {
        const distinctSeats = new Set(seats.map(s => s.seatRole));
        if (distinctSeats.size < 2) continue;
        const hasHome = seats.some(s => s.sideRole === 'home');
        const hasAway = seats.some(s => s.sideRole === 'away');
        const hasOver = seats.some(s => s.sideRole === 'over');
        const hasUnder = seats.some(s => s.sideRole === 'under');
        const opposingSides = (hasHome && hasAway) || (hasOver && hasUnder);
        if (!opposingSides) continue;
        const hdr = headerById.get(eventId);
        conflicts.push({
            eventId,
            ...(hdr ? { matchup: `${hdr.away} @ ${hdr.home}`, homeTeam: hdr.home, awayTeam: hdr.away } : {}),
            seats,
            tag: 'seat_conflict'
        });
    }

    return conflicts;
}

export function findingMentionsSeatConflict(text: string, conflicts: SeatConflictEntry[]): boolean {
    if (!text || conflicts.length === 0) return false;
    const lower = text.toLowerCase();
    for (const c of conflicts) {
        if (c.eventId && lower.includes(c.eventId.toLowerCase())) return true;
        if (c.homeTeam && teamNameMatchesPickText(c.homeTeam, text)) return true;
        if (c.awayTeam && teamNameMatchesPickText(c.awayTeam, text)) return true;
        for (const s of c.seats) {
            if (s.rowId && new RegExp(`\\b${s.rowId}\\b`, 'i').test(text)) return true;
        }
    }
    return false;
}

export function renderSeatConflictPromptBlock(conflicts: SeatConflictEntry[]): string {
    if (!Array.isArray(conflicts) || conflicts.length === 0) return '';
    const lines: string[] = [
        '[SEAT_CONFLICT — OPPOSING PROPOSER SIDES (DO NOT CALL "Majority Consensus")]:'
    ];
    for (const c of conflicts) {
        const sidesDesc = c.seats
            .map(s => `${s.seatRole} -> ${s.pickLabel} (${s.sideRole})`)
            .join(' vs ');
        const matchupPart = c.matchup ? ` (${c.matchup})` : '';
        lines.push(
            `- seat_conflict | event_id=${c.eventId}${matchupPart}: ${sidesDesc}. NEVER describe this split game as "Majority Consensus" or seat agreement; prefer unconflicted legs agreed upon or unopposed by the other proposer.`
        );
    }
    return lines.join('\n');
}

/**
 * Analyzes specialist reports across all analysts and computes consensus, majority agreements,
 * dissenting observations, evidence citation weights, and Brier-calibrated log-odds ensemble pooling.
 */
export function extractAnalystConsensus(
    allAnalystReports: any[][],
    analysts: Agent[],
    task: string,
    headers?: GameHeader[]
): AnalystConsensusDigest {
    const activeAnalystCount = Math.min(allAnalystReports.length, analysts.length);
    if (activeAnalystCount === 0) {
        return {
            totalAnalysts: 0,
            consensusScore: 1.0,
            evidenceWeightedScore: 1.0,
            agreementLevel: 'strong',
            majorityFindings: [],
            dissentingOpinions: [],
            unanimousFindings: [],
            confidenceScore: 0.5,
            summaryText: 'No active analyst reports available for consensus synthesis.',
            verifiedCitationsCount: 0,
            citationCountsBySeat: {}
        };
    }

    const calibratedEnsemble = computeCalibratedEnsemble(allAnalystReports, analysts);
    const citationCountsBySeat: Record<string, number> = {};
    for (const sw of calibratedEnsemble.seatWeights) {
        citationCountsBySeat[sw.seatRole] = sw.verifiedCitationsCount;
    }

    if (activeAnalystCount === 1) {
        const singleInsights = extractAnalystInsights(allAnalystReports[0] || []);
        return {
            totalAnalysts: 1,
            consensusScore: 1.0,
            evidenceWeightedScore: 1.0,
            agreementLevel: 'strong',
            majorityFindings: singleInsights.slice(0, 5),
            dissentingOpinions: [],
            unanimousFindings: singleInsights.slice(0, 5),
            confidenceScore: 0.85,
            summaryText: `Single specialist analysis [${analysts[0]?.role}]: ${singleInsights.length} findings extracted.`,
            verifiedCitationsCount: calibratedEnsemble.totalVerifiedCitations,
            citationCountsBySeat,
            calibratedEnsemble
        };
    }

    // Extract per-analyst tokenized insights
    const perAnalystData: Array<{
        role: string;
        insights: string[];
        tokenSets: Set<string>[];
        combinedTokens: Set<string>;
        citations: number;
    }> = [];

    for (let i = 0; i < activeAnalystCount; i++) {
        const role = analysts[i]?.role || `Analyst ${i + 1}`;
        const rawInsights = extractAnalystInsights(allAnalystReports[i] || []);
        const tokenSets = rawInsights.map(ins => new Set(tokenize(ins)));
        const combinedTokens = new Set<string>();
        for (const set of tokenSets) {
            for (const t of set) combinedTokens.add(t);
        }
        const citations = (allAnalystReports[i] || []).reduce((acc, r) => acc + countVerifiedCitations(r), 0);
        perAnalystData.push({
            role,
            insights: rawInsights,
            tokenSets,
            combinedTokens,
            citations
        });
    }

    // 1. Calculate Pairwise Alignment across all analyst pairs (best-match insight alignment)
    let totalPairwiseSim = 0;
    let pairCount = 0;

    for (let i = 0; i < perAnalystData.length; i++) {
        for (let j = i + 1; j < perAnalystData.length; j++) {
            const tokensA = perAnalystData[i].tokenSets;
            const tokensB = perAnalystData[j].tokenSets;

            if (tokensA.length === 0 && tokensB.length === 0) {
                totalPairwiseSim += 1.0;
            } else if (tokensA.length === 0 || tokensB.length === 0) {
                totalPairwiseSim += 0.0;
            } else {
                let scoreAtoB = 0;
                for (const tA of tokensA) {
                    let maxMatch = 0;
                    for (const tB of tokensB) {
                        const s = computeSimilarity(tA, tB);
                        if (s > maxMatch) maxMatch = s;
                    }
                    scoreAtoB += maxMatch;
                }
                scoreAtoB /= tokensA.length;

                let scoreBtoA = 0;
                for (const tB of tokensB) {
                    let maxMatch = 0;
                    for (const tA of tokensA) {
                        const s = computeSimilarity(tB, tA);
                        if (s > maxMatch) maxMatch = s;
                    }
                    scoreBtoA += maxMatch;
                }
                scoreBtoA /= tokensB.length;

                totalPairwiseSim += (scoreAtoB + scoreBtoA) / 2;
            }
            pairCount++;
        }
    }

    const rawPairwiseScore = pairCount > 0 ? totalPairwiseSim / pairCount : 0.5;

    // 2. Map Insight Overlap & Citation-Weighted Support Frequency
    const allIndividualInsights: Array<{
        text: string;
        sourceRole: string;
        tokens: Set<string>;
        supportCount: number;
        supportingRoles: Set<string>;
        evidenceBonus: number;
    }> = [];

    for (const data of perAnalystData) {
        for (let k = 0; k < data.insights.length; k++) {
            const insightText = data.insights[k];
            const itemCitations = countVerifiedCitations(insightText);
            allIndividualInsights.push({
                text: insightText,
                sourceRole: data.role,
                tokens: data.tokenSets[k],
                supportCount: 1,
                supportingRoles: new Set([data.role]),
                evidenceBonus: itemCitations * 0.25
            });
        }
    }

    // Match similar insights across different analysts (Similarity >= 0.35 on token sets)
    const SIMILARITY_MATCH_THRESHOLD = 0.35;
    for (let a = 0; a < allIndividualInsights.length; a++) {
        for (let b = a + 1; b < allIndividualInsights.length; b++) {
            const itemA = allIndividualInsights[a];
            const itemB = allIndividualInsights[b];
            if (itemA.sourceRole === itemB.sourceRole) continue;

            const sim = computeSimilarity(itemA.tokens, itemB.tokens);
            if (sim >= SIMILARITY_MATCH_THRESHOLD) {
                if (!itemA.supportingRoles.has(itemB.sourceRole)) {
                    itemA.supportingRoles.add(itemB.sourceRole);
                    itemA.supportCount = itemA.supportingRoles.size;
                }
                if (!itemB.supportingRoles.has(itemA.sourceRole)) {
                    itemB.supportingRoles.add(itemA.sourceRole);
                    itemB.supportCount = itemB.supportingRoles.size;
                }
            }
        }
    }

    // Deduplicate matched findings for final report
    const unanimousFindings: string[] = [];
    const majorityFindings: string[] = [];
    const dissentingOpinions: string[] = [];

    const seenTexts = new Set<string>();
    const isDistinctFromAccepted = (text: string, accepted: string[]): boolean => {
        const textTokens = new Set(tokenize(text));
        for (const acc of accepted) {
            if (computeSimilarity(textTokens, new Set(tokenize(acc))) > 0.65) return false;
        }
        return true;
    };

    // Sort insights by support count + evidence citation bonus descending
    allIndividualInsights.sort((x, y) => (y.supportCount + y.evidenceBonus) - (x.supportCount + x.evidenceBonus));

    const majorityThreshold = Math.ceil(activeAnalystCount / 2);

    for (const item of allIndividualInsights) {
        const clean = item.text.replace(/^[•\s\-\*]+/, '').trim();
        if (clean.length < 8 || seenTexts.has(clean.toLowerCase())) continue;

        if (item.supportCount === activeAnalystCount) {
            if (isDistinctFromAccepted(clean, unanimousFindings)) {
                unanimousFindings.push(clean);
                seenTexts.add(clean.toLowerCase());
            }
        } else if (item.supportCount >= majorityThreshold) {
            if (isDistinctFromAccepted(clean, majorityFindings) && isDistinctFromAccepted(clean, unanimousFindings)) {
                majorityFindings.push(clean);
                seenTexts.add(clean.toLowerCase());
            }
        } else if (item.supportCount === 1) {
            const lower = clean.toLowerCase();
            const isHighSignal = lower.includes('anomaly') ||
                                 lower.includes('risk') ||
                                 lower.includes('error') ||
                                 lower.includes('critical') ||
                                 lower.includes('warning') ||
                                 lower.includes('discrepancy') ||
                                 lower.includes('spike') ||
                                 lower.includes('variance') ||
                                 lower.includes('unexpected') ||
                                 /\br\d+\b/i.test(clean);

            if (isHighSignal && isDistinctFromAccepted(clean, dissentingOpinions)) {
                dissentingOpinions.push(`[${item.sourceRole}]: ${clean}`);
                seenTexts.add(clean.toLowerCase());
            }
        }
    }

    // 3. Compute Final Calibrated Consensus & Evidence-Weighted Confidence Scores
    const acceptedCount = unanimousFindings.length + majorityFindings.length;
    const consensusRatio = acceptedCount > 0
        ? (unanimousFindings.length * 1.0 + majorityFindings.length * 0.8) /
          (unanimousFindings.length + majorityFindings.length + (dissentingOpinions.length * 0.25))
        : 0.1;

    const normalizedConsensus = Math.min(1.0, Math.max(0.1, Number(((rawPairwiseScore * 0.3) + (consensusRatio * 0.7)).toFixed(3))));
    const citationBoost = Math.min(0.15, calibratedEnsemble.totalVerifiedCitations * 0.015);
    const evidenceWeightedScore = Math.min(1.0, Number((normalizedConsensus + citationBoost).toFixed(3)));

    const nonCriticReports: any[] = [];
    let hasCriticSeat = false;
    for (let i = 0; i < activeAnalystCount; i++) {
        const role = String(analysts[i]?.role || '').toLowerCase();
        if (role.includes('critic') || role.includes('risk')) {
            hasCriticSeat = true;
            continue;
        }
        for (const r of allAnalystReports[i] || []) {
            if (r && typeof r === 'object') nonCriticReports.push(r);
        }
    }
    const reportHasZeroPicks = (r: any): boolean => {
        if (Array.isArray(r.picks)) return r.picks.length === 0;
        if (Array.isArray(r.scorecard?.picks) && r.scorecard.picks.length > 0) return false;
        if (Array.isArray(r.scorecards) && r.scorecards.some((s: any) => Array.isArray(s?.picks) && s.picks.length > 0)) return false;
        return true;
    };
    const isPickWorkflowContext =
        nonCriticReports.some(r => Array.isArray(r.picks)) ||
        hasCriticSeat;
    const allNonCriticZeroPicks =
        isPickWorkflowContext &&
        nonCriticReports.length > 0 &&
        nonCriticReports.every(reportHasZeroPicks);

    let agreementLevel: 'strong' | 'moderate' | 'divergent';
    if (allNonCriticZeroPicks || normalizedConsensus >= 0.60 || unanimousFindings.length >= 2) {
        agreementLevel = 'strong';
    } else if (normalizedConsensus >= 0.38 || majorityFindings.length >= 1) {
        agreementLevel = 'moderate';
    } else {
        agreementLevel = 'divergent';
    }

    // 3. Compute Numerical Prediction Variance & Calibrated Variance Clamping
    const numericPredictions: number[] = [];
    for (let i = 0; i < activeAnalystCount; i++) {
        const rawProb = calibratedEnsemble.seatWeights[i]?.rawProbability;
        if (typeof rawProb === 'number' && Number.isFinite(rawProb)) {
            numericPredictions.push(rawProb);
        }
    }

    let sampleVariance: number | undefined;
    let sampleStdDev: number | undefined;
    let isContested = false;

    if (numericPredictions.length >= 2) {
        const mean = numericPredictions.reduce((acc, v) => acc + v, 0) / numericPredictions.length;
        const sumSqDiff = numericPredictions.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0);
        sampleVariance = sumSqDiff / (numericPredictions.length - 1);
        sampleStdDev = Math.sqrt(sampleVariance);

        if (sampleStdDev > 0.15 || sampleVariance > 0.02) {
            isContested = true;
        }
    } else if (agreementLevel === 'divergent') {
        isContested = true;
    }

    let confidenceScore = Number(Math.min(0.99, Math.max(0.3,
        agreementLevel === 'strong' ? 0.90 + (normalizedConsensus * 0.08)
        : agreementLevel === 'moderate' ? 0.75 + (normalizedConsensus * 0.10)
        : 0.50
    )).toFixed(2));

    if (isContested) {
        confidenceScore = Math.min(confidenceScore, 0.65);
    }

    const resolvedHeaders = headers && headers.length > 0 ? headers : parseGameHeaders(task);
    const seatConflicts = detectOpposingSeatConflicts(allAnalystReports, analysts, resolvedHeaders);
    if (seatConflicts.length > 0) {
        for (let i = unanimousFindings.length - 1; i >= 0; i--) {
            if (findingMentionsSeatConflict(unanimousFindings[i], seatConflicts)) {
                unanimousFindings.splice(i, 1);
            }
        }
        for (let i = majorityFindings.length - 1; i >= 0; i--) {
            if (findingMentionsSeatConflict(majorityFindings[i], seatConflicts)) {
                majorityFindings.splice(i, 1);
            }
        }
        for (const c of seatConflicts) {
            const sidesDesc = c.seats.map(s => `${s.seatRole}: ${s.pickLabel} (${s.sideRole})`).join(' vs ');
            dissentingOpinions.unshift(`[seat_conflict] ${c.eventId}${c.matchup ? ` (${c.matchup})` : ''}: ${sidesDesc}`);
        }
        isContested = true;
        if (agreementLevel === 'strong') {
            agreementLevel = (unanimousFindings.length > 0 || majorityFindings.length > 0) ? 'moderate' : 'divergent';
        }
        confidenceScore = Math.min(confidenceScore, 0.65);
    }

    const summaryParts: string[] = [
        `Cross-Analyst Consensus: ${agreementLevel.toUpperCase()} (Score: ${(normalizedConsensus * 100).toFixed(0)}%, Evidence-Weighted: ${(evidenceWeightedScore * 100).toFixed(0)}%, Confidence: ${confidenceScore})`,
        `Specialists Analyzed: ${activeAnalystCount}`,
        `Unanimous Findings: ${unanimousFindings.length}`,
        `Majority Findings: ${majorityFindings.length}`,
        `Dissenting Observations: ${dissentingOpinions.length}`,
        `Verified Citations: ${calibratedEnsemble.totalVerifiedCitations}`,
        ...(seatConflicts.length > 0 ? [`Seat Conflicts: ${seatConflicts.length}`] : [])
    ];

    return {
        totalAnalysts: activeAnalystCount,
        consensusScore: normalizedConsensus,
        evidenceWeightedScore,
        agreementLevel,
        majorityFindings: majorityFindings.slice(0, 6),
        dissentingOpinions: dissentingOpinions.slice(0, 6),
        unanimousFindings: unanimousFindings.slice(0, 6),
        confidenceScore,
        summaryText: summaryParts.join(' | '),
        verifiedCitationsCount: calibratedEnsemble.totalVerifiedCitations,
        citationCountsBySeat,
        calibratedEnsemble,
        sampleVariance,
        sampleStdDev,
        isContested,
        ...(seatConflicts.length > 0 ? { seatConflicts } : {})
    };
}

/**
 * Formats the consensus digest and Brier-calibrated ensemble into a prompt block for the Manager Node.
 */
export function renderPromptConsensusBlock(digest: AnalystConsensusDigest): string {
    if (!digest || digest.totalAnalysts <= 1) return '';

    const lines: string[] = [
        `[Cross-Analyst Consensus & Arbitration (Agreement: ${(digest.consensusScore * 100).toFixed(0)}%, Evidence-Weighted: ${((digest.evidenceWeightedScore ?? digest.consensusScore) * 100).toFixed(0)}%, Level: ${digest.agreementLevel}, Confidence: ${digest.confidenceScore})]:`
    ];

    if (digest.calibratedEnsemble) {
        const ens = digest.calibratedEnsemble;
        const hasProbSeats = ens.seatWeights.some(s => s.rawProbability !== undefined);
        if (hasProbSeats) {
            lines.push(
                `• Brier-Calibrated Log-Odds Ensemble: Pooled Probability=${(ens.pooledProbability * 100).toFixed(1)}% ` +
                `(95% Credible Band: [${(ens.confidenceInterval95[0] * 100).toFixed(1)}%, ${(ens.confidenceInterval95[1] * 100).toFixed(1)}%], ` +
                `Raw Mean: ${(ens.rawMeanProbability * 100).toFixed(1)}%, Extremizing k=${ens.extremizingFactorK}, Pooled Edge: ${ens.pooledEdgePercent}%)`
            );
        }
        if (ens.totalVerifiedCitations > 0) {
            const seatCitText = ens.seatWeights
                .map(s => `${s.seatRole}: ${s.verifiedCitationsCount} cit (w=${(s.normalizedWeight * 100).toFixed(0)}%)`)
                .join(', ');
            lines.push(`• Verified Evidence & Seat Calibration Weights: ${seatCitText}`);
        }
    }

    if (digest.unanimousFindings.length > 0) {
        lines.push('• Unanimous Consensus (100% Specialist Agreement):');
        for (const f of digest.unanimousFindings) {
            lines.push(`  - ${f}`);
        }
    }

    if (digest.majorityFindings.length > 0) {
        lines.push('• Majority Consensus (>=50% Specialist Agreement):');
        for (const f of digest.majorityFindings) {
            lines.push(`  - ${f}`);
        }
    }

    if (digest.dissentingOpinions.length > 0) {
        lines.push('• Minority / Dissenting Observations (Verify Against Raw Data):');
        for (const d of digest.dissentingOpinions) {
            lines.push(`  - ${d}`);
        }
    }

    if (digest.isContested) {
        lines.push(
            `• [CONTESTED_CONSENSUS]: High variance detected across specialist predictions` +
            (digest.sampleVariance !== undefined ? ` (sample variance: ${digest.sampleVariance.toFixed(4)}, std dev: ${digest.sampleStdDev?.toFixed(4)})` : '') +
            `. Analysts sharply disagree on core metrics or direction. Directive: Highlight conflicting perspectives, explain trade-offs, and do NOT state unearned certainty.`
        );
    }

    if (digest.agreementLevel === 'divergent' && digest.confidenceScore < 0.45) {
        lines.push('• High Divergence Warning: Specialist opinions sharply diverge with low consensus confidence (< 0.45). Directive: Evaluate a no_play / pass rating rather than forcing low-conviction picks.');
    }

    if (Array.isArray(digest.seatConflicts) && digest.seatConflicts.length > 0) {
        lines.push(renderSeatConflictPromptBlock(digest.seatConflicts));
    }

    lines.push('Directives: Give highest synthesis weight to Unanimous and Majority findings corroborated by verified citations and Brier-calibrated seat weights. Never label a seat_conflict game as Majority Consensus; prefer unconflicted legs agreed upon or unopposed by the other proposer. Address Dissenting Observations if corroborated by data.');

    return lines.join('\n');
}
