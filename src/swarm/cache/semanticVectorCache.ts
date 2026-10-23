import { createVectorIndex, type VectorIndex } from '../vectorIndex/index.ts';

export interface BaseCacheEntry {
    id: string;
    expiresAt: number;
    lastAccessedAt: number;
    hits: number;
}

export interface SemanticVectorCacheConfig {
    similarityThreshold?: number; // default: 0.96
    maxEntries?: number;          // default: 500
    defaultTtlMs?: number;        // default: 30 minutes
    vectorIndexType?: 'vptree' | 'hnsw';
    estimatedLatencySavingsMs?: number; // default: 45
}

export interface SemanticVectorCacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
    estimatedLatencySavedMs: number;
}

/**
 * Generic Base Semantic Vector Cache.
 * Provides high-similarity sub-linear vector lookup with LRU eviction and TTL expiration.
 */
export class SemanticVectorCache<TEntry extends BaseCacheEntry> {
    protected threshold: number;
    protected maxEntries: number;
    protected defaultTtlMs: number;
    protected entries: Map<string, TEntry> = new Map();
    protected vectorIndex: VectorIndex<TEntry>;
    protected hitsCount: number = 0;
    protected missesCount: number = 0;
    protected evictionsCount: number = 0;
    protected totalLatencySavedMs: number = 0;
    protected latencySavedPerHit: number;

    constructor(config?: SemanticVectorCacheConfig) {
        this.threshold = config?.similarityThreshold ?? 0.96;
        this.maxEntries = config?.maxEntries ?? 500;
        this.defaultTtlMs = config?.defaultTtlMs ?? 30 * 60 * 1000;
        this.latencySavedPerHit = config?.estimatedLatencySavingsMs ?? 45;
        this.vectorIndex = createVectorIndex<TEntry>(config?.vectorIndexType ?? 'vptree', { metric: 'cosine' });
    }

    get size(): number {
        return this.entries.size;
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }

    get(id: string): TEntry | undefined {
        return this.entries.get(id);
    }

    delete(id: string): boolean {
        const removedFromMap = this.entries.delete(id);
        const removedFromIndex = this.vectorIndex.delete(id);
        return removedFromMap || removedFromIndex;
    }

    purgeExpired(): number {
        const now = Date.now();
        let purged = 0;
        for (const [id, entry] of this.entries.entries()) {
            if (now > entry.expiresAt) {
                this.entries.delete(id);
                this.vectorIndex.delete(id);
                purged++;
            }
        }
        return purged;
    }

    protected evictLruIfNeeded(): void {
        if (this.entries.size >= this.maxEntries) {
            this.purgeExpired();
        }
        while (this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (!oldestKey) break;
            this.entries.delete(oldestKey);
            this.vectorIndex.delete(oldestKey);
            this.evictionsCount++;
        }
    }

    protected recordHit(entry: TEntry): void {
        const now = Date.now();
        entry.hits++;
        entry.lastAccessedAt = now;
        this.entries.delete(entry.id);
        this.entries.set(entry.id, entry);
        this.hitsCount++;
        this.totalLatencySavedMs += this.latencySavedPerHit;
    }

    protected recordMiss(): void {
        this.missesCount++;
    }

    clear(): void {
        this.entries.clear();
        this.vectorIndex.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
        this.totalLatencySavedMs = 0;
    }

    getStats(): SemanticVectorCacheStats {
        const total = this.hitsCount + this.missesCount;
        return {
            size: this.entries.size,
            maxEntries: this.maxEntries,
            hits: this.hitsCount,
            misses: this.missesCount,
            evictions: this.evictionsCount,
            hitRatio: total === 0 ? 0 : Number((this.hitsCount / total).toFixed(4)),
            estimatedLatencySavedMs: this.totalLatencySavedMs
        };
    }
}
