import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryCortex, DeterministicLocalEmbeddingProvider } from './memory.ts';
import { SemanticBaselineCache, SemanticSimilarityEngine } from './cache.ts';

describe('MemoryCortex: O(log n) Vector Indexing & Deduplication', () => {
    let cortex: MemoryCortex;

    beforeEach(() => {
        MemoryCortex.clearFallbackStore('test_indexing_cortex');
        cortex = new MemoryCortex({
            collectionName: 'test_indexing_cortex',
            defaultAppId: 'indexing-test-app',
            isolatedStore: true,
            embeddingProvider: new DeterministicLocalEmbeddingProvider()
        });
    });

    it('initializes in-memory vector index and reports O(log n) complexity metrics', () => {
        const metrics = cortex.getIndexMetrics();
        expect(metrics).toBeDefined();
        expect(metrics.type).toBe('vptree');
        expect(metrics.timeComplexity).toBe('O(log n)');
        expect(metrics.size).toBe(0);
    });

    it('indexes stored memories and performs sub-linear O(log n) deduplication', async () => {
        const id1 = await cortex.store('Critical security vulnerability: JWT expiration not enforced on token refresh endpoint.', {
            domain: 'security',
            agentRole: 'Security Auditor',
            qualityRating: 0.95,
            verified: true
        });

        expect(id1).toBeDefined();
        expect(cortex.getIndexMetrics().size).toBe(1);

        // Near-identical payload should be deduplicated via O(log n) vector index search
        const id2 = await cortex.store('Critical security vulnerability: JWT expiration not enforced on token refresh endpoint.', {
            domain: 'security',
            agentRole: 'Security Auditor',
            qualityRating: 0.98
        });

        expect(id2).toBe(id1); // Deduplicated to same ID
        expect(cortex.getIndexMetrics().size).toBe(1);

        // Verify frequency incremented on the stored point
        const retrieved = await cortex.retrieve('JWT expiration token refresh', { appId: 'indexing-test-app' });
        expect(retrieved).toHaveLength(1);
        expect(retrieved[0].frequency).toBe(2);
        expect(retrieved[0].qualityRating).toBe(0.98);
    });

    it('retrieves relevant memories via vector index candidate search and hybrid RRF', async () => {
        await cortex.store('Database connection pool exhausted due to unclosed client sessions', {
            domain: 'database',
            agentRole: 'DBA'
        });
        await cortex.store('Slow query on users table missing compound index on tenant_id and email', {
            domain: 'database',
            agentRole: 'DBA'
        });
        await cortex.store('CORS misconfiguration exposes sensitive API endpoints to unauthorized origins', {
            domain: 'security',
            agentRole: 'Security Analyst'
        });
        await cortex.store('Memory leak in node cluster worker thread allocations', {
            domain: 'performance',
            agentRole: 'Performance Engineer'
        });

        expect(cortex.getIndexMetrics().size).toBe(4);

        // Retrieve database issues
        const dbResults = await cortex.retrieve('Slow database query missing index', {
            domain: 'database',
            limit: 2
        });

        expect(dbResults).toHaveLength(2);
        expect(dbResults[0].content).toContain('Slow query on users table');
        expect(dbResults[1].content).toContain('Database connection pool');
    });

    it('synchronizes vector index during memory consolidation pruning', async () => {
        const id1 = await cortex.store('High quality exemplar baseline', { qualityRating: 0.95 });
        const id2 = await cortex.store('Low quality noise point 1', { qualityRating: 0.20 });
        const id3 = await cortex.store('Low quality noise point 2', { qualityRating: 0.15 });

        expect(cortex.getIndexMetrics().size).toBe(3);

        const consolidation = await cortex.consolidateMemories({ minRating: 0.50, pruneLowQuality: true });
        expect(consolidation.pruned).toBe(2);
        expect(consolidation.retained).toBe(1);

        // Vector index should now have 1 item
        expect(cortex.getIndexMetrics().size).toBe(1);
        const remaining = await cortex.retrieve('High quality exemplar', { minRating: 0.50 });
        expect(remaining).toHaveLength(1);
        expect(remaining[0].content).toContain('High quality exemplar');
    });

    it('scales logarithmically across large memory stores with reduced search comparisons', async () => {
        // Populate 100 memories across diverse topics
        const topics = ['security authentication', 'database transaction', 'frontend bundle latency', 'network timeout retry', 'caching invalidation'];
        for (let i = 0; i < 100; i++) {
            const topic = topics[i % topics.length];
            await cortex.store(`Telemetry anomaly pattern ${i}: ${topic} error rate spike ${i * 3}%`, {
                domain: topic.split(' ')[0],
                agentRole: 'Analyst'
            }, false);
        }

        const metrics = cortex.getIndexMetrics();
        expect(metrics.size).toBe(100);
        expect(metrics.depth).toBeGreaterThan(4);
        expect(metrics.depth).toBeLessThan(12);

        // Search for authentication
        const results = await cortex.retrieve('security authentication anomaly', { limit: 5 });
        expect(results).toHaveLength(5);
        expect(results[0].content).toContain('security');

        // Verify pruning occurred during search
        const searchMetrics = cortex.getIndexMetrics();
        expect(searchMetrics.lastSearchComparisons).toBeGreaterThan(0);
        expect(searchMetrics.lastSearchComparisons).toBeLessThan(100);
    });
});

describe('SemanticBaselineCache: O(log n) Vector Search', () => {
    let cache: SemanticBaselineCache;

    beforeEach(() => {
        cache = new SemanticBaselineCache({ maxEntries: 100, similarityThreshold: 0.80 });
    });

    it('indexes semantic cache entries and matches intent in O(log n)', () => {
        cache.set('Audit authentication token security and JWT expiration', {
            ui_title: 'Auth Audit Report',
            components: []
        });

        expect(cache.getIndexMetrics().size).toBe(1);
        expect(cache.getIndexMetrics().timeComplexity).toBe('O(log n)');

        const match = cache.findMatch('Auditing authentication tokens security and JWT expiration times');
        expect(match.hit).toBe(true);
        expect(match.similarity).toBeGreaterThan(0.80);
        expect(match.entry?.payload.ui_title).toBe('Auth Audit Report');
    });

    it('evicts and clears cleanly from vector index', () => {
        cache.set('Task 1', { data: 'val 1' });
        cache.set('Task 2', { data: 'val 2' });
        expect(cache.getIndexMetrics().size).toBe(2);

        cache.clear();
        expect(cache.getIndexMetrics().size).toBe(0);

        const match = cache.findMatch('Task 1');
        expect(match.hit).toBe(false);
    });
});
