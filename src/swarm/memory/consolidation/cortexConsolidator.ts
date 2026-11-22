import type { StorageBackend } from '../storage/types.ts';
import type { ConsolidationOptions, ConsolidationResult, StoredMemoryPoint } from '../types.ts';
import {
    containsLegacyContractBoilerplate,
    isZeroBetPassRecord,
    MAX_MEMORY_SNIPPET_CHARS,
    truncateCleanText,
    truncateMemorySnippet
} from '../memorySanitizer.ts';

export interface CortexConsolidatorConfig {
    storage: StorageBackend;
    onSave?: () => Promise<void>;
}

export class CortexConsolidator {
    private storage: StorageBackend;
    private onSave?: () => Promise<void>;

    constructor(config: CortexConsolidatorConfig) {
        this.storage = config.storage;
        this.onSave = config.onSave;
    }

    /**
     * Consolidates and prunes memories based on minimum quality rating, expiration age, and near-duplicates.
     */
    async consolidate(options?: ConsolidationOptions): Promise<ConsolidationResult> {
        const minRating = options?.minRating ?? 0.40;
        const pruneLowQuality = options?.pruneLowQuality ?? false;
        const appId = options?.appId;
        const maxAgeDays = options?.maxAgeDays;

        const points = await this.storage.scroll(appId ? { appId } : undefined);
        const prunedIds: string[] = [];
        let inspected = 0;
        const now = Date.now();
        const seenContent = new Map<string, string>();

        for (const pt of points) {
            inspected++;
            const payload: Record<string, any> = pt.payload || {};
            let shouldPrune = false;

            if (pruneLowQuality && (payload.qualityRating ?? 0) < minRating) {
                if (!payload.verified && payload.memoryType !== 'fact' && payload.memory_type !== 'fact') {
                    shouldPrune = true;
                }
            }

            if (maxAgeDays !== undefined && payload.timestamp) {
                const ageDays = (now - new Date(payload.timestamp).getTime()) / (1000 * 60 * 60 * 24);
                if (ageDays > maxAgeDays && !payload.verified && payload.memoryType !== 'fact' && payload.memory_type !== 'fact') {
                    shouldPrune = true;
                }
            }

            if (!shouldPrune && payload.content && payload.appId) {
                const contentHash = `${payload.appId}:${payload.content.slice(0, 50).toLowerCase()}`;
                if (seenContent.has(contentHash)) {
                    shouldPrune = true;
                } else {
                    seenContent.set(contentHash, pt.id);
                }
            }

            if (shouldPrune) {
                prunedIds.push(pt.id);
            }
        }

        if (prunedIds.length > 0) {
            await this.storage.delete(prunedIds);
            if (this.onSave) {
                await this.onSave();
            }
        }

        return {
            inspected,
            pruned: prunedIds.length,
            retained: inspected - prunedIds.length,
            prunedIds
        };
    }

    /**
     * Formats top memories into structured few-shot exemplars for prompting.
     */
    formatExemplars(memories: any[]): string {
        if (!memories || memories.length === 0) return '';

        const filtered = memories.filter((m: any) => {
            if (!m || typeof m !== 'object') return false;
            if (isZeroBetPassRecord(m)) return false;
            if (
                containsLegacyContractBoilerplate(m.content) ||
                containsLegacyContractBoilerplate(m.resultSummary) ||
                containsLegacyContractBoilerplate(m.feedback) ||
                containsLegacyContractBoilerplate(m.lesson) ||
                containsLegacyContractBoilerplate(m.task)
            ) {
                return false;
            }
            return true;
        });
        if (filtered.length === 0) return '';

        return filtered.map((m: any, idx: number) => {
            const score = m.qualityRating !== undefined
                ? ` (Quality Rating: ${(m.qualityRating * 100).toFixed(0)}%)`
                : '';
            const rawBody = truncateMemorySnippet(String(m.content || m.resultSummary || JSON.stringify(m)), 260);
            const rawFeedback = m.feedback || m.lesson;
            const cleanFeedback = rawFeedback ? truncateMemorySnippet(String(rawFeedback), 100) : '';
            const feedbackText = cleanFeedback ? `\nFeedback: ${cleanFeedback}` : '';
            const entry = `[Learning Exemplar ${idx + 1}]${score}:\n${rawBody}${feedbackText}`;
            return truncateCleanText(entry, MAX_MEMORY_SNIPPET_CHARS);
        }).join('\n\n');
    }

    /**
     * Formats contrastive learning post-mortems separating accurate judgments from failure post-mortems.
     */
    formatContrastivePostMortems(wins: any[], losses: any[]): string {
        const cleanWins = (wins || []).filter((w: any) =>
            w &&
            typeof w === 'object' &&
            !isZeroBetPassRecord(w) &&
            !containsLegacyContractBoilerplate(w.content) &&
            !containsLegacyContractBoilerplate(w.resultSummary) &&
            !containsLegacyContractBoilerplate(w.task)
        );
        const cleanLosses = (losses || []).filter((l: any) =>
            l &&
            typeof l === 'object' &&
            !isZeroBetPassRecord(l) &&
            !containsLegacyContractBoilerplate(l.content) &&
            !containsLegacyContractBoilerplate(l.resultSummary) &&
            !containsLegacyContractBoilerplate(l.task)
        );

        if (cleanWins.length === 0 && cleanLosses.length === 0) {
            return '';
        }

        const sections: string[] = ['[Contrastive Episodic Memory: Validated Wins vs. Past Pitfalls]'];

        if (cleanWins.length > 0) {
            sections.push(
                'VALIDATED WINNING PATTERNS:\n' +
                cleanWins.map((w, i) => {
                    const brierTag = typeof w.brierScore === 'number' ? `, Brier=${w.brierScore.toFixed(3)}` : '';
                    const marginTag = typeof w.margin === 'number' ? `, FinalMargin=${w.margin > 0 ? '+' : ''}${w.margin}` : '';
                    const body = truncateMemorySnippet(String(w.content || w.resultSummary || JSON.stringify(w)), 260);
                    return truncateCleanText(`  + [Win #${i + 1}${brierTag}${marginTag}]: ${body}`, MAX_MEMORY_SNIPPET_CHARS);
                }).join('\n')
            );
        }

        if (cleanLosses.length > 0) {
            sections.push(
                'GRADED LOSS POST-MORTEMS (AVOID REPEATING THESE BIASES):\n' +
                cleanLosses.map((l, i) => {
                    const brierTag = typeof l.brierScore === 'number' ? `, Brier=${l.brierScore.toFixed(3)}` : '';
                    const marginTag = typeof l.margin === 'number' ? `, FinalMargin=${l.margin > 0 ? '+' : ''}${l.margin}` : '';
                    const cleanSummary = l.settledSummary ? truncateMemorySnippet(String(l.settledSummary), 110) : '';
                    const summaryTag = cleanSummary ? ` | Settled: ${cleanSummary}` : '';
                    const body = truncateMemorySnippet(String(l.content || l.resultSummary || JSON.stringify(l)), 220);
                    return truncateCleanText(`  - [Loss/Miss #${i + 1}${brierTag}${marginTag}]: ${body}${summaryTag}`, MAX_MEMORY_SNIPPET_CHARS);
                }).join('\n')
            );
        }

        return sections.join('\n\n');
    }
}
