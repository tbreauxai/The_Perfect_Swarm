import { describe, it, expect } from 'vitest';
import { SemanticCacheInterceptor } from './semanticCacheInterceptor.ts';
import { MemoryCortex, DeterministicLocalEmbeddingProvider } from './memory.ts';

describe('Semantic Cache Interceptor', () => {
    it('should correctly intercept semantic cache hits and misses', async () => {
        const interceptor = new SemanticCacheInterceptor({ similarityThreshold: 0.96 });
        const embeddingProvider = new DeterministicLocalEmbeddingProvider();

        const query1 = "Analyze Qdrant cluster performance under high load";
        const vec1 = await embeddingProvider.embed(query1);
        const payload1 = [{ id: 'm1', content: 'Qdrant cluster is stable.' }];

        // Initially miss
        const res1 = interceptor.lookup(vec1);
        expect(res1.hit).toBe(false);

        // Store in cache
        interceptor.set(vec1, payload1);

        // Exact lookup should hit (> 0.96)
        const res2 = interceptor.lookup(vec1);
        expect(res2.hit).toBe(true);
        expect(res2.payload).toBe(payload1);

        // Similar query lookup (should hit if similarity >= 0.96)
        const querySimilar = "Analyze Qdrant cluster performance under high load.";
        const vecSimilar = await embeddingProvider.embed(querySimilar);
        const res3 = interceptor.lookup(vecSimilar);
        expect(res3.hit).toBe(true);

        // Dissimilar query lookup (should miss)
        const queryDiff = "What is the weather forecast for Tokyo tomorrow?";
        const vecDiff = await embeddingProvider.embed(queryDiff);
        const res4 = interceptor.lookup(vecDiff);
        expect(res4.hit).toBe(false);
    });

    it('should integrate with MemoryCortex', async () => {
        const embeddingProvider = new DeterministicLocalEmbeddingProvider();
        const cortex = new MemoryCortex({
            isolatedStore: true,
            embeddingProvider
        });

        await cortex.store("Qdrant vector search optimization techniques", { appId: 'app-a', qualityRating: 0.9 });

        // First retrieve (Cache Miss -> Qdrant / Fallback search)
        const retrieved1 = await cortex.retrieve("Qdrant vector search optimization techniques", { appId: 'app-a' });
        expect(retrieved1.length).toBeGreaterThan(0);

        // Second retrieve with identical/similar query (Cache Hit via Semantic Cache Interceptor)
        const statsBefore = cortex.getSemanticCacheStats();
        const retrieved2 = await cortex.retrieve("Qdrant vector search optimization techniques", { appId: 'app-a' });
        const statsAfter = cortex.getSemanticCacheStats();

        expect(statsAfter.hits).toBeGreaterThan(statsBefore.hits);
    });
});
