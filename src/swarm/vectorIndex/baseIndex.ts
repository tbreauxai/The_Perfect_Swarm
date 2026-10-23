import type {
    VectorIndex,
    VectorIndexItem,
    VectorSearchResult,
    VectorSearchOptions,
    VectorIndexMetrics,
    VectorDistanceMetric
} from './types.ts';
import { MetricMath } from './metricMath.ts';

/**
 * Abstract Base Vector Index implementing shared lifecycle, batching, radius filtering,
 * distance comparisons, and serialization workflows for sub-linear vector indexes.
 */
export abstract class BaseVectorIndex<T = any> implements VectorIndex<T> {
    public metric: VectorDistanceMetric;
    protected cachedDimension: number = 0;
    protected lastSearchComparisons: number = 0;

    constructor(metric: VectorDistanceMetric = 'cosine') {
        this.metric = metric;
    }

    abstract readonly size: number;

    get dimension(): number {
        return this.cachedDimension;
    }

    abstract insert(id: string, vector: number[], data: T): void;
    abstract delete(id: string): boolean;
    abstract get(id: string): VectorIndexItem<T> | undefined;
    abstract has(id: string): boolean;
    abstract clear(): void;
    abstract search(queryVector: number[], options?: VectorSearchOptions<T>): VectorSearchResult<T>[];
    abstract getMetrics(): VectorIndexMetrics;
    abstract serialize(): any;

    insertBatch(items: VectorIndexItem<T>[]): void {
        for (const item of items) {
            this.insert(item.id, item.vector, item.data);
        }
    }

    findWithinRadius(
        queryVector: number[],
        maxDistance: number,
        filter?: (item: VectorIndexItem<T>) => boolean
    ): VectorSearchResult<T>[] {
        return this.search(queryVector, {
            k: this.size,
            maxDistance,
            filter
        });
    }

    findMostSimilar(
        queryVector: number[],
        threshold: number = 0.0,
        filter?: (item: VectorIndexItem<T>) => boolean
    ): VectorSearchResult<T> | null {
        const res = this.search(queryVector, {
            k: 1,
            minSimilarity: threshold,
            filter
        });
        return res.length > 0 ? res[0] : null;
    }

    protected similarityFromDistance(distance: number): number {
        if (this.metric === 'cosine' || this.metric === 'angular') {
            return Math.min(1.0, Math.max(0.0, 1.0 - distance));
        } else {
            return Math.min(1.0, Math.max(0.0, 1.0 / (1.0 + distance)));
        }
    }

    protected computeDistance(a: number[], b: number[]): number {
        this.lastSearchComparisons++;
        return MetricMath.distance(a, b, this.metric);
    }

    deserialize(data: any): void {
        this.clear();
        if (data?.metric) this.metric = data.metric;
        if (Array.isArray(data?.items)) {
            this.insertBatch(data.items);
        }
    }
}
