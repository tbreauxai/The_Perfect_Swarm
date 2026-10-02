import type {
    TieredCacheConfig,
    TieredCacheMetrics,
    TieredLookupResult,
    L1Item,
    L2Item,
    L3Item,
    BaseStateSnapshot,
    StateDeltaSnapshot
} from './types.ts';
import { VectorQuantizer } from './vectorQuantizer.ts';
import { SelectiveSnapshotter } from './selectiveSnapshotter.ts';

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
            const items = this.l2Items;
            const len = items.length;

            if (this.quantMode === 'sq8') {
                for (let i = 0; i < len; i++) {
                    const item = items[i];
                    if (!item.sq8Vector) continue;
                    const sim = VectorQuantizer.asymmetricCosineSimilarity(queryVec, item.sq8Vector);
                    if (sim > bestSim) {
                        bestSim = sim;
                        bestMatch = item;
                        if (sim === 1.0) break; // Early exit on exact semantic match
                    }
                }
            } else {
                const queryBin = VectorQuantizer.quantizeBinary(queryVec);
                for (let i = 0; i < len; i++) {
                    const item = items[i];
                    if (!item.binaryVector) continue;
                    const sim = VectorQuantizer.binaryCosineSimilarity(queryBin, item.binaryVector);
                    if (sim > bestSim) {
                        bestSim = sim;
                        bestMatch = item;
                        if (sim === 1.0) break; // Early exit on exact semantic match
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
        if (!this.l1Map.has(normKey)) {
            while (this.l1Map.size >= this.l1Max) {
                this.demoteOldestL1();
            }
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
        if (!this.l1Map.has(key)) {
            while (this.l1Map.size >= this.l1Max) {
                this.demoteOldestL1();
            }
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
        while (this.l3Map.size >= this.l3Max) {
            // Evict oldest L3
            const firstKey = this.l3Map.keys().next().value;
            if (firstKey) {
                this.l3Map.delete(firstKey);
            } else {
                break;
            }
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
