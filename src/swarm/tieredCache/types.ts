export interface SQ8Vector {
    readonly codes: Uint8Array;
    readonly min: number;
    readonly max: number;
    readonly dimension: number;
    readonly originalByteSize: number;
    readonly quantizedByteSize: number;
    readonly compressionRatio: number;
}

export interface BinaryVector {
    readonly bits: Uint8Array;
    readonly dimension: number;
    readonly originalByteSize: number;
    readonly quantizedByteSize: number;
    readonly compressionRatio: number;
}

export interface BaseStateSnapshot {
    readonly id: string;
    readonly timestamp: number;
    readonly state: Record<string, any>;
    readonly hash: string;
}

export interface StateDeltaSnapshot {
    readonly deltaId: string;
    readonly baseId: string;
    readonly deltaIndex: number;
    readonly timestamp: number;
    readonly added: Record<string, any>;
    readonly updated: Record<string, { from: any; to: any }>;
    readonly removed: string[];
}

export interface CompressedPayload {
    readonly dictionary: string[];
    readonly encodedTokens: number[];
    readonly originalByteSize: number;
    readonly compressedByteSize: number;
    readonly reductionPercent: number;
}

export interface TieredCacheConfig {
    l1MaxEntries?: number;          // Default: 100 (Hot LRU)
    l2MaxEntries?: number;          // Default: 500 (Warm Semantic)
    l2SimilarityThreshold?: number; // Default: 0.88
    l3MaxEntries?: number;          // Default: 1000 (Cold Snapshots)
    quantizationMode?: 'sq8' | 'binary'; // Default: 'sq8'
}

export interface TieredCacheMetrics {
    l1Entries: number;
    l2Entries: number;
    l3Entries: number;
    l1Hits: number;
    l2Hits: number;
    l3Hits: number;
    misses: number;
    promotions: number;
    demotions: number;
    totalLookups: number;
    overallHitRatio: number;
    savedTokens: number;
    memorySavedBytes: number;
}

export interface TieredLookupResult<T = any> {
    found: boolean;
    tier?: 'L1' | 'L2' | 'L3';
    value?: T;
    similarity?: number;
    key?: string;
    latencyMs: number;
}

export interface L1Item<T> {
    key: string;
    value: T;
    createdAt: number;
    lastAccessed: number;
}

export interface L2Item<T> {
    key: string;
    text: string;
    value: T;
    sq8Vector?: SQ8Vector;
    binaryVector?: BinaryVector;
    createdAt: number;
    lastAccessed: number;
}

export interface L3Item<T> {
    key: string;
    compressed: CompressedPayload;
    metadata?: Record<string, any>;
    createdAt: number;
}
