import type {
    SubComputationDomain,
    SubComputationCacheEntry,
    SubComputationCacheMetrics,
    SubComputationCacheConfig
} from './types.ts';

/**
 * High-throughput, TTL-bounded cache for frequent sub-computations.
 * Prevents redundant statistical recalculations and LLM prompt lookups.
 */
export class DomainSubComputationCache {
    private entries: Map<string, SubComputationCacheEntry> = new Map();
    private defaultTtlMs: number;
    private maxEntries: number;
    private hits: number = 0;
    private misses: number = 0;
    private evictions: number = 0;
    private subcomputationsSaved: number = 0;
    private domainStats: Record<SubComputationDomain, { entries: number; hits: number; misses: number }> = {
        team_form: { entries: 0, hits: 0, misses: 0 },
        head_to_head: { entries: 0, hits: 0, misses: 0 },
        market_odds: { entries: 0, hits: 0, misses: 0 },
        player_props: { entries: 0, hits: 0, misses: 0 },
        league_baseline: { entries: 0, hits: 0, misses: 0 },
        custom: { entries: 0, hits: 0, misses: 0 }
    };

    constructor(config: SubComputationCacheConfig = {}) {
        this.defaultTtlMs = config.defaultTtlMs ?? 300000; // 5 min
        this.maxEntries = config.maxEntries ?? 1000;
    }

    private makeCompositeKey(domain: SubComputationDomain, key: string): string {
        return `${domain}:${key.trim().toLowerCase()}`;
    }

    public get<T = any>(domain: SubComputationDomain, key: string): T | undefined {
        const compositeKey = this.makeCompositeKey(domain, key);
        const entry = this.entries.get(compositeKey);

        if (!entry) {
            this.misses++;
            if (this.domainStats[domain]) this.domainStats[domain].misses++;
            return undefined;
        }

        const now = Date.now();
        if (entry.expiresAt > 0 && now >= entry.expiresAt) {
            this.entries.delete(compositeKey);
            this.misses++;
            this.evictions++;
            if (this.domainStats[domain]) {
                this.domainStats[domain].misses++;
                this.domainStats[domain].entries = Math.max(0, this.domainStats[domain].entries - 1);
            }
            return undefined;
        }

        entry.hits++;
        this.hits++;
        this.subcomputationsSaved++;
        if (this.domainStats[domain]) this.domainStats[domain].hits++;

        // Refresh LRU position
        this.entries.delete(compositeKey);
        this.entries.set(compositeKey, entry);

        return entry.value as T;
    }

    public set<T = any>(domain: SubComputationDomain, key: string, value: T, ttlMs?: number): void {
        const compositeKey = this.makeCompositeKey(domain, key);
        const now = Date.now();
        const effectiveTtl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
        const expiresAt = effectiveTtl > 0 ? now + effectiveTtl : 0;

        if (this.entries.has(compositeKey)) {
            const existing = this.entries.get(compositeKey)!;
            existing.value = value;
            existing.expiresAt = expiresAt;
            existing.createdAt = now;
            // Move to newest
            this.entries.delete(compositeKey);
            this.entries.set(compositeKey, existing);
            return;
        }

        if (this.entries.size >= this.maxEntries) {
            // Evict oldest entry (first item in Map iterator)
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                const oldEntry = this.entries.get(oldestKey);
                if (oldEntry && this.domainStats[oldEntry.domain]) {
                    this.domainStats[oldEntry.domain].entries = Math.max(0, this.domainStats[oldEntry.domain].entries - 1);
                }
                this.entries.delete(oldestKey);
                this.evictions++;
            }
        }

        this.entries.set(compositeKey, {
            domain,
            key,
            value,
            createdAt: now,
            expiresAt,
            hits: 0
        });

        if (this.domainStats[domain]) {
            this.domainStats[domain].entries++;
        }
    }

    public async getOrCompute<T = any>(
        domain: SubComputationDomain,
        key: string,
        computeFn: () => Promise<T> | T,
        ttlMs?: number
    ): Promise<T> {
        const cached = this.get<T>(domain, key);
        if (cached !== undefined) {
            return cached;
        }

        const computed = await computeFn();
        this.set<T>(domain, key, computed, ttlMs);
        return computed;
    }

    public invalidate(domain?: SubComputationDomain, key?: string): number {
        if (!domain && !key) {
            const count = this.entries.size;
            this.clear();
            return count;
        }

        let count = 0;
        if (domain && key) {
            const compositeKey = this.makeCompositeKey(domain, key);
            if (this.entries.delete(compositeKey)) {
                count++;
                if (this.domainStats[domain]) {
                    this.domainStats[domain].entries = Math.max(0, this.domainStats[domain].entries - 1);
                }
            }
        } else if (domain) {
            for (const [k, v] of this.entries.entries()) {
                if (v.domain === domain) {
                    this.entries.delete(k);
                    count++;
                }
            }
            if (this.domainStats[domain]) {
                this.domainStats[domain].entries = 0;
            }
        }
        return count;
    }

    public clear(): void {
        this.entries.clear();
        for (const dom of Object.keys(this.domainStats) as SubComputationDomain[]) {
            this.domainStats[dom].entries = 0;
        }
    }

    public getMetrics(): SubComputationCacheMetrics {
        const total = this.hits + this.misses;
        return {
            totalEntries: this.entries.size,
            hits: this.hits,
            misses: this.misses,
            hitRatio: total > 0 ? Math.round((this.hits / total) * 1000) / 1000 : 0,
            subcomputationsSaved: this.subcomputationsSaved,
            evictions: this.evictions,
            domainBreakdown: JSON.parse(JSON.stringify(this.domainStats))
        };
    }
}

export const globalDomainSubComputationCache = new DomainSubComputationCache();
