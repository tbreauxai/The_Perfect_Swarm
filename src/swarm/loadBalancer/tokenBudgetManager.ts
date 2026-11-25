import type { Provider } from '../types.ts';

export interface TokenBudgetConfig {
    defaultTpmLimit?: number;
    providerTpmLimits?: Record<string, number>;
    windowMs?: number; // default 60,000ms (1 minute)
}

export interface TokenUsageRecord {
    timestamp: number;
    tokens: number;
    agentId?: string;
}

export interface TokenBudgetMetrics {
    provider: string;
    tpmLimit: number;
    tokensUsedInWindow: number;
    tokensRemainingInWindow: number;
    utilizationPercent: number;
    totalCumulativeTokens: number;
}

export const GROQ_MODEL_TPM_DEFAULTS: Record<string, number> = {
    'groq:openai/gpt-oss-120b': 8000,
    'groq:openai/gpt-oss-20b': 8000,
    'groq:llama-3.3-70b-versatile': 12000,
};

/**
 * Tracks token allocation, sliding-window consumption, and prevents provider quota bottlenecks.
 * Groq enforces TPM per model, so Groq usage is tracked per `(provider, model)` bucket when model is provided.
 */
export class TokenBudgetManager {
    private tpmLimits: Map<string, number> = new Map();
    private usageRecords: Map<string, TokenUsageRecord[]> = new Map();
    private cumulativeTokens: Map<string, number> = new Map();
    private windowMs: number;
    private defaultTpmLimit: number;

    constructor(config?: TokenBudgetConfig) {
        this.windowMs = config?.windowMs ?? 60000;
        this.defaultTpmLimit = config?.defaultTpmLimit ?? 30000;

        // Default free-tier safe calibrated TPMs
        const defaultLimits: Record<string, number> = {
            groq: 6000,          // Legacy provider-level Groq fallback threshold
            ...GROQ_MODEL_TPM_DEFAULTS,
            cloudflare: 30000,   // Cloudflare Workers AI high TPM window
            mistral: 30000,      // Mistral free tier
            github: 40000,       // GitHub Models free tier
            openrouter: 25000,   // OpenRouter free tier
            nvidia: 30000,       // NVIDIA NIM free tier
            gemini: 1000000,     // Gemini free tier large window
            simulated: 10000000, // Zero limits for local simulation
            mock: 10000000,
            'custom-mock': 10000000,
            ...(config?.providerTpmLimits || {})
        };

        for (const [p, limit] of Object.entries(defaultLimits)) {
            this.tpmLimits.set(p.toLowerCase(), limit);
        }
    }

    resolveBucketKey(provider: Provider | string, model?: string): string {
        const prov = String(provider).toLowerCase().trim();
        const mod = typeof model === 'string' ? model.toLowerCase().trim() : '';
        if (prov === 'groq' && mod) {
            return `groq:${mod}`;
        }
        return prov;
    }

    private cleanOldRecords(bucketKey: string, now: number): void {
        const records = this.usageRecords.get(bucketKey);
        if (!records || records.length === 0) return;
        const cutoff = now - this.windowMs;
        const fresh = records.filter(r => r.timestamp > cutoff);
        this.usageRecords.set(bucketKey, fresh);
    }

    getTpmLimit(provider: Provider, model?: string): number {
        const key = this.resolveBucketKey(provider, model);
        if (this.tpmLimits.has(key)) {
            return this.tpmLimits.get(key)!;
        }
        const baseProv = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
        if (this.tpmLimits.has(baseProv)) {
            return this.tpmLimits.get(baseProv)!;
        }
        if (key.includes('mock') || key.includes('test') || key.includes('sim')) {
            return 10000000;
        }
        return this.defaultTpmLimit;
    }

    setTpmLimit(provider: Provider, limit: number, model?: string): void {
        const key = this.resolveBucketKey(provider, model);
        this.tpmLimits.set(key, Math.max(100, limit));
    }

    recordUsage(provider: Provider, tokens: number, agentId?: string, model?: string): void {
        const key = this.resolveBucketKey(provider, model);
        const now = Date.now();
        const safeTokens = Math.max(0, Math.round(tokens));

        this.cleanOldRecords(key, now);

        let list = this.usageRecords.get(key);
        if (!list) {
            list = [];
            this.usageRecords.set(key, list);
        }
        list.push({ timestamp: now, tokens: safeTokens, agentId });

        const prevCum = this.cumulativeTokens.get(key) || 0;
        this.cumulativeTokens.set(key, prevCum + safeTokens);
    }

    getTokensUsedInWindow(provider: Provider, model?: string): number {
        const key = this.resolveBucketKey(provider, model);
        const now = Date.now();
        this.cleanOldRecords(key, now);
        const records = this.usageRecords.get(key) || [];
        return records.reduce((sum, r) => sum + r.tokens, 0);
    }

    getRemainingBudget(provider: Provider, model?: string): number {
        const limit = this.getTpmLimit(provider, model);
        const used = this.getTokensUsedInWindow(provider, model);
        return Math.max(0, limit - used);
    }

    canAllocate(provider: Provider, tokens: number, model?: string): boolean {
        return this.getRemainingBudget(provider, model) >= tokens;
    }

    /**
     * Finite ms until `tokens` fit inside the sliding TPM window for `(provider, model)`.
     * Returns 0 when capacity is available immediately, or `windowMs + 1` when `tokens > limit`.
     */
    estimateWaitMs(provider: Provider, tokens: number, model?: string): number {
        const limit = this.getTpmLimit(provider, model);
        if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(tokens) || tokens > limit) {
            return this.windowMs + 1;
        }
        const key = this.resolveBucketKey(provider, model);
        const now = Date.now();
        this.cleanOldRecords(key, now);
        const records = this.usageRecords.get(key) || [];
        const used = records.reduce((sum, r) => sum + r.tokens, 0);
        if (used + tokens <= limit) return 0;

        const mustFree = used + tokens - limit;
        let freed = 0;
        for (const r of records) {
            freed += r.tokens;
            if (freed >= mustFree) {
                return Math.max(0, r.timestamp + this.windowMs - now);
            }
        }
        return this.windowMs;
    }

    applyProviderHeaders(provider: Provider | string, headers: any, model?: string): void {
        if (!headers) return;
        const key = this.resolveBucketKey(provider, model);

        const getHeader = (name: string): string | null => {
            if (typeof headers.get === 'function') {
                return headers.get(name) || headers.get(name.toLowerCase());
            }
            if (typeof headers === 'object') {
                const lower = name.toLowerCase();
                for (const [k, v] of Object.entries(headers)) {
                    if (k.toLowerCase() === lower) return String(v);
                }
            }
            return null;
        };

        const remainingTokensStr = getHeader('x-ratelimit-remaining-tokens');
        const resetRequestsStr = getHeader('x-ratelimit-reset-requests');

        if (remainingTokensStr != null) {
            const remainingTokens = parseInt(remainingTokensStr, 10);
            if (Number.isFinite(remainingTokens) && remainingTokens >= 0) {
                const limit = this.getTpmLimit(key);
                const calculatedUsed = Math.max(0, limit - remainingTokens);
                const now = Date.now();
                this.usageRecords.set(key, [{ timestamp: now, tokens: calculatedUsed }]);
            }
        }

        if (resetRequestsStr != null) {
            const resetVal = parseFloat(resetRequestsStr);
            if (Number.isFinite(resetVal)) {
                const ms = resetVal < 1000 ? resetVal * 1000 : resetVal;
                (this as any)._resetTimes = (this as any)._resetTimes || new Map<string, number>();
                (this as any)._resetTimes.set(key, Date.now() + ms);
            }
        }
    }

    getUtilizationRatio(provider: Provider, model?: string): number {
        const limit = this.getTpmLimit(provider, model);
        if (limit <= 0) return 1.0;
        const used = this.getTokensUsedInWindow(provider, model);
        return Math.min(1.0, used / limit);
    }

    getMetrics(): Record<string, TokenBudgetMetrics> {
        const now = Date.now();
        const result: Record<string, TokenBudgetMetrics> = {};
        const allKeys = new Set([...this.tpmLimits.keys(), ...this.usageRecords.keys()]);
        for (const k of allKeys) {
            this.cleanOldRecords(k, now);
            const limit = this.getTpmLimit(k);
            const used = this.getTokensUsedInWindow(k);
            const remaining = Math.max(0, limit - used);
            const cum = this.cumulativeTokens.get(k) || 0;
            result[k] = {
                provider: k,
                tpmLimit: limit,
                tokensUsedInWindow: used,
                tokensRemainingInWindow: remaining,
                utilizationPercent: limit > 0 ? Math.round((used / limit) * 100) : 0,
                totalCumulativeTokens: cum
            };
        }
        return result;
    }

    reset(): void {
        this.usageRecords.clear();
        this.cumulativeTokens.clear();
    }
}

export const globalTokenBudgetManager = new TokenBudgetManager();
