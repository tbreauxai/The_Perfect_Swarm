import { describe, it, expect } from 'vitest';
import { SemanticVectorCache, type BaseCacheEntry } from './semanticVectorCache.ts';
import { BaseVectorIndex } from '../vectorIndex/baseIndex.ts';
import { createVectorIndex } from '../vectorIndex/factory.ts';

interface TestCacheEntry extends BaseCacheEntry {
    payload: string;
}

describe('Vector Index & Semantic Cache Deduplication (Goal 2)', () => {
    describe('BaseVectorIndex abstraction', () => {
        it('provides inherited findWithinRadius, findMostSimilar, and batch insertion', () => {
            const index = createVectorIndex('vptree', { metric: 'cosine' });
            expect(index).toBeInstanceOf(BaseVectorIndex);

            index.insertBatch([
                { id: '1', vector: [1, 0, 0], data: { label: 'item1' } },
                { id: '2', vector: [0.99, 0.01, 0], data: { label: 'item2' } },
                { id: '3', vector: [0, 1, 0], data: { label: 'item3' } }
            ]);

            expect(index.size).toBe(3);
            expect(index.dimension).toBe(3);

            // Radius search
            const withinRadius = index.findWithinRadius([1, 0, 0], 0.05);
            expect(withinRadius.length).toBe(2);

            // Most similar search
            const mostSimilar = index.findMostSimilar([1, 0, 0], 0.95);
            expect(mostSimilar).not.toBeNull();
            expect(mostSimilar?.id).toBe('1');
        });
    });

    describe('SemanticVectorCache generic base', () => {
        it('manages LRU eviction, TTL expiration, and hit statistics', async () => {
            const cache = new SemanticVectorCache<TestCacheEntry>({
                maxEntries: 2,
                defaultTtlMs: 50,
                similarityThreshold: 0.9
            });

            // Set entry 1
            (cache as any).entries.set('1', { id: '1', payload: 'first', expiresAt: Date.now() + 50, lastAccessedAt: Date.now(), hits: 0 });
            (cache as any).vectorIndex.insert('1', [1, 0, 0], (cache as any).entries.get('1'));

            // Set entry 2
            (cache as any).entries.set('2', { id: '2', payload: 'second', expiresAt: Date.now() + 50, lastAccessedAt: Date.now(), hits: 0 });
            (cache as any).vectorIndex.insert('2', [0, 1, 0], (cache as any).entries.get('2'));

            expect(cache.size).toBe(2);

            // Over-capacity triggers eviction of oldest
            (cache as any).evictLruIfNeeded();
            (cache as any).entries.set('3', { id: '3', payload: 'third', expiresAt: Date.now() + 50, lastAccessedAt: Date.now(), hits: 0 });
            (cache as any).vectorIndex.insert('3', [0, 0, 1], (cache as any).entries.get('3'));
            (cache as any).evictLruIfNeeded();

            expect(cache.size).toBeLessThanOrEqual(2);

            // Test stats reporting
            (cache as any).recordHit((cache as any).entries.get('3') || (cache as any).entries.get('2'));
            (cache as any).recordMiss();

            const stats = cache.getStats();
            expect(stats.hits).toBe(1);
            expect(stats.misses).toBe(1);
            expect(stats.hitRatio).toBe(0.5);
            expect(stats.estimatedLatencySavedMs).toBe(45);

            // Test TTL purge
            await new Promise(r => setTimeout(r, 60));
            const purged = cache.purgeExpired();
            expect(purged).toBeGreaterThanOrEqual(1);
        });
    });
});
