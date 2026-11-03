import { describe, it, expect, vi } from 'vitest';
import { MemoryCortex } from './cortex.ts';
import { type EmbeddingProvider } from './types.ts';

describe('Embedding Provider Fallback Non-Mutation Tests', () => {
    it('a Gemini failure does not replace this.embeddingProvider with the hash embedder', async () => {
        // Create a mock primary Gemini embedding provider that always fails
        let embedCallCount = 0;
        const mockGeminiProvider: EmbeddingProvider = {
            dimension: 768,
            async embed(_text: string): Promise<number[]> {
                embedCallCount++;
                throw new Error('503 Service Unavailable: Gemini API down');
            }
        };

        const cortex = new MemoryCortex({
            embeddingProvider: mockGeminiProvider,
            collectionName: 'test-embedding-fallback'
        });
        await cortex.initialize();

        // Initial check: cortex has the mockGeminiProvider assigned
        expect((cortex as any).embeddingProvider).toBe(mockGeminiProvider);

        // 1. Call store: triggers safeEmbed
        const storedId = await cortex.store('Test content for safeEmbed', {
            workflowId: 'wf-embed-1',
            originApp: 'duelodds'
        });

        expect(storedId).toBeDefined();
        // Crucial requirement: this.embeddingProvider must NOT be replaced with DeterministicLocalEmbeddingProvider
        expect((cortex as any).embeddingProvider).toBe(mockGeminiProvider);
        expect(embedCallCount).toBeGreaterThanOrEqual(1);

        // 2. Call upsertGradedLesson: retries primary and falls back per-request
        const prevCallCount = embedCallCount;
        const lessonId = 'lesson-non-mutation-test';
        const lessonStoredId = await cortex.upsertGradedLesson(lessonId, {
            reason: 'Test reason for graded lesson',
            sportKey: 'nfl',
            originApp: 'duelodds'
        });

        expect(lessonStoredId).toBe(lessonId);
        // Retried primary embedder twice (first + retry)
        expect(embedCallCount).toBe(prevCallCount + 2);
        // Crucial requirement: this.embeddingProvider must still remain the primary embedder
        expect((cortex as any).embeddingProvider).toBe(mockGeminiProvider);

        // Verify stored point has valid 768-dim vector from fallback
        const savedPoint = cortex.fallbackStore.find(p => p.id === lessonId);
        expect(savedPoint).toBeDefined();
        expect(savedPoint?.denseVector).toHaveLength(768);
    });
});
