import { describe, it, expect, beforeEach } from 'vitest';
import { CortexConsolidator } from './cortexConsolidator.ts';
import { InMemoryStorageAdapter } from '../storage/inMemoryStorage.ts';
import type { StoredMemoryPoint } from '../types.ts';

describe('CortexConsolidator', () => {
    let storage: InMemoryStorageAdapter;
    let consolidator: CortexConsolidator;

    beforeEach(() => {
        storage = new InMemoryStorageAdapter({ isolatedStore: true });
        consolidator = new CortexConsolidator({ storage });
    });

    const createMockPoint = (
        id: string,
        rating: number,
        verified: boolean,
        content: string = 'Test memory',
        vector: number[] = [1, 0, 0]
    ): StoredMemoryPoint => ({
        id,
        denseVector: vector,
        sparseVector: { indices: [1], values: [0.5] },
        payload: {
            content,
            appId: 'test-app',
            originApp: 'test-app',
            domain: 'general',
            frequency: 1,
            qualityRating: rating,
            verified,
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        }
    });

    it('prunes unverified low-quality points when pruneLowQuality is enabled', async () => {
        await storage.store(createMockPoint('pt-bad', 0.2, false, 'Bad item content', [1, 0, 0]));
        await storage.store(createMockPoint('pt-verified-low', 0.2, true, 'Verified item content', [0, 1, 0]));
        await storage.store(createMockPoint('pt-good', 0.9, false, 'Good item content', [0, 0, 1]));

        const result = await consolidator.consolidate({
            minRating: 0.4,
            pruneLowQuality: true
        });

        expect(result.inspected).toBe(3);
        expect(result.pruned).toBe(1);
        expect(result.retained).toBe(2);
        expect(result.prunedIds).toContain('pt-bad');
        expect(await storage.get('pt-bad')).toBeNull();
        expect(await storage.get('pt-verified-low')).not.toBeNull();
        expect(await storage.get('pt-good')).not.toBeNull();
    });

    it('formats few-shot exemplars with quality rating and feedback', () => {
        const memories = [
            {
                content: 'Optimized PostgreSQL connection pool to 25',
                qualityRating: 0.95,
                feedback: 'Reduced latency by 40%'
            },
            {
                content: 'Refactored worker batch size to 8',
                qualityRating: 0.88
            }
        ];

        const formatted = consolidator.formatExemplars(memories);
        expect(formatted).toContain('[Learning Exemplar 1] (Quality Rating: 95%):');
        expect(formatted).toContain('Optimized PostgreSQL connection pool to 25');
        expect(formatted).toContain('Feedback: Reduced latency by 40%');
        expect(formatted).toContain('[Learning Exemplar 2] (Quality Rating: 88%):');
    });

    it('formats contrastive post-mortems with wins and losses', () => {
        const wins = [{ content: 'Solid prediction', qualityRating: 1.0, brierScore: 0.05 }];
        const losses = [{ content: 'Missed anomaly', qualityRating: 0.1, brierScore: 0.45, settledSummary: 'Overlooked warning' }];

        const formatted = consolidator.formatContrastivePostMortems(wins, losses);
        expect(formatted).toContain('VALIDATED WINNING PATTERNS:');
        expect(formatted).toContain('[Win #1, Brier=0.050]: Solid prediction');
        expect(formatted).toContain('GRADED LOSS POST-MORTEMS');
        expect(formatted).toContain('[Loss/Miss #1, Brier=0.450]: Missed anomaly | Settled: Overlooked warning');
    });
});
