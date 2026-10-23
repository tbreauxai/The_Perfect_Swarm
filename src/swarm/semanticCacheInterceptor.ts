/**
 * Semantic Cache Interceptor for Qdrant Namespaces
 * 
 * Provides an in-memory LRU cache keyed by high-threshold embedding similarity (> 0.96)
 * to intercept queries before executing expensive dense/sparse vector searches against Qdrant.
 */

import { SemanticVectorCache, type BaseCacheEntry, type SemanticVectorCacheConfig, type SemanticVectorCacheStats } from './cache/semanticVectorCache.ts';

export type SemanticCacheInterceptorConfig = SemanticVectorCacheConfig;
export type SemanticCacheStats = SemanticVectorCacheStats;

export interface SemanticCacheEntry<T = any> extends BaseCacheEntry {
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

export class SemanticCacheInterceptor extends SemanticVectorCache<SemanticCacheEntry> {
    constructor(config?: SemanticCacheInterceptorConfig) {
        super({
            similarityThreshold: config?.similarityThreshold ?? 0.96,
            maxEntries: config?.maxEntries ?? 500,
            defaultTtlMs: config?.defaultTtlMs ?? 30 * 60 * 1000,
            estimatedLatencySavingsMs: 45
        });
    }

    /**
     * Looks up an entry matching the query vector within the similarity threshold and namespace.
     */
    lookup<T = any>(queryVector: number[], appId?: string): { hit: boolean; payload?: T; similarity?: number } {
        if (!queryVector || queryVector.length === 0 || this.entries.size === 0) {
            this.recordMiss();
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
                this.recordMiss();
                return { hit: false };
            }

            // Cache hit: update LRU position and hit count
            this.recordHit(entry);

            return {
                hit: true,
                payload: entry.payload,
                similarity: best.similarity
            };
        }

        this.recordMiss();
        return { hit: false };
    }

    /**
     * Stores a query result in the semantic cache.
     */
    set<T = any>(queryVector: number[], payload: T, appId?: string, ttlMs?: number): void {
        if (!queryVector || queryVector.length === 0) return;

        const now = Date.now();
        const duration = ttlMs ?? this.defaultTtlMs;
        const id = `semcache-${crypto.randomUUID()}-${now}`;

        // Ensure LRU capacity bounds
        this.evictLruIfNeeded();

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
}
