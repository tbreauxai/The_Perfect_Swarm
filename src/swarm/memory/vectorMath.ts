import type { SparseVector } from './types.ts';

/**
 * Computes cosine similarity between two dense numerical vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Computes dot product between two sparse vectors.
 */
export function sparseDotProduct(query: SparseVector, target: SparseVector): number {
    if (!query || !target) return 0;
    const targetMap = new Map<number, number>();
    for (let i = 0; i < target.indices.length; i++) {
        targetMap.set(target.indices[i], target.values[i]);
    }
    let score = 0;
    for (let i = 0; i < query.indices.length; i++) {
        const targetVal = targetMap.get(query.indices[i]);
        if (targetVal !== undefined) {
            score += query.values[i] * targetVal;
        }
    }
    return score;
}
