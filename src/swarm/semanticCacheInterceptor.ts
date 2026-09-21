/**
 * Semantic Cache Interceptor for Qdrant Namespaces
 * 
 * Provides an in-memory LRU cache keyed by high-threshold embedding similarity (> 0.96)
 * to intercept queries before executing expensive dense/sparse vector searches against Qdrant.
 */

import { createVectorIndex, type VectorIndex } from './vectorIndex.ts';

export interface SemanticCacheInterceptorConfig {
    similarityThreshold?: number; // default: 0.96
    maxEntries?: number;          // default: 500
    defaultTtlMs?: number;        // default: 30 minutes (1,800,000 ms)
}

export interface SemanticCacheEntry<T = any> {
    id: string;
    queryVector: number[];
    payload: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    appId?: string;
    filterKey?: string;
}

export interface SemanticCacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
    estimatedLatencySavedMs: number;
}

export class SemanticCacheInterceptor {
    private threshold: number;
    private maxEntries: number;
    private defaultTtlMs: number;
    private entries: Map<string, SemanticCacheEntry> = new Map();
    private vectorIndex: VectorIndex<SemanticCacheEntry>;
    private hitsCount: number = 0;
    private missesCount: number = 0;
    private evictionsCount: number = 0;
    private totalLatencySavedMs: number = 0;

    constructor(config?: SemanticCacheInterceptorConfig) {
        this.threshold = config?.similarityThreshold ?? 0.96;
        this.maxEntries = config?.maxEntries ?? 500;
        this.defaultTtlMs = config?.defaultTtlMs ?? 30 * 60 * 1000;
        this.vectorIndex = createVectorIndex<SemanticCacheEntry>('vptree', { metric: 'cosine' });
    }

    /**
     * Looks up an entry matching the query vector within the similarity threshold and namespace.
     */
    lookup<T = any>(queryVector: number[], appId?: string): { hit: boolean; payload?: T; similarity?: number } {
        if (!queryVector || queryVector.length === 0 || this.entries.size === 0) {
            this.missesCount++;
            return { hit: false };
        }

        const now = Date.now();
        // Search in sub-linear vector index
        const hits = this.vectorIndex.search(queryVector, {
            k: 5,
            minSimilarity: this.threshold,
            filter: (item) => !appId || item.data.appId === appId || !item.data.appId
        });

        if (hits.length > 0) {
            const best = hits[0];
            const entry = best.data as SemanticCacheEntry<T>;

            if (now > entry.expiresAt) {
                this.entries.delete(entry.id);
                this.vectorIndex.delete(entry.id);
                this.missesCount++;
                return { hit: false };
            }

            // Cache hit: update LRU position and hit count
            entry.hits++;
            entry.lastAccessedAt = now;
            this.entries.delete(entry.id);
            this.entries.set(entry.id, entry);

            this.hitsCount++;
            this.totalLatencySavedMs += 45; // Estimated 45ms Qdrant search saved

            return {
                hit: true,
                payload: entry.payload,
                similarity: best.similarity
            };
        }

        this.missesCount++;
        return { hit: false };
    }

    /**
     * Stores a query result in the semantic cache.
     */
    set<T = any>(queryVector: number[], payload: T, appId?: string, ttlMs?: number): void {
        if (!queryVector || queryVector.length === 0) return;

        const now = Date.now();
        const duration = ttlMs ?? this.defaultTtlMs;
        const id = `semcache-${Math.random().toString(36).substring(2, 10)}-${now}`;

        // Evict oldest if full
        if (this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.vectorIndex.delete(oldestKey);
                this.evictionsCount++;
            }
        }

        const entry: SemanticCacheEntry<T> = {
            id,
            queryVector,
            payload,
            createdAt: now,
            expiresAt: now + duration,
            hits: 0,
            lastAccessedAt: now,
            appId
        };

        this.entries.set(id, entry);
        this.vectorIndex.insert(id, queryVector, entry);
    }

    /**
     * Clears all cache entries and resets statistics.
     */
    clear(): void {
        this.entries.clear();
        this.vectorIndex.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
        this.totalLatencySavedMs = 0;
    }

    /**
     * Returns cache performance statistics.
     */
    getStats(): SemanticCacheStats {
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
