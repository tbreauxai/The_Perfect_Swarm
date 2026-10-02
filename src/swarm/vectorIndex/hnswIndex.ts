import type {
    VectorDistanceMetric,
    VectorIndexItem,
    VectorSearchResult,
    VectorSearchOptions,
    VectorIndexMetrics,
    VectorIndex,
    HnswConfig
} from './types.ts';
import { MetricMath } from './metricMath.ts';

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
