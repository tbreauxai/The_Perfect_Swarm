import { describe, it, expect } from 'vitest';
import { SemanticCacheInterceptor } from './semanticCacheInterceptor.ts';

describe('SemanticCacheInterceptor with RRF', () => {
    it('initializes with default 0.88 similarity threshold', () => {
        const interceptor = new SemanticCacheInterceptor();
        expect((interceptor as any).threshold).toBe(0.88);
    });

    it('returns cache hit when semantic similarity >= 0.88', () => {
        const interceptor = new SemanticCacheInterceptor({ similarityThreshold: 0.88 });
        const vectorA = [1.0, 0.0, 0.0, 0.0];
        interceptor.set(vectorA, { result: 'cached synthesis data' }, 'app-1');

        // Query with near-identical vector (cosine sim = 0.99 > 0.88)
        const vectorQuery = [0.99, 0.05, 0.0, 0.0];
        const match = interceptor.lookup(vectorQuery, 'app-1');

        expect(match.hit).toBe(true);
        expect(match.payload).toEqual({ result: 'cached synthesis data' });
        expect(match.similarity).toBeGreaterThanOrEqual(0.88);
    });

    it('returns miss when semantic similarity < 0.88', () => {
        const interceptor = new SemanticCacheInterceptor({ similarityThreshold: 0.88 });
        const vectorA = [1.0, 0.0, 0.0, 0.0];
        interceptor.set(vectorA, { result: 'cached synthesis data' }, 'app-1');

        // Query with orthogonal vector (cosine sim = 0.0 < 0.88)
        const vectorQuery = [0.0, 1.0, 0.0, 0.0];
        const match = interceptor.lookup(vectorQuery, 'app-1');

        expect(match.hit).toBe(false);
    });

    it('performs hybrid search with Reciprocal Rank Fusion (RRF)', () => {
        const interceptor = new SemanticCacheInterceptor({ similarityThreshold: 0.88 });

        const vec1 = [1.0, 0.0, 0.0, 0.0];
        interceptor.set(vec1, { title: 'PostgreSQL Connection Pooling Analysis', tags: ['database', 'postgres'] }, 'app-1');

        const vec2 = [0.95, 0.1, 0.0, 0.0];
        interceptor.set(vec2, { title: 'Redis Cache Hit Rate Degradation', tags: ['cache', 'redis'] }, 'app-1');

        // Query vector near vec1, with matching keywords 'postgresql pooling'
        const queryVec = [0.98, 0.02, 0.0, 0.0];
        const rrfResult = interceptor.lookupWithRRF(queryVec, 'postgresql connection pooling', 'app-1', 0.88);

        expect(rrfResult.hit).toBe(true);
        expect(rrfResult.payload?.title).toContain('PostgreSQL');
        expect(rrfResult.rrfScore).toBeGreaterThan(0);
        expect(rrfResult.similarity).toBeGreaterThanOrEqual(0.88);
    });
});
