import type { ModelHealthStatus } from './types.ts';

/**
 * 5-10 minute TTL cache for model health checks.
 */
export class ModelHealthCache {
    private cache: Map<string, ModelHealthStatus> = new Map();
    private defaultTtlMs: number;

    constructor(defaultTtlMs: number = 5 * 60 * 1000) {
        // Enforce 5m (300,000ms) to 10m (600,000ms) default range
        this.defaultTtlMs = Math.max(300000, Math.min(600000, defaultTtlMs));
    }

    public getKey(provider: string, modelId: string): string {
        return `${provider.toLowerCase().trim()}:${modelId.trim()}`;
    }

    public get(provider: string, modelId: string): ModelHealthStatus | undefined {
        const key = this.getKey(provider, modelId);
        const item = this.cache.get(key);
        if (!item) return undefined;
        if (Date.now() > item.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return item;
    }

    public set(provider: string, modelId: string, status: ModelHealthStatus, ttlMs?: number): void {
        const key = this.getKey(provider, modelId);
        const actualTtl = ttlMs !== undefined
            ? Math.max(300000, Math.min(600000, ttlMs))
            : this.defaultTtlMs;
        const entry: ModelHealthStatus = {
            ...status,
            expiresAt: Date.now() + actualTtl
        };
        this.cache.set(key, entry);
    }

    public hasValid(provider: string, modelId: string): boolean {
        return this.get(provider, modelId) !== undefined;
    }

    public invalidate(provider: string, modelId: string): void {
        this.cache.delete(this.getKey(provider, modelId));
    }

    public clear(): void {
        this.cache.clear();
    }

    public size(): number {
        // Clean expired
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expiresAt) {
                this.cache.delete(key);
            }
        }
        return this.cache.size;
    }
}
