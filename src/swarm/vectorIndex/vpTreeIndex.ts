import type {
    VectorDistanceMetric,
    VectorIndexItem,
    VectorSearchResult,
    VectorSearchOptions,
    VectorIndexMetrics,
    VectorIndex,
    VpTreeConfig
} from './types.ts';
import { MetricMath } from './metricMath.ts';

interface VpTreeNode<T> {
    item: VectorIndexItem<T>;
    threshold: number; // Median distance partitioning left/right
    leftMin?: number;
    leftMax?: number;
    rightMin?: number;
    rightMax?: number;
    left?: VpTreeNode<T>;  // Inside vantage sphere: d(p, item) <= threshold
    right?: VpTreeNode<T>; // Outside vantage sphere: d(p, item) > threshold
}

/**
 * Vantage-Point Tree (VP-Tree) Vector Index.
 * Partitions metric space recursively around chosen vantage points.
 * Guarantees exact pruning via the triangle inequality with O(log n) search time.
 */
export class VpTreeIndex<T = any> implements VectorIndex<T> {
    private root?: VpTreeNode<T>;
    private itemsMap: Map<string, VectorIndexItem<T>> = new Map();
    private metric: VectorDistanceMetric;
    private rebuildThreshold: number;
    private unindexedCount: number = 0;
    private cachedDimension: number = 0;
    private lastSearchComparisons: number = 0;

    constructor(config?: VpTreeConfig) {
        this.metric = config?.metric ?? 'cosine';
        this.rebuildThreshold = config?.rebuildThreshold ?? 50;
    }

    get size(): number {
        return this.itemsMap.size;
    }

    get dimension(): number {
        return this.cachedDimension;
    }

    private computeDistance(a: number[], b: number[]): number {
        this.lastSearchComparisons++;
        return MetricMath.distance(a, b, this.metric);
    }

    private similarityFromDistance(distance: number): number {
        if (this.metric === 'cosine') {
            return Math.min(1.0, Math.max(0.0, 1.0 - distance));
        } else if (this.metric === 'angular') {
            return Math.min(1.0, Math.max(0.0, 1.0 - distance));
        } else {
            // Euclidean similarity normalization: 1 / (1 + distance)
            return Math.min(1.0, Math.max(0.0, 1.0 / (1.0 + distance)));
        }
    }

    private maxDistanceForSimilarity(minSimilarity: number): number {
        if (this.metric === 'cosine' || this.metric === 'angular') {
            return 1.0 - minSimilarity;
        } else {
            return (1.0 / minSimilarity) - 1.0;
        }
    }

    insert(id: string, vector: number[], data: T): void {
        if (!vector || vector.length === 0) return;
        if (this.cachedDimension === 0) {
            this.cachedDimension = vector.length;
        }

        const item: VectorIndexItem<T> = { id, vector, data };
        const exists = this.itemsMap.has(id);
        this.itemsMap.set(id, item);

        if (exists) {
            // Rebuild tree if updating existing node to maintain metric invariants
            this.rebuildTree();
            return;
        }

        if (!this.root) {
            this.root = { item, threshold: 0 };
            return;
        }

        // Incremental insertion into tree
        this.insertIntoNode(this.root, item);
        this.unindexedCount++;

        const maxUnindexed = Math.min(this.rebuildThreshold, Math.max(10, Math.floor(this.itemsMap.size * 0.25)));
        if (this.unindexedCount >= maxUnindexed) {
            this.rebuildTree();
        }
    }

    insertBatch(items: VectorIndexItem<T>[]): void {
        if (!items || items.length === 0) return;
        for (const it of items) {
            if (this.cachedDimension === 0 && it.vector?.length) {
                this.cachedDimension = it.vector.length;
            }
            this.itemsMap.set(it.id, it);
        }
        this.rebuildTree();
    }

    private insertIntoNode(node: VpTreeNode<T>, item: VectorIndexItem<T>): void {
        const d = this.computeDistance(item.vector, node.item.vector);

        if (!node.left && !node.right) {
            node.threshold = d;
            node.left = { item, threshold: 0 };
            node.leftMin = d;
            node.leftMax = d;
            return;
        }

        if (d <= node.threshold) {
            node.leftMin = node.leftMin !== undefined ? Math.min(node.leftMin, d) : d;
            node.leftMax = node.leftMax !== undefined ? Math.max(node.leftMax, d) : d;
            if (node.left) {
                this.insertIntoNode(node.left, item);
            } else {
                node.left = { item, threshold: 0 };
            }
        } else {
            node.rightMin = node.rightMin !== undefined ? Math.min(node.rightMin, d) : d;
            node.rightMax = node.rightMax !== undefined ? Math.max(node.rightMax, d) : d;
            if (node.right) {
                this.insertIntoNode(node.right, item);
            } else {
                node.right = { item, threshold: 0 };
            }
        }
    }

    delete(id: string): boolean {
        const removed = this.itemsMap.delete(id);
        if (removed) {
            this.rebuildTree();
        }
        return removed;
    }

    get(id: string): VectorIndexItem<T> | undefined {
        return this.itemsMap.get(id);
    }

    has(id: string): boolean {
        return this.itemsMap.has(id);
    }

    clear(): void {
        this.itemsMap.clear();
        this.root = undefined;
        this.unindexedCount = 0;
        this.cachedDimension = 0;
        this.lastSearchComparisons = 0;
    }

    /**
     * Completely rebalances the VP-Tree from all indexed items in O(N log N) time,
     * ensuring perfect log2(N) search depth and optimal vantage-point selection.
     */
    rebuildTree(): void {
        this.unindexedCount = 0;
        const allItems = Array.from(this.itemsMap.values());
        if (allItems.length === 0) {
            this.root = undefined;
            return;
        }
        this.root = this.buildSubtree(allItems);
    }

    private chooseVantagePoint(items: VectorIndexItem<T>[]): number {
        if (items.length <= 5) return 0;
        const sampleSize = Math.min(items.length, 5);
        const candidates: number[] = [];
        const step = Math.floor(items.length / sampleSize);
        for (let i = 0; i < sampleSize; i++) {
            candidates.push(i * step);
        }

        const testCount = Math.min(items.length, 20);
        const testStep = Math.max(1, Math.floor(items.length / testCount));
        let bestIndex = 0;
        let bestVariance = -1;

        for (const candIdx of candidates) {
            const cand = items[candIdx];
            let mean = 0;
            let M2 = 0;
            let count = 0;

            for (let j = 0; j < testCount; j++) {
                const targetIdx = j * testStep;
                if (targetIdx >= items.length || targetIdx === candIdx) continue;
                const d = MetricMath.distance(cand.vector, items[targetIdx].vector, this.metric);
                count++;
                const delta = d - mean;
                mean += delta / count;
                const delta2 = d - mean;
                M2 += delta * delta2;
            }

            if (count > 1) {
                const variance = M2 / (count - 1); // Sample variance
                if (variance > bestVariance) {
                    bestVariance = variance;
                    bestIndex = candIdx;
                }
            }
        }

        return bestIndex;
    }

    private buildSubtree(items: VectorIndexItem<T>[]): VpTreeNode<T> | undefined {
        if (items.length === 0) return undefined;
        if (items.length === 1) {
            return { item: items[0], threshold: 0 };
        }

        // Vantage point selection: pick vantage point with maximal distance variance
        const vantageIdx = this.chooseVantagePoint(items);
        const vantage = items[vantageIdx];
        const rest = items.filter((_, idx) => idx !== vantageIdx);

        // Compute distance from vantage point to all items
        const distances = rest.map(it => ({
            item: it,
            dist: MetricMath.distance(vantage.vector, it.vector, this.metric)
        }));

        // Sort distances to find median threshold
        distances.sort((a, b) => a.dist - b.dist);
        const mid = Math.floor(distances.length / 2);
        const threshold = distances[mid].dist;

        const leftItems: VectorIndexItem<T>[] = [];
        const rightItems: VectorIndexItem<T>[] = [];
        let leftMin = Infinity;
        let leftMax = -Infinity;
        let rightMin = Infinity;
        let rightMax = -Infinity;

        for (let i = 0; i < distances.length; i++) {
            const it = distances[i].item;
            const dist = distances[i].dist;
            if (i < mid) {
                leftItems.push(it);
                if (dist < leftMin) leftMin = dist;
                if (dist > leftMax) leftMax = dist;
            } else {
                rightItems.push(it);
                if (dist < rightMin) rightMin = dist;
                if (dist > rightMax) rightMax = dist;
            }
        }

        return {
            item: vantage,
            threshold,
            leftMin: leftItems.length > 0 ? leftMin : undefined,
            leftMax: leftItems.length > 0 ? leftMax : undefined,
            rightMin: rightItems.length > 0 ? rightMin : undefined,
            rightMax: rightItems.length > 0 ? rightMax : undefined,
            left: this.buildSubtree(leftItems),
            right: this.buildSubtree(rightItems)
        };
    }

    /**
     * Searches for k-nearest neighbors in O(log n) time using triangle inequality pruning.
     */
    search(queryVector: number[], options?: VectorSearchOptions<T>): VectorSearchResult<T>[] {
        this.lastSearchComparisons = 0;
        if (!this.root || !queryVector || queryVector.length === 0) return [];

        const k = Math.max(1, options?.k ?? 5);
        let maxDistance = options?.maxDistance ?? Infinity;

        if (options?.minSimilarity !== undefined) {
            const distFromSim = this.maxDistanceForSimilarity(options.minSimilarity);
            maxDistance = Math.min(maxDistance, distFromSim);
        }

        const results: { item: VectorIndexItem<T>; distance: number }[] = [];

        // Helper to push candidate into bounded priority queue
        const pushCandidate = (item: VectorIndexItem<T>, dist: number) => {
            if (options?.filter && !options.filter(item)) {
                return;
            }
            if (dist > maxDistance) return;

            // Binary search to find insertion index
            let low = 0;
            let high = results.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (results[mid].distance > dist) {
                    high = mid;
                } else {
                    low = mid + 1;
                }
            }
            results.splice(low, 0, { item, distance: dist });

            if (results.length > k) {
                results.pop();
            }

            // Tighten search radius if priority queue is full
            if (results.length === k) {
                maxDistance = Math.min(maxDistance, results[results.length - 1].distance);
            }
        };

        // Recursive search with metric pruning
        const searchNode = (node: VpTreeNode<T> | undefined) => {
            if (!node) return;

            const d = this.computeDistance(queryVector, node.item.vector);
            if (d <= maxDistance) {
                pushCandidate(node.item, d);
            }

            // Lower bounds on distance from queryVector to any point in each branch
            let leftBound = Infinity;
            if (node.left) {
                const minR = node.leftMin ?? 0;
                const maxR = node.leftMax ?? node.threshold;
                leftBound = Math.max(0, minR - d, d - maxR);
            }

            let rightBound = Infinity;
            if (node.right) {
                const minR = node.rightMin ?? node.threshold;
                const maxR = node.rightMax ?? Infinity;
                rightBound = Math.max(0, minR - d, d - maxR);
            }

            // Greedy exploration: traverse the branch with lower minimum distance first
            if (leftBound <= rightBound) {
                if (leftBound <= maxDistance) {
                    searchNode(node.left);
                }
                if (rightBound <= maxDistance) {
                    searchNode(node.right);
                }
            } else {
                if (rightBound <= maxDistance) {
                    searchNode(node.right);
                }
                if (leftBound <= maxDistance) {
                    searchNode(node.left);
                }
            }
        };

        searchNode(this.root);

        return results.map(r => ({
            id: r.item.id,
            distance: Math.round(r.distance * 10000) / 10000,
            similarity: Math.round(this.similarityFromDistance(r.distance) * 10000) / 10000,
            data: r.item.data,
            vector: options?.includeVector ? r.item.vector : undefined
        }));
    }

    /**
     * Finds all points within a maximum distance radius (useful for deduplication).
     */
    findWithinRadius(
        queryVector: number[],
        maxDistance: number,
        filter?: (item: VectorIndexItem<T>) => boolean
    ): VectorSearchResult<T>[] {
        return this.search(queryVector, {
            k: this.itemsMap.size,
            maxDistance,
            filter
        });
    }

    /**
     * Finds the single most similar item above an optional similarity threshold.
     */
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

    private computeTreeDepth(node?: VpTreeNode<T>): number {
        if (!node) return 0;
        return 1 + Math.max(this.computeTreeDepth(node.left), this.computeTreeDepth(node.right));
    }

    getMetrics(): VectorIndexMetrics {
        return {
            type: 'vptree',
            size: this.itemsMap.size,
            dimension: this.cachedDimension,
            depth: this.computeTreeDepth(this.root),
            lastSearchComparisons: this.lastSearchComparisons,
            timeComplexity: 'O(log n)'
        };
    }

    serialize(): any {
        return {
            type: 'vptree',
            metric: this.metric,
            items: Array.from(this.itemsMap.values())
        };
    }

    deserialize(data: any): void {
        this.clear();
        if (data?.metric) this.metric = data.metric;
        if (Array.isArray(data?.items)) {
            this.insertBatch(data.items);
        }
    }
}
