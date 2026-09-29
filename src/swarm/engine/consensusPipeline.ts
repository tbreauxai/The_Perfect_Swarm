/**
 * @file consensusPipeline.ts
 * @description Runtime Cross-Analyst Consensus Synthesis & Disagreement Arbitration.
 * Computes semantic similarity, identifies majority consensus findings, flags critical
 * minority dissenting observations, and provides structured consensus directives to the Manager Node.
 * Pure TypeScript, zero external runtime dependencies.
 */

import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';

export interface AnalystConsensusDigest {
    totalAnalysts: number;
    consensusScore: number; // 0.0 to 1.0 (mean agreement ratio)
    agreementLevel: 'strong' | 'moderate' | 'divergent';
    majorityFindings: string[]; // Findings supported by >= 50% of analysts
    dissentingOpinions: string[]; // High-signal findings flagged by only 1 analyst
    unanimousFindings: string[]; // Findings supported by 100% of analysts
    confidenceScore: number; // 0.0 to 1.0
    summaryText: string;
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

/**
 * Analyzes specialist reports across all analysts and computes consensus, majority agreements, and dissenting observations.
 */
export function extractAnalystConsensus(
    allAnalystReports: any[][],
    analysts: Agent[],
    task: string
): AnalystConsensusDigest {
    const activeAnalystCount = Math.min(allAnalystReports.length, analysts.length);
    if (activeAnalystCount === 0) {
        return {
            totalAnalysts: 0,
            consensusScore: 1.0,
            agreementLevel: 'strong',
            majorityFindings: [],
            dissentingOpinions: [],
            unanimousFindings: [],
            confidenceScore: 0.5,
            summaryText: 'No active analyst reports available for consensus synthesis.'
        };
    }

    if (activeAnalystCount === 1) {
        const singleInsights = extractAnalystInsights(allAnalystReports[0] || []);
        return {
            totalAnalysts: 1,
            consensusScore: 1.0,
            agreementLevel: 'strong',
            majorityFindings: singleInsights.slice(0, 5),
            dissentingOpinions: [],
            unanimousFindings: singleInsights.slice(0, 5),
            confidenceScore: 0.85,
            summaryText: `Single specialist analysis [${analysts[0]?.role}]: ${singleInsights.length} findings extracted.`
        };
    }

    // Extract per-analyst tokenized insights
    const perAnalystData: Array<{
        role: string;
        insights: string[];
        tokenSets: Set<string>[];
        combinedTokens: Set<string>;
    }> = [];

    for (let i = 0; i < activeAnalystCount; i++) {
        const role = analysts[i]?.role || `Analyst ${i + 1}`;
        const rawInsights = extractAnalystInsights(allAnalystReports[i] || []);
        const tokenSets = rawInsights.map(ins => new Set(tokenize(ins)));
        const combinedTokens = new Set<string>();
        for (const set of tokenSets) {
            for (const t of set) combinedTokens.add(t);
        }
        perAnalystData.push({
            role,
            insights: rawInsights,
            tokenSets,
            combinedTokens
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

    // 2. Map Insight Overlap & Support Frequency
    const allIndividualInsights: Array<{
        text: string;
        sourceRole: string;
        tokens: Set<string>;
        supportCount: number;
        supportingRoles: Set<string>;
    }> = [];

    for (const data of perAnalystData) {
        for (let k = 0; k < data.insights.length; k++) {
            allIndividualInsights.push({
                text: data.insights[k],
                sourceRole: data.role,
                tokens: data.tokenSets[k],
                supportCount: 1,
                supportingRoles: new Set([data.role])
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

    // Sort insights by support count descending
    allIndividualInsights.sort((x, y) => y.supportCount - x.supportCount);

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
                                 lower.includes('unexpected');

            if (isHighSignal && isDistinctFromAccepted(clean, dissentingOpinions)) {
                dissentingOpinions.push(`[${item.sourceRole}]: ${clean}`);
                seenTexts.add(clean.toLowerCase());
            }
        }
    }

    // 3. Compute Final Calibrated Consensus & Confidence Scores
    const acceptedCount = unanimousFindings.length + majorityFindings.length;
    const consensusRatio = acceptedCount > 0
        ? (unanimousFindings.length * 1.0 + majorityFindings.length * 0.8) /
          (unanimousFindings.length + majorityFindings.length + (dissentingOpinions.length * 0.25))
        : 0.1;

    const normalizedConsensus = Math.min(1.0, Math.max(0.1, Number(((rawPairwiseScore * 0.3) + (consensusRatio * 0.7)).toFixed(3))));

    let agreementLevel: 'strong' | 'moderate' | 'divergent';
    if (normalizedConsensus >= 0.60 || unanimousFindings.length >= 2) {
        agreementLevel = 'strong';
    } else if (normalizedConsensus >= 0.38 || majorityFindings.length >= 1) {
        agreementLevel = 'moderate';
    } else {
        agreementLevel = 'divergent';
    }

    const confidenceScore = Number(Math.min(0.99, Math.max(0.3,
        agreementLevel === 'strong' ? 0.90 + (normalizedConsensus * 0.08)
        : agreementLevel === 'moderate' ? 0.75 + (normalizedConsensus * 0.10)
        : 0.50
    )).toFixed(2));

    const summaryParts: string[] = [
        `Cross-Analyst Consensus: ${agreementLevel.toUpperCase()} (Score: ${(normalizedConsensus * 100).toFixed(0)}%, Confidence: ${confidenceScore})`,
        `Specialists Analyzed: ${activeAnalystCount}`,
        `Unanimous Findings: ${unanimousFindings.length}`,
        `Majority Findings: ${majorityFindings.length}`,
        `Dissenting Observations: ${dissentingOpinions.length}`
    ];

    return {
        totalAnalysts: activeAnalystCount,
        consensusScore: normalizedConsensus,
        agreementLevel,
        majorityFindings: majorityFindings.slice(0, 6),
        dissentingOpinions: dissentingOpinions.slice(0, 4),
        unanimousFindings: unanimousFindings.slice(0, 6),
        confidenceScore,
        summaryText: summaryParts.join(' | ')
    };
}

/**
 * Formats the consensus digest into a prompt block for the Manager Node.
 */
export function renderPromptConsensusBlock(digest: AnalystConsensusDigest): string {
    if (!digest || digest.totalAnalysts <= 1) return '';

    const lines: string[] = [
        `[Cross-Analyst Consensus & Arbitration (Agreement: ${(digest.consensusScore * 100).toFixed(0)}%, Level: ${digest.agreementLevel}, Confidence: ${digest.confidenceScore})]:`
    ];

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

    lines.push('Directives: Give highest synthesis weight to Unanimous and Majority findings. Address Dissenting Observations if corroborated by data.');

    return lines.join('\n');
}
