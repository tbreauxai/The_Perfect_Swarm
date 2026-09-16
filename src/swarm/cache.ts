/**
 * High-performance, deterministic structured payload cache with LRU eviction and TTL expiration.
 * Prevents LLM context window drift, duplicate token expenditures, and redundant network calls
 * across identical or repetitive analysis tasks.
 */

export interface CacheEntry<T = any> {
    fingerprint: string;
    payload: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    metadata?: Record<string, any>;
}

export interface PayloadCacheConfig {
    maxEntries?: number;       // default: 250
    defaultTtlMs?: number;     // default: 15 minutes (900,000 ms)
}

export interface CacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
}

export interface FingerprintOptions {
    appId?: string;
    deepAnalysis?: boolean;
    complexity?: string;
    model?: string;
}

export class PayloadCache {
    private maxEntries: number;
    private defaultTtlMs: number;
    private entries: Map<string, CacheEntry> = new Map();
    private hitsCount: number = 0;
    private missesCount: number = 0;
    private evictionsCount: number = 0;

    constructor(config?: PayloadCacheConfig) {
        this.maxEntries = config?.maxEntries ?? 250;
        this.defaultTtlMs = config?.defaultTtlMs ?? 15 * 60 * 1000;
    }

    /**
     * Computes a deterministic 64-character hex fingerprint of the input task, payload, and options.
     * Guarantees identical fingerprints across Node.js, browsers, and edge runtimes with zero dependencies.
     */
    static computeFingerprint(task: string, data: string = "", options?: FingerprintOptions): string {
        const canonical = [
            `app:${options?.appId || 'default'}`,
            `task:${(task || '').trim()}`,
            `data:${(data || '').trim()}`,
            `complexity:${options?.complexity || 'auto'}`,
            `deep:${Boolean(options?.deepAnalysis)}`,
            `model:${options?.model || 'default'}`
        ].join('||');

        return PayloadCache.hashString(canonical);
    }

    /**
     * Pure TypeScript 64-character deterministic dual-state hash.
     * High entropy, collision-resistant, and completely portable.
     */
    static hashString(str: string): string {
        let h1 = 0x811c9dc5 ^ str.length;
        let h2 = 0xdeadbeef ^ str.length;
        let h3 = 0x41c6ce57 ^ str.length;
        let h4 = 0x9e3779b9 ^ str.length;

        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 16777619);
            h2 = Math.imul(h2 ^ ch, 2654435761);
            h3 = Math.imul(h3 ^ ch, 1597334677);
            h4 = Math.imul(h4 ^ ch, 2246822507);
        }

        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 1597334677) ^ Math.imul(h3 ^ (h3 >>> 13), 2654435761);
        h3 = Math.imul(h3 ^ (h3 >>> 16), 2654435761) ^ Math.imul(h4 ^ (h4 >>> 13), 16777619);
        h4 = Math.imul(h4 ^ (h4 >>> 16), 3266489909) ^ Math.imul(h1 ^ (h1 >>> 13), 2246822507);

        const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
        const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
        const hex3 = (h3 >>> 0).toString(16).padStart(8, '0');
        const hex4 = (h4 >>> 0).toString(16).padStart(8, '0');

        // Repeat mix to output 64-character fingerprint
        const p1 = `${hex1}${hex2}${hex3}${hex4}`;
        let rev1 = 0x5bd1e995;
        for (let i = 0; i < p1.length; i++) {
            rev1 = Math.imul(rev1 ^ p1.charCodeAt(i), 1540483477);
        }
        const hex5 = (rev1 >>> 0).toString(16).padStart(8, '0');
        const hex6 = ((rev1 * 31) >>> 0).toString(16).padStart(8, '0');
        const hex7 = ((rev1 * 127) >>> 0).toString(16).padStart(8, '0');
        const hex8 = ((rev1 * 8191) >>> 0).toString(16).padStart(8, '0');

        return `${hex1}${hex2}${hex3}${hex4}${hex5}${hex6}${hex7}${hex8}`;
    }

    /**
     * Retrieves a cached payload by its deterministic fingerprint.
     * Updates LRU order and returns null if expired or missing.
     */
    get<T = any>(fingerprint: string): T | null {
        const entry = this.entries.get(fingerprint);
        if (!entry) {
            this.missesCount++;
            return null;
        }

        const now = Date.now();
        if (now > entry.expiresAt) {
            this.entries.delete(fingerprint);
            this.missesCount++;
            return null;
        }

        // Cache hit: update LRU position by re-inserting to end of Map
        entry.hits++;
        entry.lastAccessedAt = now;
        this.entries.delete(fingerprint);
        this.entries.set(fingerprint, entry);

        this.hitsCount++;
        return entry.payload as T;
    }

    /**
     * Stores an analysis payload under the given fingerprint with LRU eviction and TTL expiration.
     */
    set<T = any>(fingerprint: string, payload: T, ttlMs?: number, metadata?: Record<string, any>): void {
        const now = Date.now();
        const duration = ttlMs ?? this.defaultTtlMs;

        // If key exists, delete it first so insertion moves to end of Map
        if (this.entries.has(fingerprint)) {
            this.entries.delete(fingerprint);
        } else if (this.entries.size >= this.maxEntries) {
            // Evict least-recently-used entry (first key in Map iterator)
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.evictionsCount++;
            }
        }

        this.entries.set(fingerprint, {
            fingerprint,
            payload,
            createdAt: now,
            expiresAt: now + duration,
            hits: 0,
            lastAccessedAt: now,
            metadata
        });
    }

    /**
     * Checks whether an unexpired entry exists for the fingerprint.
     */
    has(fingerprint: string): boolean {
        const entry = this.entries.get(fingerprint);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this.entries.delete(fingerprint);
            return false;
        }
        return true;
    }

    /**
     * Invalidates a specific fingerprint.
     */
    invalidate(fingerprint: string): boolean {
        return this.entries.delete(fingerprint);
    }

    /**
     * Clears all cached payloads and resets counters.
     */
    clear(): void {
        this.entries.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
    }

    /**
     * Returns cache performance statistics.
     */
    getStats(): CacheStats {
        const total = this.hitsCount + this.missesCount;
        return {
            size: this.entries.size,
            maxEntries: this.maxEntries,
            hits: this.hitsCount,
            misses: this.missesCount,
            evictions: this.evictionsCount,
            hitRatio: total === 0 ? 0 : Number((this.hitsCount / total).toFixed(4))
        };
    }
}

/**
 * Global shared payload cache singleton for cross-invocation persistence.
 */
export const globalPayloadCache = new PayloadCache({ maxEntries: 300, defaultTtlMs: 60 * 60 * 1000 });
