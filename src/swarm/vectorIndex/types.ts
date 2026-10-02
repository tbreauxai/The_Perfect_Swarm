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

export interface VpTreeConfig {
    metric?: VectorDistanceMetric; // default: 'cosine'
    rebuildThreshold?: number;     // items added before full rebalance (default: 50)
}

export interface HnswConfig {
    metric?: VectorDistanceMetric; // default: 'cosine'
    m?: number;                    // Max outgoing connections per node (default: 16)
    efConstruction?: number;       // Construction search width (default: 64)
    efSearch?: number;             // Query search width (default: 32)
    mL?: number;                   // Level generation factor: 1 / ln(M)
}
