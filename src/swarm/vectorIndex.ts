/**
 * Vector Indexing Engine for The Perfect Swarm
 * 
 * Provides sub-linear O(log n) vector nearest-neighbor retrieval, radius-threshold
 * deduplication, and metric space pruning to replace linear O(n) array scans in Memory Cortex.
 */

export type VectorDistanceMetric = 'cosine' | 'euclidean' | 'angular';

export interface VectorIndexItem<T = any> {
    id: string;
    vector: number[];
    data: T;
}

export interface VectorSearchResult<T = any> {
    id: string;
    similarity: number;   // 0.0 to 1.0 (cosine similarity)
    distance: number;     // metric distance
    data: T;
    vector?: number[];
}

export interface VectorSearchOptions<T = any> {
    k?: number;                      // Max items to return (default 5)
    minSimilarity?: number;          // Minimum cosine similarity threshold [0.0, 1.0]
    maxDistance?: number;            // Maximum metric distance threshold
    filter?: (item: VectorIndexItem<T>) => boolean; // Metadata / tenant filter predicate
    includeVector?: boolean;
}

export interface VectorIndexMetrics {
    type: 'vptree' | 'hnsw' | 'linear';
    size: number;
    dimension: number;
    depth: number;
    lastSearchComparisons: number;
    timeComplexity: 'O(log n)' | 'O(n)';
}

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

/**
 * Standard Vector Index interface for sub-linear memory indexing.
 */
export interface VectorIndex<T = any> {
    readonly size: number;
    readonly dimension: number;

    insert(id: string, vector: number[], data: T): void;
    insertBatch(items: VectorIndexItem<T>[]): void;
    delete(id: string): boolean;
    get(id: string): VectorIndexItem<T> | undefined;
    has(id: string): boolean;
    clear(): void;

    search(queryVector: number[], options?: VectorSearchOptions<T>): VectorSearchResult<T>[];
    findWithinRadius(queryVector: number[], maxDistance: number, filter?: (item: VectorIndexItem<T>) => boolean): VectorSearchResult<T>[];
    findMostSimilar(queryVector: number[], threshold?: number, filter?: (item: VectorIndexItem<T>) => boolean): VectorSearchResult<T> | null;

    getMetrics(): VectorIndexMetrics;
    serialize(): any;
    deserialize(data: any): void;
}

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

export interface VpTreeConfig {
    metric?: VectorDistanceMetric; // default: 'cosine'
    rebuildThreshold?: number;     // items added before full rebalance (default: 50)
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
            let sum = 0;
            let sumSq = 0;
            let count = 0;

            for (let j = 0; j < testCount; j++) {
                const targetIdx = j * testStep;
                if (targetIdx >= items.length || targetIdx === candIdx) continue;
                const d = MetricMath.distance(cand.vector, items[targetIdx].vector, this.metric);
                sum += d;
                sumSq += d * d;
                count++;
            }

            if (count > 1) {
                const mean = sum / count;
                const variance = (sumSq / count) - (mean * mean);
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

export interface HnswConfig {
    metric?: VectorDistanceMetric; // default: 'cosine'
    m?: number;                    // Max outgoing connections per node (default: 16)
    efConstruction?: number;       // Construction search width (default: 64)
    efSearch?: number;             // Query search width (default: 32)
    mL?: number;                   // Level generation factor: 1 / ln(M)
}

interface HnswNode<T> {
    id: string;
    item: VectorIndexItem<T>;
    level: number;
    neighbors: Map<number, string[]>; // level -> neighbor node IDs
}

/**
 * Hierarchical Navigable Small World (HNSW) Vector Index.
 * Multi-layer proximity graph supporting sub-linear O(log n) approximate nearest neighbor
 * routing with high recall and logarithmic greedy traversal.
 */
export class HnswVectorIndex<T = any> implements VectorIndex<T> {
    private nodes: Map<string, HnswNode<T>> = new Map();
    private entryPointId?: string;
    private maxLevel: number = 0;
    private metric: VectorDistanceMetric;
    private m: number;
    private efConstruction: number;
    private efSearch: number;
    private mL: number;
    private cachedDimension: number = 0;
    private lastSearchComparisons: number = 0;

    constructor(config?: HnswConfig) {
        this.metric = config?.metric ?? 'cosine';
        this.m = config?.m ?? 16;
        this.efConstruction = config?.efConstruction ?? 64;
        this.efSearch = config?.efSearch ?? 32;
        this.mL = config?.mL ?? (1 / Math.log(this.m));
    }

    get size(): number {
        return this.nodes.size;
    }

    get dimension(): number {
        return this.cachedDimension;
    }

    private computeDistance(a: number[], b: number[]): number {
        this.lastSearchComparisons++;
        return MetricMath.distance(a, b, this.metric);
    }

    private similarityFromDistance(distance: number): number {
        if (this.metric === 'cosine' || this.metric === 'angular') {
            return Math.min(1.0, Math.max(0.0, 1.0 - distance));
        } else {
            return Math.min(1.0, Math.max(0.0, 1.0 / (1.0 + distance)));
        }
    }

    private randomLevel(): number {
        let r = Math.random();
        if (r === 0) r = 0.0001;
        return Math.floor(-Math.log(r) * this.mL);
    }

    insert(id: string, vector: number[], data: T): void {
        if (!vector || vector.length === 0) return;
        if (this.cachedDimension === 0) {
            this.cachedDimension = vector.length;
        }

        const item: VectorIndexItem<T> = { id, vector, data };
        if (this.nodes.has(id)) {
            this.delete(id);
        }

        const nodeLevel = this.randomLevel();
        const newNode: HnswNode<T> = {
            id,
            item,
            level: nodeLevel,
            neighbors: new Map()
        };
        for (let l = 0; l <= nodeLevel; l++) {
            newNode.neighbors.set(l, []);
        }

        this.nodes.set(id, newNode);

        if (!this.entryPointId) {
            this.entryPointId = id;
            this.maxLevel = nodeLevel;
            return;
        }

        let currObjId = this.entryPointId;
        let currDist = this.computeDistance(vector, this.nodes.get(currObjId)!.item.vector);

        // 1. Traverse greedy routing from top level down to nodeLevel + 1
        for (let level = this.maxLevel; level > nodeLevel; level--) {
            let changed = true;
            while (changed) {
                changed = false;
                const currNode = this.nodes.get(currObjId)!;
                const neighbors = currNode.neighbors.get(level) || [];

                for (const neighborId of neighbors) {
                    const neighbor = this.nodes.get(neighborId);
                    if (!neighbor) continue;
                    const d = this.computeDistance(vector, neighbor.item.vector);
                    if (d < currDist) {
                        currDist = d;
                        currObjId = neighborId;
                        changed = true;
                    }
                }
            }
        }

        // 2. From nodeLevel down to 0, connect neighbors
        for (let level = Math.min(this.maxLevel, nodeLevel); level >= 0; level--) {
            const candidates = this.searchLayer(vector, currObjId, this.efConstruction, level);
            const mMax = level === 0 ? this.m * 2 : this.m;
            const selectedNeighbors = candidates.slice(0, mMax).map(c => c.id);

            newNode.neighbors.set(level, selectedNeighbors);

            for (const neighborId of selectedNeighbors) {
                const neighbor = this.nodes.get(neighborId);
                if (!neighbor) continue;
                let nNeighbors = neighbor.neighbors.get(level);
                if (!nNeighbors) {
                    nNeighbors = [];
                    neighbor.neighbors.set(level, nNeighbors);
                }
                if (!nNeighbors.includes(id)) {
                    nNeighbors.push(id);
                    if (nNeighbors.length > mMax) {
                        // Shrink to closest mMax
                        nNeighbors.sort((a, b) => {
                            const nodeA = this.nodes.get(a);
                            const nodeB = this.nodes.get(b);
                            if (!nodeA || !nodeB) return 0;
                            return this.computeDistance(neighbor.item.vector, nodeA.item.vector) -
                                   this.computeDistance(neighbor.item.vector, nodeB.item.vector);
                        });
                        nNeighbors.length = mMax;
                    }
                }
            }

            if (candidates.length > 0) {
                currObjId = candidates[0].id;
            }
        }

        if (nodeLevel > this.maxLevel) {
            this.maxLevel = nodeLevel;
            this.entryPointId = id;
        }
    }

    private searchLayer(
        query: number[],
        enterId: string,
        ef: number,
        level: number
    ): { id: string; dist: number }[] {
        const vVisited = new Set<string>([enterId]);
        const enterNode = this.nodes.get(enterId)!;
        const enterDist = this.computeDistance(query, enterNode.item.vector);

        const candidates: { id: string; dist: number }[] = [{ id: enterId, dist: enterDist }];
        const nearest: { id: string; dist: number }[] = [{ id: enterId, dist: enterDist }];

        while (candidates.length > 0) {
            candidates.sort((a, b) => a.dist - b.dist);
            const curr = candidates.shift()!;

            const furthestNearest = nearest[nearest.length - 1];
            if (curr.dist > furthestNearest.dist && nearest.length >= ef) {
                break;
            }

            const currNode = this.nodes.get(curr.id);
            if (!currNode) continue;
            const neighbors = currNode.neighbors.get(level) || [];

            for (const nId of neighbors) {
                if (vVisited.has(nId)) continue;
                vVisited.add(nId);

                const neighborNode = this.nodes.get(nId);
                if (!neighborNode) continue;

                const d = this.computeDistance(query, neighborNode.item.vector);
                if (d < furthestNearest.dist || nearest.length < ef) {
                    candidates.push({ id: nId, dist: d });
                    nearest.push({ id: nId, dist: d });
                    nearest.sort((a, b) => a.dist - b.dist);
                    if (nearest.length > ef) {
                        nearest.pop();
                    }
                }
            }
        }

        return nearest;
    }

    insertBatch(items: VectorIndexItem<T>[]): void {
        for (const item of items) {
            this.insert(item.id, item.vector, item.data);
        }
    }

    delete(id: string): boolean {
        const target = this.nodes.get(id);
        if (!target) return false;

        // Remove connections from all neighbors
        for (const [level, neighbors] of target.neighbors.entries()) {
            for (const nId of neighbors) {
                const neighbor = this.nodes.get(nId);
                if (!neighbor) continue;
                const nList = neighbor.neighbors.get(level);
                if (nList) {
                    const idx = nList.indexOf(id);
                    if (idx >= 0) nList.splice(idx, 1);
                }
            }
        }

        this.nodes.delete(id);

        if (this.entryPointId === id) {
            const nextEntry = this.nodes.keys().next();
            this.entryPointId = nextEntry.done ? undefined : nextEntry.value;
            if (this.entryPointId) {
                this.maxLevel = this.nodes.get(this.entryPointId)?.level ?? 0;
            } else {
                this.maxLevel = 0;
            }
        }

        return true;
    }

    get(id: string): VectorIndexItem<T> | undefined {
        return this.nodes.get(id)?.item;
    }

    has(id: string): boolean {
        return this.nodes.has(id);
    }

    clear(): void {
        this.nodes.clear();
        this.entryPointId = undefined;
        this.maxLevel = 0;
        this.cachedDimension = 0;
        this.lastSearchComparisons = 0;
    }

    search(queryVector: number[], options?: VectorSearchOptions<T>): VectorSearchResult<T>[] {
        this.lastSearchComparisons = 0;
        if (!this.entryPointId || !queryVector || queryVector.length === 0) return [];

        const k = Math.max(1, options?.k ?? 5);
        let currObjId = this.entryPointId;
        let currDist = this.computeDistance(queryVector, this.nodes.get(currObjId)!.item.vector);

        // 1. Greedy routing down to layer 1
        for (let level = this.maxLevel; level > 0; level--) {
            let changed = true;
            while (changed) {
                changed = false;
                const currNode = this.nodes.get(currObjId)!;
                const neighbors = currNode.neighbors.get(level) || [];

                for (const nId of neighbors) {
                    const neighbor = this.nodes.get(nId);
                    if (!neighbor) continue;
                    const d = this.computeDistance(queryVector, neighbor.item.vector);
                    if (d < currDist) {
                        currDist = d;
                        currObjId = nId;
                        changed = true;
                    }
                }
            }
        }

        // 2. Beam search at layer 0
        const ef = Math.max(k, this.efSearch);
        const candidates = this.searchLayer(queryVector, currObjId, ef, 0);

        let filtered = candidates;
        if (options?.filter) {
            filtered = candidates.filter(c => {
                const node = this.nodes.get(c.id);
                return node ? options.filter!(node.item) : false;
            });
        }

        if (options?.maxDistance !== undefined) {
            filtered = filtered.filter(c => c.dist <= options.maxDistance!);
        }

        if (options?.minSimilarity !== undefined) {
            filtered = filtered.filter(c => this.similarityFromDistance(c.dist) >= options.minSimilarity!);
        }

        return filtered.slice(0, k).map(c => {
            const node = this.nodes.get(c.id)!;
            return {
                id: c.id,
                distance: Math.round(c.dist * 10000) / 10000,
                similarity: Math.round(this.similarityFromDistance(c.dist) * 10000) / 10000,
                data: node.item.data,
                vector: options?.includeVector ? node.item.vector : undefined
            };
        });
    }

    findWithinRadius(
        queryVector: number[],
        maxDistance: number,
        filter?: (item: VectorIndexItem<T>) => boolean
    ): VectorSearchResult<T>[] {
        return this.search(queryVector, {
            k: this.nodes.size,
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

    getMetrics(): VectorIndexMetrics {
        return {
            type: 'hnsw',
            size: this.nodes.size,
            dimension: this.cachedDimension,
            depth: this.maxLevel,
            lastSearchComparisons: this.lastSearchComparisons,
            timeComplexity: 'O(log n)'
        };
    }

    serialize(): any {
        return {
            type: 'hnsw',
            metric: this.metric,
            items: Array.from(this.nodes.values()).map(n => n.item)
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

/**
 * Factory helper to construct the appropriate vector index.
 */
export function createVectorIndex<T = any>(
    type: 'vptree' | 'hnsw' = 'vptree',
    config?: VpTreeConfig | HnswConfig
): VectorIndex<T> {
    if (type === 'hnsw') {
        return new HnswVectorIndex<T>(config as HnswConfig);
    }
    return new VpTreeIndex<T>(config as VpTreeConfig);
}
