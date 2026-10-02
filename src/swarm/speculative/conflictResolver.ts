import type {
    ConflictType,
    ConflictingAssertion,
    ConflictResolutionStrategy,
    ResolvedAssertion,
    ReconciledReportResult,
    ConflictResolutionOptions
} from './types.ts';

/**
 * Reconciles conflicting findings, contradictory metrics, and duplicate assertions
 * produced across speculative concurrent subtask executions.
 */
export class ConflictResolver {
    private static POSITIVE_KEYWORDS = ['healthy', 'nominal', 'optimal', 'passed', 'normal', 'safe', 'stable', 'cleared', 'success'];
    private static NEGATIVE_KEYWORDS = ['critical', 'anomaly', 'failure', 'degraded', 'breach', 'error', 'deadlock', 'spike', 'leaked', 'vulnerable', 'timeout', 'corrupted'];

    private static extractSentiment(text: string): 'positive' | 'negative' | 'neutral' {
        const lower = text.toLowerCase();
        let posCount = 0;
        let negCount = 0;
        for (const w of ConflictResolver.POSITIVE_KEYWORDS) {
            if (lower.includes(w)) posCount++;
        }
        for (const w of ConflictResolver.NEGATIVE_KEYWORDS) {
            if (lower.includes(w)) negCount++;
        }
        if (negCount > posCount) return 'negative';
        if (posCount > negCount) return 'positive';
        return 'neutral';
    }

    private static STOPWORDS = new Set([
        'the', 'a', 'an', 'is', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'with', 'due', 'without', 'are', 'was', 'were', 'it', 'its', 'by', 'as', 'from', 'this', 'that', 'these', 'those', 'have', 'has', 'had', 'been', 'will', 'would', 'could', 'should'
    ]);

    static extractContentKeywords(text: string): Set<string> {
        const words = (text || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        const result = new Set<string>();
        for (const w of words) {
            if (!ConflictResolver.STOPWORDS.has(w)) {
                result.add(w);
            }
        }
        return result;
    }

    /**
     * Computes fast token-level Jaccard similarity between two assertions.
     */
    static computeTextSimilarity(a: string, b: string): number {
        const tokensA = new Set((a || '').toLowerCase().match(/\b\w+\b/g) || []);
        const tokensB = new Set((b || '').toLowerCase().match(/\b\w+\b/g) || []);
        if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
        if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

        let intersection = 0;
        for (const t of tokensA) {
            if (tokensB.has(t)) intersection++;
        }
        const union = tokensA.size + tokensB.size - intersection;
        return union > 0 ? intersection / union : 0.0;
    }

    /**
     * Detects conflicts across an array of analyst report objects.
     */
    detectConflicts(reports: any[]): ConflictingAssertion[] {
        const conflicts: ConflictingAssertion[] = [];
        const allItems: {
            sourceAgentRole: string;
            type: 'insight' | 'anomaly';
            text: string;
            sentiment: 'positive' | 'negative' | 'neutral';
            keywords: Set<string>;
        }[] = [];

        for (const report of reports) {
            const role = report.role || report.agentRole || 'Specialist';
            if (Array.isArray(report.insights)) {
                for (const ins of report.insights) {
                    allItems.push({
                        sourceAgentRole: role,
                        type: 'insight',
                        text: ins,
                        sentiment: ConflictResolver.extractSentiment(ins),
                        keywords: ConflictResolver.extractContentKeywords(ins)
                    });
                }
            }
            if (Array.isArray(report.anomalies)) {
                for (const anom of report.anomalies) {
                    allItems.push({
                        sourceAgentRole: role,
                        type: 'anomaly',
                        text: anom,
                        sentiment: 'negative',
                        keywords: ConflictResolver.extractContentKeywords(anom)
                    });
                }
            }
        }

        // Compare pairwise for duplicates or contradictions
        const processedPairs = new Set<string>();

        for (let i = 0; i < allItems.length; i++) {
            for (let j = i + 1; j < allItems.length; j++) {
                const itemA = allItems[i];
                const itemB = allItems[j];
                const pairKey = `${i}-${j}`;
                if (processedPairs.has(pairKey)) continue;

                const similarity = ConflictResolver.computeTextSimilarity(itemA.text, itemB.text);

                // Check for shared content subject words
                const sharedKeywords: string[] = [];
                for (const kw of itemA.keywords) {
                    if (itemB.keywords.has(kw)) {
                        sharedKeywords.push(kw);
                    }
                }

                // 1. Check for near-duplicate claims
                if (similarity >= 0.70) {
                    processedPairs.add(pairKey);
                    conflicts.push({
                        id: `dup-${i}-${j}`,
                        topic: sharedKeywords[0] || itemA.text.slice(0, 40),
                        conflictType: 'duplicate',
                        claims: [
                            { sourceAgentRole: itemA.sourceAgentRole, claim: itemA.text, confidence: 0.85, sentiment: itemA.sentiment },
                            { sourceAgentRole: itemB.sourceAgentRole, claim: itemB.text, confidence: 0.85, sentiment: itemB.sentiment }
                        ]
                    });
                } 
                // 2. Check for sentiment contradiction on overlapping subject matter
                else if (
                    ((itemA.sentiment === 'positive' && itemB.sentiment === 'negative') ||
                     (itemA.sentiment === 'negative' && itemB.sentiment === 'positive')) &&
                    (similarity >= 0.30 || sharedKeywords.length > 0)
                ) {
                    processedPairs.add(pairKey);
                    const topicName = sharedKeywords[0] || itemA.text.slice(0, 40);
                    conflicts.push({
                        id: `contra-${i}-${j}`,
                        topic: topicName,
                        conflictType: 'contradiction',
                        claims: [
                            { sourceAgentRole: itemA.sourceAgentRole, claim: itemA.text, confidence: 0.80, sentiment: itemA.sentiment },
                            { sourceAgentRole: itemB.sourceAgentRole, claim: itemB.text, confidence: 0.80, sentiment: itemB.sentiment }
                        ]
                    });
                }
            }
        }

        return conflicts;
    }

    /**
     * Resolves detected conflicts using the chosen strategy.
     */
    resolveConflicts(
        conflicts: ConflictingAssertion[],
        options?: ConflictResolutionOptions
    ): ResolvedAssertion[] {
        const strategy = options?.strategy ?? 'conservative_pessimistic';
        const capabilityScorer = options?.capabilityScorer;
        const resolutions: ResolvedAssertion[] = [];

        for (const conflict of conflicts) {
            if (conflict.conflictType === 'duplicate') {
                // Deduplicate: pick the longer, more informative assertion
                const sorted = [...conflict.claims].sort((a, b) => b.claim.length - a.claim.length);
                resolutions.push({
                    topic: conflict.topic,
                    resolvedClaim: sorted[0].claim,
                    conflictType: 'duplicate',
                    strategy: 'deduplicate_union',
                    confidence: sorted[0].confidence,
                    contributingSources: conflict.claims.map(c => c.sourceAgentRole),
                    rationale: `Merged ${conflict.claims.length} redundant assertions into detailed phrasing.`
                });
                continue;
            }

            if (conflict.conflictType === 'contradiction' || conflict.conflictType === 'severity_mismatch') {
                if (strategy === 'conservative_pessimistic') {
                    // Safety-first: select the negative / anomaly warning
                    const pessimisticClaim = conflict.claims.find(c => c.sentiment === 'negative') || conflict.claims[0];
                    resolutions.push({
                        topic: conflict.topic,
                        resolvedClaim: pessimisticClaim.claim,
                        conflictType: conflict.conflictType,
                        strategy,
                        confidence: pessimisticClaim.confidence,
                        contributingSources: conflict.claims.map(c => c.sourceAgentRole),
                        rationale: 'Conservative safety-first policy prioritized active anomaly warning.'
                    });
                } else if (strategy === 'confidence_weighted' && capabilityScorer) {
                    // Weight claims by specialist role proficiency
                    const weighted = conflict.claims.map(c => ({
                        ...c,
                        weight: (capabilityScorer(c.sourceAgentRole) || 0.5) * c.confidence
                    })).sort((a, b) => b.weight - a.weight);

                    resolutions.push({
                        topic: conflict.topic,
                        resolvedClaim: weighted[0].claim,
                        conflictType: conflict.conflictType,
                        strategy,
                        confidence: weighted[0].confidence,
                        contributingSources: conflict.claims.map(c => c.sourceAgentRole),
                        rationale: `Confidence-weighted resolution prioritized ${weighted[0].sourceAgentRole} (score: ${weighted[0].weight.toFixed(2)}).`
                    });
                } else {
                    // Majority consensus
                    const negCount = conflict.claims.filter(c => c.sentiment === 'negative').length;
                    const posCount = conflict.claims.filter(c => c.sentiment === 'positive').length;
                    const winning = negCount >= posCount 
                        ? (conflict.claims.find(c => c.sentiment === 'negative') || conflict.claims[0])
                        : (conflict.claims.find(c => c.sentiment === 'positive') || conflict.claims[0]);

                    resolutions.push({
                        topic: conflict.topic,
                        resolvedClaim: winning.claim,
                        conflictType: conflict.conflictType,
                        strategy: 'majority_consensus',
                        confidence: winning.confidence,
                        contributingSources: conflict.claims.map(c => c.sourceAgentRole),
                        rationale: `Majority quorum selected ${winning.sentiment} assertion.`
                    });
                }
            }
        }

        return resolutions;
    }

    /**
     * Unifies and reconciles multiple parallel specialist reports into a coherent consolidated report.
     */
    reconcileReports(
        reports: any[],
        options?: ConflictResolutionOptions
    ): ReconciledReportResult {
        if (!reports || reports.length === 0) {
            return {
                insights: [],
                anomalies: [],
                summary: "",
                conflicts: [],
                resolutions: [],
                duplicateCount: 0
            };
        }

        const conflicts = this.detectConflicts(reports);
        const resolutions = this.resolveConflicts(conflicts, options);

        // Track discarded duplicate claims to omit from final outputs
        const discardedDuplicates = new Set<string>();
        for (const res of resolutions) {
            if (res.conflictType === 'duplicate') {
                const conf = conflicts.find(c => c.topic === res.topic);
                if (conf) {
                    for (const cl of conf.claims) {
                        if (cl.claim !== res.resolvedClaim) {
                            discardedDuplicates.add(cl.claim);
                        }
                    }
                }
            }
        }

        const uniqueInsights: string[] = [];
        const uniqueAnomalies: string[] = [];
        const summaries: string[] = [];

        for (const r of reports) {
            if (r.summary && typeof r.summary === 'string' && !summaries.includes(r.summary)) {
                summaries.push(r.summary);
            }

            if (Array.isArray(r.insights)) {
                for (const ins of r.insights) {
                    if (discardedDuplicates.has(ins)) continue;
                    const isDup = uniqueInsights.some(u => ConflictResolver.computeTextSimilarity(u, ins) >= 0.70);
                    if (!isDup) uniqueInsights.push(ins);
                }
            }

            if (Array.isArray(r.anomalies)) {
                for (const anom of r.anomalies) {
                    if (discardedDuplicates.has(anom)) continue;
                    const isDup = uniqueAnomalies.some(u => ConflictResolver.computeTextSimilarity(u, anom) >= 0.70);
                    if (!isDup) uniqueAnomalies.push(anom);
                }
            }
        }

        return {
            insights: uniqueInsights,
            anomalies: uniqueAnomalies,
            summary: summaries.join(' ') || "Reconciled multi-specialist speculative analysis.",
            conflicts,
            resolutions,
            duplicateCount: discardedDuplicates.size
        };
    }
}
