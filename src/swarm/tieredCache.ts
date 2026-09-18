/**
 * Tiered Caching & State-Compression Engine.
 * 
 * Provides:
 * 1. Multi-Tier Cache Hierarchy (L1 Hot LRU, L2 Warm Semantic, L3 Cold Snapshot Persistence).
 * 2. Vector Quantization (Scalar Quantization SQ8, Binary 1-bit sign quantization, Asymmetric Distance Computation).
 * 3. Selective State Snapshotting (delta-state serialization, dictionary state compression, hydration).
 * 
 * Pure TypeScript, zero external runtime dependencies.
 */

// ============================================================================
// 1. Vector Quantization Types and Implementation
// ============================================================================

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

/**
 * High-performance vector quantizer reducing embedding footprints by 4x to 32x.
 */
export class VectorQuantizer {
    /**
     * Generates a deterministic unit-normalized float embedding vector from text.
     * Uses deterministic rolling hash n-grams with L2 normalization.
     */
    static generateEmbedding(text: string, dimension: number = 64): Float32Array {
        const vec = new Float32Array(dimension);
        const raw = typeof text === 'string' ? text : (text ? JSON.stringify(text) : '');
        const normalized = raw.toLowerCase().trim();
        if (!normalized) return vec;

        const words = normalized.split(/\s+/);
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            let h = 0x811c9dc5;
            for (let j = 0; j < word.length; j++) {
                h ^= word.charCodeAt(j);
                h = Math.imul(h, 0x01000193);
            }
            vec[Math.abs(h) % dimension] += 2.0;

            // Character n-grams (3-char and 4-char shingles)
            for (let n = 3; n <= 4; n++) {
                if (word.length >= n) {
                    for (let k = 0; k <= word.length - n; k++) {
                        const shingle = word.slice(k, k + n);
                        let hs = 0x811c9dc5;
                        for (let c = 0; c < shingle.length; c++) {
                            hs ^= shingle.charCodeAt(c);
                            hs = Math.imul(hs, 0x01000193);
                        }
                        vec[Math.abs(hs) % dimension] += 1.0;
                    }
                }
            }

            // Word bigram hashing
            if (i < words.length - 1) {
                const bi = word + '_' + words[i + 1];
                let h2 = 0x811c9dc5;
                for (let k = 0; k < bi.length; k++) {
                    h2 ^= bi.charCodeAt(k);
                    h2 = Math.imul(h2, 0x01000193);
                }
                vec[Math.abs(h2) % dimension] += 1.5;
            }
        }

        // Mean-centering for balanced zero-mean distribution
        let mean = 0;
        for (let i = 0; i < dimension; i++) {
            mean += vec[i];
        }
        mean /= dimension;
        for (let i = 0; i < dimension; i++) {
            vec[i] -= mean;
        }

        // L2 Unit Normalization
        let sumSq = 0;
        for (let i = 0; i < dimension; i++) {
            sumSq += vec[i] * vec[i];
        }
        if (sumSq > 0) {
            const norm = Math.sqrt(sumSq);
            for (let i = 0; i < dimension; i++) {
                vec[i] /= norm;
            }
        }

        return vec;
    }

    /**
     * Scalar Quantization (SQ8): Quantizes Float32Array (4 bytes/dim) into Uint8Array (1 byte/dim).
     * 75% memory footprint reduction (4x compression).
     */
    static quantizeSQ8(vector: Float32Array | number[]): SQ8Vector {
        const dim = vector.length;
        if (dim === 0) {
            return {
                codes: new Uint8Array(0),
                min: 0,
                max: 0,
                dimension: 0,
                originalByteSize: 0,
                quantizedByteSize: 0,
                compressionRatio: 1.0
            };
        }

        let min = vector[0];
        let max = vector[0];
        for (let i = 1; i < dim; i++) {
            if (vector[i] < min) min = vector[i];
            if (vector[i] > max) max = vector[i];
        }

        const codes = new Uint8Array(dim);
        const range = max - min;

        if (range === 0) {
            codes.fill(128);
        } else {
            const invRange = 255 / range;
            for (let i = 0; i < dim; i++) {
                const val = Math.round((vector[i] - min) * invRange);
                codes[i] = Math.max(0, Math.min(255, val));
            }
        }

        const originalByteSize = dim * 4;
        const quantizedByteSize = dim + 8; // Uint8Array + 2x float32 bounds
        const compressionRatio = originalByteSize / quantizedByteSize;

        return {
            codes,
            min,
            max,
            dimension: dim,
            originalByteSize,
            quantizedByteSize,
            compressionRatio: Math.round(compressionRatio * 100) / 100
        };
    }

    /**
     * Dequantizes SQ8 codes back to Float32Array.
     */
    static dequantizeSQ8(sq8: SQ8Vector): Float32Array {
        const result = new Float32Array(sq8.dimension);
        const range = sq8.max - sq8.min;
        if (range === 0) {
            result.fill(sq8.min);
            return result;
        }

        const scale = range / 255;
        for (let i = 0; i < sq8.dimension; i++) {
            result[i] = sq8.min + (sq8.codes[i] * scale);
        }
        return result;
    }

    /**
     * Asymmetric Distance Computation (ADC): Computes cosine similarity between an unquantized
     * query vector and a quantized SQ8 vector without creating dequantized array allocations.
     */
    static asymmetricCosineSimilarity(query: Float32Array | number[], target: SQ8Vector): number {
        const dim = target.dimension;
        if (dim === 0 || query.length !== dim) return 0;

        const range = target.max - target.min;
        const scale = range === 0 ? 0 : range / 255;
        const minVal = target.min;

        let dot = 0;
        let queryNormSq = 0;
        let targetNormSq = 0;

        for (let i = 0; i < dim; i++) {
            const q = query[i];
            const t = minVal + (target.codes[i] * scale);
            dot += q * t;
            queryNormSq += q * q;
            targetNormSq += t * t;
        }

        if (queryNormSq === 0 || targetNormSq === 0) return 0;
        const sim = dot / (Math.sqrt(queryNormSq) * Math.sqrt(targetNormSq));
        return Math.max(-1.0, Math.min(1.0, Math.round(sim * 10000) / 10000));
    }

    /**
     * Binary 1-Bit Sign Quantization: Packs vector dimensions into bits (dim >= 0 -> 1, else 0).
     * 32x memory compression for fast Hamming proximity searches.
     */
    static quantizeBinary(vector: Float32Array | number[]): BinaryVector {
        const dim = vector.length;
        const byteLen = Math.ceil(dim / 8);
        const bits = new Uint8Array(byteLen);

        for (let i = 0; i < dim; i++) {
            if (vector[i] >= 0) {
                const byteIdx = i >> 3;
                const bitIdx = i & 7;
                bits[byteIdx] |= (1 << bitIdx);
            }
        }

        const originalByteSize = dim * 4;
        const quantizedByteSize = byteLen;
        const compressionRatio = originalByteSize / quantizedByteSize;

        return {
            bits,
            dimension: dim,
            originalByteSize,
            quantizedByteSize,
            compressionRatio: Math.round(compressionRatio * 100) / 100
        };
    }

    /**
     * Computes bitwise Hamming distance between two binary vectors using Kernighan popcount.
     */
    static hammingDistance(a: BinaryVector, b: BinaryVector): number {
        const len = Math.min(a.bits.length, b.bits.length);
        let dist = 0;
        for (let i = 0; i < len; i++) {
            let xor = a.bits[i] ^ b.bits[i];
            // Count set bits
            while (xor > 0) {
                dist += xor & 1;
                xor >>= 1;
            }
        }
        return dist;
    }

    /**
     * Approximates cosine similarity from Hamming distance:
     * CosineSimilarity ~ cos(pi * (hammingDistance / dimension))
     */
    static binaryCosineSimilarity(a: BinaryVector, b: BinaryVector): number {
        const dim = Math.max(1, Math.min(a.dimension, b.dimension));
        const dist = this.hammingDistance(a, b);
        const sim = Math.cos((Math.PI * dist) / dim);
        return Math.max(-1.0, Math.min(1.0, Math.round(sim * 10000) / 10000));
    }
}

// ============================================================================
// 2. Selective Snapshotting & State Compression
// ============================================================================

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

/**
 * Selective snapshotter that tracks only delta mutations rather than duplicating full state trees.
 */
export class SelectiveSnapshotter {
    /**
     * Generates a deterministic hash for state verification.
     */
    static hashState(obj: any): string {
        const str = JSON.stringify(obj, Object.keys(obj || {}).sort());
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * Creates a full baseline snapshot.
     */
    static createBaseSnapshot(id: string, state: Record<string, any>): BaseStateSnapshot {
        const cloned = JSON.parse(JSON.stringify(state));
        return {
            id,
            timestamp: Date.now(),
            state: cloned,
            hash: this.hashState(cloned)
        };
    }

    /**
     * Creates a delta snapshot representing changes between previous state and current state.
     */
    static createDeltaSnapshot(
        base: BaseStateSnapshot,
        previousState: Record<string, any>,
        currentState: Record<string, any>,
        deltaIndex: number
    ): StateDeltaSnapshot {
        const added: Record<string, any> = {};
        const updated: Record<string, { from: any; to: any }> = {};
        const removed: string[] = [];

        const prevKeys = new Set(Object.keys(previousState));
        const currKeys = new Set(Object.keys(currentState));

        // Detect Added and Updated
        for (const k of currKeys) {
            if (!prevKeys.has(k)) {
                added[k] = JSON.parse(JSON.stringify(currentState[k]));
            } else {
                const prevVal = JSON.stringify(previousState[k]);
                const currVal = JSON.stringify(currentState[k]);
                if (prevVal !== currVal) {
                    updated[k] = {
                        from: JSON.parse(prevVal),
                        to: JSON.parse(currVal)
                    };
                }
            }
        }

        // Detect Removed
        for (const k of prevKeys) {
            if (!currKeys.has(k)) {
                removed.push(k);
            }
        }

        return {
            deltaId: `${base.id}-delta-${deltaIndex}`,
            baseId: base.id,
            deltaIndex,
            timestamp: Date.now(),
            added,
            updated,
            removed
        };
    }

    /**
     * Hydrates and reconstructs state from a base snapshot and an ordered sequence of deltas.
     */
    static hydrateState(base: BaseStateSnapshot, deltas: StateDeltaSnapshot[]): Record<string, any> {
        const state = JSON.parse(JSON.stringify(base.state));
        // Sort deltas sequentially
        const sorted = [...deltas].sort((a, b) => a.deltaIndex - b.deltaIndex);

        for (const delta of sorted) {
            if (delta.baseId !== base.id) continue;

            // Apply additions
            for (const [k, val] of Object.entries(delta.added)) {
                state[k] = JSON.parse(JSON.stringify(val));
            }

            // Apply updates
            for (const [k, mutation] of Object.entries(delta.updated)) {
                state[k] = JSON.parse(JSON.stringify(mutation.to));
            }

            // Apply removals
            for (const k of delta.removed) {
                delete state[k];
            }
        }

        return state;
    }

    /**
     * Compresses state strings or payloads using token dictionary deduplication.
     */
    static compressPayload(payload: string): CompressedPayload {
        const originalByteSize = payload.length;
        const tokens = payload.split(/(\s+|[{},:[\]"'])/).filter(t => t.length > 0);

        const dictMap = new Map<string, number>();
        const dictionary: string[] = [];
        const encodedTokens: number[] = [];

        for (const token of tokens) {
            let id = dictMap.get(token);
            if (id === undefined) {
                id = dictionary.length;
                dictMap.set(token, id);
                dictionary.push(token);
            }
            encodedTokens.push(id);
        }

        const dictBytes = dictionary.reduce((acc, str) => acc + str.length, 0);
        const encodedBytes = encodedTokens.length * 2; // Int16 representation
        const compressedByteSize = dictBytes + encodedBytes;
        const reductionPercent = originalByteSize > 0
            ? Math.max(0, Math.round(((originalByteSize - compressedByteSize) / originalByteSize) * 100))
            : 0;

        return {
            dictionary,
            encodedTokens,
            originalByteSize,
            compressedByteSize,
            reductionPercent
        };
    }

    /**
     * Decompresses dictionary-encoded payloads back to original string.
     */
    static decompressPayload(compressed: CompressedPayload): string {
        return compressed.encodedTokens.map(id => compressed.dictionary[id] || '').join('');
    }
}

// ============================================================================
// 3. Multi-Tier Cache Hierarchy (L1 / L2 / L3)
// ============================================================================

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

interface L1Item<T> {
    key: string;
    value: T;
    createdAt: number;
    lastAccessed: number;
}

interface L2Item<T> {
    key: string;
    text: string;
    value: T;
    sq8Vector?: SQ8Vector;
    binaryVector?: BinaryVector;
    createdAt: number;
    lastAccessed: number;
}

interface L3Item<T> {
    key: string;
    compressed: CompressedPayload;
    metadata?: Record<string, any>;
    createdAt: number;
}

/**
 * Multi-tier intelligent cache hierarchy:
 * - L1: In-memory Hot LRU (sub-millisecond exact matches)
 * - L2: Warm Semantic Quantized Cache (SQ8/Binary proximity search)
 * - L3: Cold Snapshot Storage (dictionary-compressed delta state)
 */
export class TieredCache<T = any> {
    private l1Max: number;
    private l2Max: number;
    private l2Threshold: number;
    private l3Max: number;
    private quantMode: 'sq8' | 'binary';

    private l1Map = new Map<string, L1Item<T>>();
    private l2Items: L2Item<T>[] = [];
    private l3Map = new Map<string, L3Item<T>>();

    private baseSnapshots = new Map<string, BaseStateSnapshot>();
    private deltaSnapshots = new Map<string, StateDeltaSnapshot[]>();

    private l1Hits = 0;
    private l2Hits = 0;
    private l3Hits = 0;
    private misses = 0;
    private promotions = 0;
    private demotions = 0;
    private savedTokens = 0;
    private memorySavedBytes = 0;

    constructor(config?: TieredCacheConfig) {
        this.l1Max = config?.l1MaxEntries ?? 100;
        this.l2Max = config?.l2MaxEntries ?? 500;
        this.l2Threshold = config?.l2SimilarityThreshold ?? 0.88;
        this.l3Max = config?.l3MaxEntries ?? 1000;
        this.quantMode = config?.quantizationMode ?? 'sq8';
    }

    /**
     * Look up an item across L1 -> L2 -> L3 tiers with automatic promotion.
     */
    lookup(
        query: string,
        optionsOrEmbedding?: Float32Array | number[] | { rawEmbedding?: Float32Array | number[]; similarityThreshold?: number }
    ): TieredLookupResult<T> {
        const start = Date.now();
        const key = query.trim().toLowerCase();

        let rawEmbedding: Float32Array | number[] | undefined;
        let threshold = this.l2Threshold;

        if (Array.isArray(optionsOrEmbedding) || optionsOrEmbedding instanceof Float32Array) {
            rawEmbedding = optionsOrEmbedding;
        } else if (optionsOrEmbedding && typeof optionsOrEmbedding === 'object') {
            rawEmbedding = optionsOrEmbedding.rawEmbedding;
            if (typeof optionsOrEmbedding.similarityThreshold === 'number') {
                threshold = optionsOrEmbedding.similarityThreshold;
            }
        }

        // 1. L1 Hot LRU Check (Exact match)
        const l1Hit = this.l1Map.get(key);
        if (l1Hit) {
            l1Hit.lastAccessed = Date.now();
            this.l1Hits++;
            this.savedTokens += Math.max(10, Math.ceil(query.length / 4));
            return {
                found: true,
                tier: 'L1',
                value: l1Hit.value,
                similarity: 1.0,
                key,
                latencyMs: Date.now() - start
            };
        }

        // 2. L2 Warm Semantic Check (Quantized Proximity Search)
        if (this.l2Items.length > 0) {
            const queryVec = rawEmbedding instanceof Float32Array 
                ? rawEmbedding 
                : rawEmbedding 
                    ? new Float32Array(rawEmbedding) 
                    : VectorQuantizer.generateEmbedding(query);

            let bestMatch: L2Item<T> | null = null;
            let bestSim = -1.0;

            if (this.quantMode === 'sq8') {
                for (const item of this.l2Items) {
                    if (!item.sq8Vector) continue;
                    const sim = VectorQuantizer.asymmetricCosineSimilarity(queryVec, item.sq8Vector);
                    if (sim > bestSim) {
                        bestSim = sim;
                        bestMatch = item;
                    }
                }
            } else {
                const queryBin = VectorQuantizer.quantizeBinary(queryVec);
                for (const item of this.l2Items) {
                    if (!item.binaryVector) continue;
                    const sim = VectorQuantizer.binaryCosineSimilarity(queryBin, item.binaryVector);
                    if (sim > bestSim) {
                        bestSim = sim;
                        bestMatch = item;
                    }
                }
            }

            if (bestMatch && bestSim >= threshold) {
                this.l2Hits++;
                bestMatch.lastAccessed = Date.now();
                this.savedTokens += Math.max(10, Math.ceil(query.length / 4));

                // Promote to L1
                this.promoteToL1(bestMatch.key, bestMatch.value);
                this.promotions++;

                return {
                    found: true,
                    tier: 'L2',
                    value: bestMatch.value,
                    similarity: bestSim,
                    key: bestMatch.key,
                    latencyMs: Date.now() - start
                };
            }
        }

        // 3. L3 Cold Snapshot / Compressed Storage Check
        const l3Hit = this.l3Map.get(key);
        if (l3Hit) {
            this.l3Hits++;
            const decompressedStr = SelectiveSnapshotter.decompressPayload(l3Hit.compressed);
            try {
                const restoredVal = JSON.parse(decompressedStr) as T;
                // Promote to L2 and L1
                this.promoteToL1(key, restoredVal);
                this.promotions++;

                return {
                    found: true,
                    tier: 'L3',
                    value: restoredVal,
                    similarity: 1.0,
                    key,
                    latencyMs: Date.now() - start
                };
            } catch {
                // Return as raw string if not JSON
                return {
                    found: true,
                    tier: 'L3',
                    value: decompressedStr as any,
                    similarity: 1.0,
                    key,
                    latencyMs: Date.now() - start
                };
            }
        }

        this.misses++;
        return {
            found: false,
            latencyMs: Date.now() - start
        };
    }

    /**
     * Alias for lookup() to conform with standard cache interfaces.
     */
    get(
        query: string,
        optionsOrEmbedding?: Float32Array | number[] | { rawEmbedding?: Float32Array | number[]; similarityThreshold?: number }
    ): TieredLookupResult<T> {
        return this.lookup(query, optionsOrEmbedding);
    }

    /**
     * Stores an entry directly into L1 with semantic quantization into L2.
     */
    set(key: string, value: T, textForSemanticIndexing?: string): void {
        const normKey = key.trim().toLowerCase();
        const text = typeof textForSemanticIndexing === 'string'
            ? textForSemanticIndexing
            : (typeof value === 'string' ? value : JSON.stringify(value || normKey));

        // Manage L1 capacity & LRU demotion
        if (this.l1Map.size >= this.l1Max) {
            this.demoteOldestL1();
        }

        this.l1Map.set(normKey, {
            key: normKey,
            value,
            createdAt: Date.now(),
            lastAccessed: Date.now()
        });

        // Generate quantized representations for L2
        const emb = VectorQuantizer.generateEmbedding(text);
        const sq8 = VectorQuantizer.quantizeSQ8(emb);
        const binary = VectorQuantizer.quantizeBinary(emb);

        this.memorySavedBytes += (sq8.originalByteSize - sq8.quantizedByteSize);

        // Check if existing item in L2
        const existingIdx = this.l2Items.findIndex(item => item.key === normKey);
        const l2Item: L2Item<T> = {
            key: normKey,
            text,
            value,
            sq8Vector: sq8,
            binaryVector: binary,
            createdAt: Date.now(),
            lastAccessed: Date.now()
        };

        if (existingIdx >= 0) {
            this.l2Items[existingIdx] = l2Item;
        } else {
            if (this.l2Items.length >= this.l2Max) {
                // Demote oldest L2 item to L3
                const oldest = this.l2Items.shift();
                if (oldest) {
                    this.demoteToL3(oldest.key, oldest.value);
                    this.demotions++;
                }
            }
            this.l2Items.push(l2Item);
        }
    }

    /**
     * Stores a compressed state snapshot into L3.
     */
    saveSnapshot(baseId: string, state: Record<string, any>): BaseStateSnapshot {
        const snapshot = SelectiveSnapshotter.createBaseSnapshot(baseId, state);
        this.baseSnapshots.set(baseId, snapshot);
        this.deltaSnapshots.set(baseId, []);

        // Also index serialized representation into L3
        const str = JSON.stringify(state);
        const comp = SelectiveSnapshotter.compressPayload(str);
        this.l3Map.set(`snapshot:${baseId}`, {
            key: `snapshot:${baseId}`,
            compressed: comp,
            createdAt: Date.now()
        });

        this.memorySavedBytes += (comp.originalByteSize - comp.compressedByteSize);
        return snapshot;
    }

    /**
     * Records a delta state mutation against a base snapshot.
     */
    recordStateDelta(baseId: string, previousState: Record<string, any>, currentState: Record<string, any>): StateDeltaSnapshot | null {
        const base = this.baseSnapshots.get(baseId);
        if (!base) return null;

        const deltas = this.deltaSnapshots.get(baseId) || [];
        const nextIndex = deltas.length;
        const delta = SelectiveSnapshotter.createDeltaSnapshot(base, previousState, currentState, nextIndex);
        deltas.push(delta);
        this.deltaSnapshots.set(baseId, deltas);

        return delta;
    }

    /**
     * Reconstructs state from base snapshot and deltas.
     */
    hydrateSnapshot(baseId: string): Record<string, any> | null {
        const base = this.baseSnapshots.get(baseId);
        if (!base) return null;
        const deltas = this.deltaSnapshots.get(baseId) || [];
        return SelectiveSnapshotter.hydrateState(base, deltas);
    }

    /**
     * Promotes an item to L1 hot cache.
     */
    private promoteToL1(key: string, value: T): void {
        if (this.l1Map.size >= this.l1Max) {
            this.demoteOldestL1();
        }
        this.l1Map.set(key, {
            key,
            value,
            createdAt: Date.now(),
            lastAccessed: Date.now()
        });
    }

    /**
     * Evicts oldest L1 item, demoting it to L3 compressed storage if not already there.
     */
    private demoteOldestL1(): void {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [k, item] of this.l1Map.entries()) {
            if (item.lastAccessed < oldestTime) {
                oldestTime = item.lastAccessed;
                oldestKey = k;
            }
        }

        if (oldestKey) {
            const item = this.l1Map.get(oldestKey);
            this.l1Map.delete(oldestKey);
            if (item) {
                this.demoteToL3(item.key, item.value);
                this.demotions++;
            }
        }
    }

    /**
     * Demotes an item to L3 cold compressed snapshot storage.
     */
    private demoteToL3(key: string, value: T): void {
        if (this.l3Map.size >= this.l3Max) {
            // Evict oldest L3
            const firstKey = this.l3Map.keys().next().value;
            if (firstKey) this.l3Map.delete(firstKey);
        }

        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        const comp = SelectiveSnapshotter.compressPayload(serialized);
        this.l3Map.set(key, {
            key,
            compressed: comp,
            createdAt: Date.now()
        });
        this.memorySavedBytes += (comp.originalByteSize - comp.compressedByteSize);
    }

    /**
     * Gathers comprehensive telemetry across all cache tiers and quantization metrics.
     */
    getMetrics(): TieredCacheMetrics {
        const total = this.l1Hits + this.l2Hits + this.l3Hits + this.misses;
        const hits = this.l1Hits + this.l2Hits + this.l3Hits;
        const hitRatio = total > 0 ? Math.round((hits / total) * 1000) / 1000 : 0;

        return {
            l1Entries: this.l1Map.size,
            l2Entries: this.l2Items.length,
            l3Entries: this.l3Map.size,
            l1Hits: this.l1Hits,
            l2Hits: this.l2Hits,
            l3Hits: this.l3Hits,
            misses: this.misses,
            promotions: this.promotions,
            demotions: this.demotions,
            totalLookups: total,
            overallHitRatio: hitRatio,
            savedTokens: this.savedTokens,
            memorySavedBytes: this.memorySavedBytes
        };
    }

    /**
     * Resets all tiers and counters.
     */
    clear(): void {
        this.l1Map.clear();
        this.l2Items = [];
        this.l3Map.clear();
        this.baseSnapshots.clear();
        this.deltaSnapshots.clear();
        this.l1Hits = 0;
        this.l2Hits = 0;
        this.l3Hits = 0;
        this.misses = 0;
        this.promotions = 0;
        this.demotions = 0;
        this.savedTokens = 0;
        this.memorySavedBytes = 0;
    }
}

export const globalTieredCache = new TieredCache();
