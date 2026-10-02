import type { VectorDistanceMetric } from './types.ts';

/**
 * Common distance metric functions operating on floating-point dense vectors.
 */
export class MetricMath {
    /**
     * Computes the L2 norm (magnitude) of a vector.
     */
    static l2Norm(v: number[]): number {
        let sum = 0;
        for (let i = 0; i < v.length; i++) {
            sum += v[i] * v[i];
        }
        return Math.sqrt(sum) || 1e-12;
    }

    /**
     * Normalizes a vector to unit length (L2 norm = 1).
     */
    static normalize(v: number[]): number[] {
        const norm = MetricMath.l2Norm(v);
        const result = new Array(v.length);
        for (let i = 0; i < v.length; i++) {
            result[i] = v[i] / norm;
        }
        return result;
    }

    /**
     * Computes Euclidean distance between two vectors: sqrt(sum((a_i - b_i)^2)).
     * Strictly satisfies the triangle inequality.
     */
    static euclideanDistance(a: number[], b: number[]): number {
        let sum = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            const diff = a[i] - b[i];
            sum += diff * diff;
        }
        return Math.sqrt(sum);
    }

    /**
     * Computes Cosine Similarity in [-1, 1] (or clamped to [0, 1]).
     */
    static cosineSimilarity(a: number[], b: number[]): number {
        if (!a || !b || a.length === 0 || b.length === 0) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        const len = Math.min(a.length, b.length);

        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        if (denom === 0) return 0;
        const sim = dot / denom;
        return Math.min(1.0, Math.max(-1.0, sim));
    }

    /**
     * Computes Cosine Distance in [0, 2]: 1 - cosineSimilarity.
     */
    static cosineDistance(a: number[], b: number[]): number {
        return Math.max(0, 1.0 - MetricMath.cosineSimilarity(a, b));
    }

    /**
     * Computes Angular Distance in [0, 1]: arccos(cosineSimilarity) / PI.
     * Normalized angular distance is a true metric satisfying triangle inequality.
     */
    static angularDistance(a: number[], b: number[]): number {
        const sim = MetricMath.cosineSimilarity(a, b);
        return Math.acos(Math.min(1.0, Math.max(-1.0, sim))) / Math.PI;
    }

    /**
     * Computes distance according to specified metric.
     */
    static distance(a: number[], b: number[], metric: VectorDistanceMetric = 'cosine'): number {
        switch (metric) {
            case 'euclidean':
                return MetricMath.euclideanDistance(a, b);
            case 'angular':
                return MetricMath.angularDistance(a, b);
            case 'cosine':
            default:
                return MetricMath.cosineDistance(a, b);
        }
    }
}
