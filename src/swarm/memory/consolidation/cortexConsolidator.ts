import type { StorageBackend } from '../storage/types.ts';
import type { ConsolidationOptions, ConsolidationResult, StoredMemoryPoint } from '../types.ts';

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
                if (!payload.verified) {
                    shouldPrune = true;
                }
            }

            if (maxAgeDays !== undefined && payload.timestamp) {
                const ageDays = (now - new Date(payload.timestamp).getTime()) / (1000 * 60 * 60 * 24);
                if (ageDays > maxAgeDays && !payload.verified) {
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

        return memories.map((m: any, idx: number) => {
            const score = m.qualityRating !== undefined
                ? ` (Quality Rating: ${(m.qualityRating * 100).toFixed(0)}%)`
                : '';
            const feedbackText = m.feedback ? `\nFeedback: ${m.feedback}` : '';
            return `[Learning Exemplar ${idx + 1}]${score}:\n${m.content || JSON.stringify(m)}${feedbackText}`;
        }).join('\n\n');
    }

    /**
     * Formats contrastive learning post-mortems separating accurate judgments from failure post-mortems.
     */
    formatContrastivePostMortems(wins: any[], losses: any[]): string {
        if (wins.length === 0 && losses.length === 0) {
            return '';
        }

        const sections: string[] = ['[Contrastive Episodic Memory: Validated Wins vs. Past Pitfalls]'];

        if (wins.length > 0) {
            sections.push(
                'VALIDATED WINNING PATTERNS:\n' +
                wins.map((w, i) => {
                    const brierTag = typeof w.brierScore === 'number' ? `, Brier=${w.brierScore.toFixed(3)}` : '';
                    const marginTag = typeof w.margin === 'number' ? `, FinalMargin=${w.margin > 0 ? '+' : ''}${w.margin}` : '';
                    return `  + [Win #${i + 1}${brierTag}${marginTag}]: ${w.content || JSON.stringify(w)}`;
                }).join('\n')
            );
        }

        if (losses.length > 0) {
            sections.push(
                'GRADED LOSS POST-MORTEMS (AVOID REPEATING THESE BIASES):\n' +
                losses.map((l, i) => {
                    const brierTag = typeof l.brierScore === 'number' ? `, Brier=${l.brierScore.toFixed(3)}` : '';
                    const marginTag = typeof l.margin === 'number' ? `, FinalMargin=${l.margin > 0 ? '+' : ''}${l.margin}` : '';
                    const summaryTag = l.settledSummary ? ` | Settled: ${l.settledSummary}` : '';
                    return `  - [Loss/Miss #${i + 1}${brierTag}${marginTag}]: ${l.content || JSON.stringify(l)}${summaryTag}`;
                }).join('\n')
            );
        }

        return sections.join('\n\n');
    }
}
