import { ProviderTelemetry, LoadBalancerConfig, TokenBudgetConfig, TokenUsageRecord, TokenBudgetMetrics, NodeCapacityConfig, CapacitySlot, NodeCapacityMetrics, SpecialistOutcomeFeedback, DomainCapabilityStats, SpecialistCapabilityProfile, CapabilityProfilerConfig, SpecialistDomainRule, ChunkAssignment, SpecialistRoutingPlan, SpecialistCandidate, ProviderHealthStatus } from "./types.ts";
import { Provider } from "../types.ts";

/**
 * Tracks token allocation, sliding-window consumption, and prevents provider quota bottlenecks.
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
        const defaultLimits: Record<string, number> = {
                        groq: 6000,          // Groq free-tier TPM threshold (6000 TPM)
                        mistral: 30000,      // Mistral free tier
                        github: 40000,       // GitHub Models free tier
                        openrouter: 25000,   // OpenRouter free tier
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

    private cleanOldRecords(providerKey: string, now: number): void {
        const records = this.usageRecords.get(providerKey);
        if (!records || records.length === 0) return;
        const cutoff = now - this.windowMs;
        const fresh = records.filter(r => r.timestamp > cutoff);
        this.usageRecords.set(providerKey, fresh);
    }

    getTpmLimit(provider: Provider): number {
        const key = String(provider).toLowerCase();
        return this.tpmLimits.get(key) ?? this.defaultTpmLimit;
    }

    setTpmLimit(provider: Provider, limit: number): void {
        this.tpmLimits.set(String(provider).toLowerCase(), Math.max(100, limit));
    }

    recordUsage(provider: Provider, tokens: number, agentId?: string): void {
        const key = String(provider).toLowerCase();
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

    getTokensUsedInWindow(provider: Provider): number {
        const key = String(provider).toLowerCase();
        const now = Date.now();
        this.cleanOldRecords(key, now);
        const records = this.usageRecords.get(key) || [];
        return records.reduce((sum, r) => sum + r.tokens, 0);
    }

    getRemainingBudget(provider: Provider): number {
        const limit = this.getTpmLimit(provider);
        const used = this.getTokensUsedInWindow(provider);
        return Math.max(0, limit - used);
    }

    canAllocate(provider: Provider, tokens: number): boolean {
        return this.getRemainingBudget(provider) >= tokens;
    }

    getUtilizationRatio(provider: Provider): number {
        const limit = this.getTpmLimit(provider);
        if (limit <= 0) return 1.0;
        const used = this.getTokensUsedInWindow(provider);
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
