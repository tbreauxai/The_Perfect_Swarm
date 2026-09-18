import { describe, it, expect } from 'vitest';
import {
    MetricMath,
    VpTreeIndex,
    HnswVectorIndex,
    createVectorIndex,
    type VectorIndexItem
} from './vectorIndex.ts';

describe('MetricMath Primitives', () => {
    it('computes accurate cosine similarity and distance', () => {
        const a = [1, 0, 0];
        const b = [1, 0, 0];
        const c = [0, 1, 0];
        const d = [-1, 0, 0];

        expect(MetricMath.cosineSimilarity(a, b)).toBeCloseTo(1.0);
        expect(MetricMath.cosineDistance(a, b)).toBeCloseTo(0.0);

        expect(MetricMath.cosineSimilarity(a, c)).toBeCloseTo(0.0);
        expect(MetricMath.cosineDistance(a, c)).toBeCloseTo(1.0);

        expect(MetricMath.cosineSimilarity(a, d)).toBeCloseTo(-1.0);
        expect(MetricMath.cosineDistance(a, d)).toBeCloseTo(2.0);
    });

    it('computes Euclidean distance and satisfies triangle inequality', () => {
        const p1 = [1, 2, 3];
        const p2 = [4, 6, 8];
        const p3 = [2, 1, 0];

        const d12 = MetricMath.euclideanDistance(p1, p2);
        const d23 = MetricMath.euclideanDistance(p2, p3);
        const d13 = MetricMath.euclideanDistance(p1, p3);

        expect(d12).toBeGreaterThan(0);
        // Triangle inequality: d(p1, p3) <= d(p1, p2) + d(p2, p3)
        expect(d13).toBeLessThanOrEqual(d12 + d23 + 1e-9);
    });

    it('normalizes arbitrary vectors to unit length', () => {
        const v = [3, 4, 0];
        const normalized = MetricMath.normalize(v);
        expect(MetricMath.l2Norm(normalized)).toBeCloseTo(1.0);
        expect(normalized[0]).toBeCloseTo(0.6);
        expect(normalized[1]).toBeCloseTo(0.8);
    });
});

describe('VpTreeIndex: Sub-linear O(log n) Metric Tree', () => {
    function generateSyntheticVectors(count: number, dim: number = 64): VectorIndexItem<{ tag: string }>[] {
        const items: VectorIndexItem<{ tag: string }>[] = [];
        let seed = 42;
        const pseudoRand = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return (seed / 233280) * 2 - 1;
        };
        for (let i = 0; i < count; i++) {
            const raw = Array.from({ length: dim }, () => pseudoRand());
            const vector = MetricMath.normalize(raw);
            items.push({
                id: `pt-${i}`,
                vector,
                data: { tag: `item-${i}` }
            });
        }
        return items;
    }

    it('inserts items and retrieves exact top-k nearest neighbors', () => {
        const index = new VpTreeIndex<{ label: string }>();

        index.insert('item-1', [1, 0, 0], { label: 'X-axis' });
        index.insert('item-2', [0, 1, 0], { label: 'Y-axis' });
        index.insert('item-3', [0, 0, 1], { label: 'Z-axis' });
        index.insert('item-4', [0.7071, 0.7071, 0], { label: 'XY-diagonal' });

        expect(index.size).toBe(4);
        expect(index.dimension).toBe(3);

        // Query close to X-axis
        const query = [0.99, 0.05, 0];
        const top2 = index.search(query, { k: 2 });

        expect(top2).toHaveLength(2);
        expect(top2[0].id).toBe('item-1');
        expect(top2[0].similarity).toBeGreaterThan(0.95);
        expect(top2[1].id).toBe('item-4');
    });

    it('prunes search space in O(log n) vs linear O(n) comparisons on large dataset', () => {
        const count = 300;
        const dim = 32;
        const dataset = generateSyntheticVectors(count, dim);

        const index = new VpTreeIndex();
        index.insertBatch(dataset);

        expect(index.size).toBe(count);
        const metrics = index.getMetrics();
        expect(metrics.depth).toBeGreaterThan(5);
        expect(metrics.depth).toBeLessThan(14); // logarithmic depth log2(300) ~ 8.2

        // Query search
        const query = dataset[15].vector;
        const results = index.search(query, { k: 5 });

        expect(results).toHaveLength(5);
        expect(results[0].id).toBe(dataset[15].id);
        expect(results[0].similarity).toBeCloseTo(1.0, 3);

        // Verify pruning: comparisons should be substantially lower than full O(n) = 300 comparisons
        const searchComparisons = index.getMetrics().lastSearchComparisons;
        expect(searchComparisons).toBeLessThan(count);
        expect(searchComparisons).toBeGreaterThan(0);
    });

    it('finds near-duplicate items within radius threshold for deduplication', () => {
        const index = new VpTreeIndex<{ topic: string }>();

        const baseVector = MetricMath.normalize([1, 1, 1, 1]);
        index.insert('base-memory', baseVector, { topic: 'system-auth' });

        // Slightly perturbed vector (~0.98 similarity, cosine distance ~0.02)
        const perturbed = MetricMath.normalize([1.02, 0.98, 1.01, 0.99]);
        const distant = MetricMath.normalize([1, -1, 1, -1]);

        index.insert('distant-memory', distant, { topic: 'performance' });

        // Search within 0.08 cosine distance threshold (>= 0.92 cosine similarity)
        const matches = index.findWithinRadius(perturbed, 0.08);
        expect(matches).toHaveLength(1);
        expect(matches[0].id).toBe('base-memory');
        expect(matches[0].similarity).toBeGreaterThanOrEqual(0.92);

        // Most similar helper
        const best = index.findMostSimilar(perturbed, 0.92);
        expect(best).toBeDefined();
        expect(best?.id).toBe('base-memory');
    });

    it('filters items with predicate functions during search', () => {
        const index = new VpTreeIndex<{ appId: string; rating: number }>();

        index.insert('m1', [1, 0], { appId: 'app-a', rating: 0.9 });
        index.insert('m2', [0.99, 0.05], { appId: 'app-b', rating: 0.5 });
        index.insert('m3', [0.98, 0.1], { appId: 'app-a', rating: 0.4 });

        // Filter by appId === 'app-a' and rating >= 0.8
        const res = index.search([1, 0], {
            k: 5,
            filter: (item) => item.data.appId === 'app-a' && item.data.rating >= 0.8
        });

        expect(res).toHaveLength(1);
        expect(res[0].id).toBe('m1');
    });

    it('handles dynamic deletion and serialization', () => {
        const index = new VpTreeIndex<{ content: string }>();

        index.insert('doc-1', [1, 2, 3], { content: 'hello' });
        index.insert('doc-2', [4, 5, 6], { content: 'world' });

        expect(index.has('doc-1')).toBe(true);
        const deleted = index.delete('doc-1');
        expect(deleted).toBe(true);
        expect(index.has('doc-1')).toBe(false);
        expect(index.size).toBe(1);

        // Serialize and restore
        const serialized = index.serialize();
        const restored = new VpTreeIndex<{ content: string }>();
        restored.deserialize(serialized);

        expect(restored.size).toBe(1);
        expect(restored.get('doc-2')?.data.content).toBe('world');
    });
});

describe('HnswVectorIndex: Proximity Graph Navigation', () => {
    it('indexes items and routes to nearest neighbors in O(log n) layers', () => {
        const hnsw = new HnswVectorIndex<{ role: string }>({ m: 8, efSearch: 16 });

        hnsw.insert('auth-1', MetricMath.normalize([1, 0, 0, 0]), { role: 'Security' });
        hnsw.insert('auth-2', MetricMath.normalize([0.9, 0.1, 0, 0]), { role: 'Security' });
        hnsw.insert('perf-1', MetricMath.normalize([0, 1, 0, 0]), { role: 'Performance' });
        hnsw.insert('data-1', MetricMath.normalize([0, 0, 1, 0]), { role: 'Database' });

        expect(hnsw.size).toBe(4);

        const query = MetricMath.normalize([0.95, 0.05, 0, 0]);
        const results = hnsw.search(query, { k: 2 });

        expect(results.length).toBe(2);
        expect(results[0].id).toBe('auth-1');
        expect(results[0].similarity).toBeGreaterThan(0.95);
        expect(results[1].id).toBe('auth-2');

        const metrics = hnsw.getMetrics();
        expect(metrics.type).toBe('hnsw');
        expect(metrics.timeComplexity).toBe('O(log n)');
    });

    it('deletes nodes and updates entry points cleanly', () => {
        const hnsw = new HnswVectorIndex();
        hnsw.insert('n1', [1, 0], {});
        hnsw.insert('n2', [0, 1], {});

        expect(hnsw.delete('n1')).toBe(true);
        expect(hnsw.size).toBe(1);
        expect(hnsw.has('n1')).toBe(false);

        const res = hnsw.search([1, 0], { k: 1 });
        expect(res[0].id).toBe('n2');
    });
});

describe('Vector Index Factory', () => {
    it('constructs requested index types with factory', () => {
        const vp = createVectorIndex('vptree');
        expect(vp.getMetrics().type).toBe('vptree');

        const hnsw = createVectorIndex('hnsw');
        expect(hnsw.getMetrics().type).toBe('hnsw');
    });
});
