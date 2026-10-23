import { describe, it, expect } from 'vitest';
import { RrfRanker } from './rrfRanker.ts';
import type { StorageQueryResult } from '../storage/types.ts';

describe('RrfRanker', () => {
    const ranker = new RrfRanker({ rrfK: 60 });

    const createDenseHit = (id: string, score: number, payload: Record<string, any> = {}): StorageQueryResult => ({
        id,
        vectorScore: score,
        payload: {
            content: `Dense content for ${id}`,
            appId: 'test-app',
            originApp: 'test-app',
            domain: 'general',
            memoryType: 'judgment',
            qualityRating: 0.8,
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            ...payload
        }
    });

    const createSparseHit = (id: string, score: number, payload: Record<string, any> = {}): StorageQueryResult => ({
        id,
        vectorScore: score,
        payload: {
            content: `Sparse content for ${id}`,
            appId: 'test-app',
            originApp: 'test-app',
            domain: 'general',
            memoryType: 'judgment',
            qualityRating: 0.8,
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            ...payload
        }
    });

    it('fuses dense and sparse candidate rankings using RRF formula', () => {
        const denseHits: StorageQueryResult[] = [
            createDenseHit('doc-A', 0.95),
            createDenseHit('doc-B', 0.85),
            createDenseHit('doc-C', 0.70)
        ];

        const sparseHits: StorageQueryResult[] = [
            createSparseHit('doc-B', 12.5),
            createSparseHit('doc-A', 8.2),
            createSparseHit('doc-D', 5.0)
        ];

        const fused = ranker.fuse({
            denseHits,
            sparseHits,
            limit: 3
        });

        expect(fused.length).toBe(3);
        // doc-A is #1 in dense, #2 in sparse. doc-B is #2 in dense, #1 in sparse.
        // Both doc-A and doc-B should beat doc-C and doc-D.
        const topIds = fused.slice(0, 2).map(r => r.id);
        expect(topIds).toContain('doc-A');
        expect(topIds).toContain('doc-B');
    });

    it('respects denseWeight and sparseWeight presets', () => {
        const denseHits: StorageQueryResult[] = [
            createDenseHit('doc-dense-winner', 0.99),
            createDenseHit('doc-sparse-winner', 0.50)
        ];

        const sparseHits: StorageQueryResult[] = [
            createSparseHit('doc-sparse-winner', 25.0),
            createSparseHit('doc-dense-winner', 1.0)
        ];

        // Heavy dense weighting: dense winner should win
        const denseResult = ranker.fuse({
            denseHits,
            sparseHits,
            weights: { dense: 0.9, sparse: 0.1 },
            limit: 2
        });
        expect(denseResult[0].id).toBe('doc-dense-winner');

        // Heavy sparse weighting: sparse winner should win
        const sparseResult = ranker.fuse({
            denseHits,
            sparseHits,
            weights: { dense: 0.1, sparse: 0.9 },
            limit: 2
        });
        expect(sparseResult[0].id).toBe('doc-sparse-winner');
    });

    it('filters out candidates from other appIds when includeShared is false', () => {
        const denseHits: StorageQueryResult[] = [
            createDenseHit('doc-mine', 0.90, { appId: 'my-app', originApp: 'my-app' }),
            createDenseHit('doc-other', 0.95, { appId: 'other-app', originApp: 'other-app' })
        ];

        const results = ranker.rankAndFilter(denseHits, {
            appId: 'my-app',
            includeShared: false,
            query: 'test query'
        });

        expect(results.length).toBe(1);
        expect(results[0].id).toBe('doc-mine');
    });

    it('prioritizes facts over judgments with identical similarity', () => {
        const hits: StorageQueryResult[] = [
            createDenseHit('doc-judgment', 0.90, { memoryType: 'judgment', qualityRating: 0.8 }),
            createDenseHit('doc-fact', 0.90, { memoryType: 'fact', qualityRating: 0.8 })
        ];

        const results = ranker.rankAndFilter(hits, {
            appId: 'test-app',
            query: 'test'
        });

        expect(results.length).toBe(2);
        expect(results[0].id).toBe('doc-fact');
    });
});
