import type { Provider, ProviderCredential } from './types.ts';

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'cooldown';

export interface ProviderTelemetry {
    provider: Provider;
    status: ProviderHealthStatus;
    inFlightRequests: number;
    latencyEmaMs: number;
    lastLatencyMs: number;
    totalRequests: number;
    successCount: number;
    failureCount: number;
    rateLimitCount: number;
    lastError?: string;
    lastErrorTimestamp?: number;
    cooldownUntil?: number;
}

export interface LoadBalancerConfig {
    emaAlpha?: number;               // Smoothing factor for latency EMA (default 0.25)
    inFlightPenaltyMs?: number;      // Penalty added to perceived latency per in-flight request (default 500ms)
    rateLimitCooldownMs?: number;    // Time to back off after 429 (default 15,000ms)
    degradedThresholdErrors?: number;// Number of consecutive errors before marking degraded (default 2)
}

/**
 * Real-time Adaptive Load Balancer for multi-provider free-tier swarms.
 * Routes agent operations dynamically away from rate-limited or high-latency providers
 * toward the fastest, healthiest available provider.
 */
export class AdaptiveLoadBalancer {
    private telemetry: Map<string, ProviderTelemetry> = new Map();
    private emaAlpha: number;
    private inFlightPenaltyMs: number;
    private rateLimitCooldownMs: number;
    private degradedThresholdErrors: number;

    constructor(config?: LoadBalancerConfig) {
        this.emaAlpha = config?.emaAlpha ?? 0.25;
        this.inFlightPenaltyMs = config?.inFlightPenaltyMs ?? 500;
        this.rateLimitCooldownMs = config?.rateLimitCooldownMs ?? 15000;
        this.degradedThresholdErrors = config?.degradedThresholdErrors ?? 2;
    }

    private getOrCreateTelemetry(provider: Provider): ProviderTelemetry {
        const key = String(provider).toLowerCase();
        let t = this.telemetry.get(key);
        if (!t) {
            t = {
                provider: key,
                status: 'healthy',
                inFlightRequests: 0,
                latencyEmaMs: 400, // baseline estimated response time
                lastLatencyMs: 400,
                totalRequests: 0,
                successCount: 0,
                failureCount: 0,
                rateLimitCount: 0
            };
            this.telemetry.set(key, t);
        }
        return t;
    }

    /**
     * Inspects telemetry metrics for a provider.
     */
    getTelemetry(provider: Provider): ProviderTelemetry {
        return { ...this.getOrCreateTelemetry(provider) };
    }

    /**
     * Inspects all active provider telemetry.
     */
    getAllTelemetry(): Record<string, ProviderTelemetry> {
        const result: Record<string, ProviderTelemetry> = {};
        for (const [key, val] of this.telemetry.entries()) {
            result[key] = { ...val };
        }
        return result;
    }

    /**
     * Calculates the dynamic health score of a provider candidate.
     * Higher score = higher preference.
     */
    calculateScore(provider: Provider): number {
        const t = this.getOrCreateTelemetry(provider);
        const now = Date.now();

        // Check if provider is in active 429 rate limit cooldown
        if (t.cooldownUntil && now < t.cooldownUntil) {
            return -1000 + (t.cooldownUntil - now) * -0.1; // heavily penalized
        }

        // Perceived latency = latencyEma + inFlight * penalty
        const effectiveLatency = Math.max(50, t.latencyEmaMs + (t.inFlightRequests * this.inFlightPenaltyMs));

        // Base score inverted from effective latency
        let score = 100000 / effectiveLatency;

        if (t.status === 'degraded') {
            score *= 0.3;
        }

        // Penalize in-flight concurrency to prevent burst rate limits
        score -= t.inFlightRequests * 50;

        return Math.max(1, score);
    }

    /**
     * Selects the optimal healthy provider from a list of available provider credentials.
     * Falls back to first available if all are in cooldown.
     */
    selectOptimalProvider(candidates: ProviderCredential[]): ProviderCredential {
        if (!candidates || candidates.length === 0) {
            throw new Error('No candidate providers available for load balancing');
        }
        if (candidates.length === 1) {
            return candidates[0];
        }

        const scored = candidates.map(c => ({
            candidate: c,
            score: this.calculateScore(c.provider)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored[0].candidate;
    }

    /**
     * Records the start of an execution on a provider.
     */
    recordStart(provider: Provider): void {
        const t = this.getOrCreateTelemetry(provider);
        t.inFlightRequests++;
        t.totalRequests++;
    }

    /**
     * Records successful execution and updates exponential moving average (EMA) latency.
     */
    recordSuccess(provider: Provider, durationMs: number): void {
        const t = this.getOrCreateTelemetry(provider);
        t.inFlightRequests = Math.max(0, t.inFlightRequests - 1);
        t.successCount++;
        t.lastLatencyMs = durationMs;

        // Exponential Moving Average update
        t.latencyEmaMs = Math.round((this.emaAlpha * durationMs) + ((1 - this.emaAlpha) * t.latencyEmaMs));

        // Reset error state if previously degraded
        if (t.status !== 'healthy' && (!t.cooldownUntil || Date.now() >= t.cooldownUntil)) {
            t.status = 'healthy';
            t.cooldownUntil = undefined;
        }
    }

    /**
     * Records execution failure, detecting 429 rate limits or timeouts to trigger health degradation.
     */
    recordFailure(provider: Provider, error: any): void {
        const t = this.getOrCreateTelemetry(provider);
        t.inFlightRequests = Math.max(0, t.inFlightRequests - 1);
        t.failureCount++;

        const errMsg = String(error?.message || error || '');
        t.lastError = errMsg;
        t.lastErrorTimestamp = Date.now();

        const isRateLimit = errMsg.includes('429') || errMsg.includes('RATE_LIMIT') || errMsg.includes('quota') || errMsg.includes('TPM');
        const isTimeout = errMsg.includes('timeout') || errMsg.includes('TIMEOUT') || errMsg.includes('AbortError');

        if (isRateLimit) {
            t.rateLimitCount++;
            t.status = 'cooldown';
            t.cooldownUntil = Date.now() + this.rateLimitCooldownMs;
            // Inflate perceived latency to prevent immediate reselection
            t.latencyEmaMs = Math.max(t.latencyEmaMs * 2, 5000);
        } else if (isTimeout) {
            t.status = 'degraded';
            t.latencyEmaMs = Math.max(t.latencyEmaMs * 1.5, 3000);
        } else {
            t.status = 'degraded';
        }
    }

    /**
     * Executes an async provider call with telemetry wrapping, latency tracking, and automatic failure handling.
     */
    async executeWithTelemetry<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
        this.recordStart(provider);
        const startTime = Date.now();
        try {
            const result = await fn();
            const duration = Date.now() - startTime;
            this.recordSuccess(provider, duration);
            return result;
        } catch (err) {
            this.recordFailure(provider, err);
            throw err;
        }
    }

    /**
     * Resets telemetry metrics across all providers.
     */
    reset(): void {
        this.telemetry.clear();
    }
}

/**
 * Global shared adaptive load balancer singleton.
 */
export const globalLoadBalancer = new AdaptiveLoadBalancer();

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

        // Default free-tier safe calibrated TPMs
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

export const globalTokenBudgetManager = new TokenBudgetManager();

export interface NodeCapacityConfig {
    defaultMaxConcurrency?: number;               // default 5
    nodeConcurrencyLimits?: Record<string, number>; // per-node or per-provider concurrency limits
    saturationThreshold?: number;                 // threshold ratio (e.g. 0.90 or 1.0) for saturation flag
}

export interface CapacitySlot {
    slotId: string;
    nodeKey: string;
    acquiredAt: number;
    weight: number;
    metadata?: Record<string, any>;
    release: () => void;
}

export interface NodeCapacityMetrics {
    nodeKey: string;
    maxConcurrency: number;
    activeInFlight: number;
    availableHeadroom: number;
    utilizationRatio: number;      // 0.0 to 1.0
    utilizationPercent: number;    // 0 to 100
    isSaturated: boolean;
    totalSlotsAcquired: number;
    totalSlotsReleased: number;
}

/**
 * Manages per-node and per-provider concurrency capacity, tracks in-flight workload slots,
 * and calculates real-time node capacity headroom to prevent resource exhaustion and 429 bottlenecks.
 */
export class NodeCapacityManager {
    private concurrencyLimits: Map<string, number> = new Map();
    private activeSlots: Map<string, Map<string, CapacitySlot>> = new Map();
    private totalAcquiredCount: Map<string, number> = new Map();
    private totalReleasedCount: Map<string, number> = new Map();
    private defaultMaxConcurrency: number;
    private saturationThreshold: number;

    constructor(config?: NodeCapacityConfig) {
        this.defaultMaxConcurrency = config?.defaultMaxConcurrency ?? 5;
        this.saturationThreshold = config?.saturationThreshold ?? 1.0;

        // Calibrated default provider / node concurrency limits:
        const defaultLimits: Record<string, number> = {
            groq: 2,             // Free tier TPM / RPM tight limit (1-2 concurrent)
            mistral: 3,          // Free tier moderate concurrency
            github: 4,           // GitHub Models free tier
            openrouter: 4,       // Free tier routing
            gemini: 10,          // Gemini high concurrency limit
            simulated: 50,       // Mock / test
            mock: 50,
            'custom-mock': 50,
            ...(config?.nodeConcurrencyLimits || {})
        };

        for (const [key, limit] of Object.entries(defaultLimits)) {
            this.concurrencyLimits.set(key.toLowerCase(), Math.max(1, limit));
        }
    }

    private normalizeKey(nodeKey: string): string {
        return (nodeKey || '').toLowerCase().trim();
    }

    getMaxConcurrency(nodeKey: string): number {
        const key = this.normalizeKey(nodeKey);
        return this.concurrencyLimits.get(key) ?? this.defaultMaxConcurrency;
    }

    setMaxConcurrency(nodeKey: string, limit: number): void {
        const key = this.normalizeKey(nodeKey);
        this.concurrencyLimits.set(key, Math.max(1, Math.round(limit)));
    }

    getActiveInFlight(nodeKey: string): number {
        const key = this.normalizeKey(nodeKey);
        const slots = this.activeSlots.get(key);
        return slots ? slots.size : 0;
    }

    getCapacityHeadroom(nodeKey: string): number {
        const max = this.getMaxConcurrency(nodeKey);
        const active = this.getActiveInFlight(nodeKey);
        return Math.max(0, max - active);
    }

    getNodeHeadroom(nodeKey: string): number {
        return this.getCapacityHeadroom(nodeKey);
    }

    getUtilizationRatio(nodeKey: string): number {
        const max = this.getMaxConcurrency(nodeKey);
        if (max <= 0) return 1.0;
        const active = this.getActiveInFlight(nodeKey);
        return Math.min(1.0, Math.max(0, active / max));
    }

    isSaturated(nodeKey: string): boolean {
        return this.getUtilizationRatio(nodeKey) >= this.saturationThreshold;
    }

    hasCapacity(nodeKey: string, weight: number = 1): boolean {
        return this.getCapacityHeadroom(nodeKey) >= weight;
    }

    tryAcquireSlot(
        nodeKey: string,
        options?: { weight?: number; metadata?: Record<string, any> }
    ): CapacitySlot | null {
        const key = this.normalizeKey(nodeKey);
        const weight = Math.max(1, options?.weight ?? 1);

        if (!this.hasCapacity(key, weight)) {
            return null;
        }

        let slots = this.activeSlots.get(key);
        if (!slots) {
            slots = new Map();
            this.activeSlots.set(key, slots);
        }

        const slotId = `slot-${key}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        let released = false;

        const slot: CapacitySlot = {
            slotId,
            nodeKey: key,
            acquiredAt: Date.now(),
            weight,
            metadata: options?.metadata,
            release: () => {
                if (!released) {
                    released = true;
                    this.releaseSlot(slot);
                }
            }
        };

        slots.set(slotId, slot);
        this.totalAcquiredCount.set(key, (this.totalAcquiredCount.get(key) || 0) + 1);

        return slot;
    }

    releaseSlot(slotOrId: CapacitySlot | string, nodeKey?: string): boolean {
        const slotId = typeof slotOrId === 'string' ? slotOrId : slotOrId.slotId;
        const targetNode = typeof slotOrId === 'string'
            ? (nodeKey ? this.normalizeKey(nodeKey) : undefined)
            : slotOrId.nodeKey;

        if (targetNode) {
            const slots = this.activeSlots.get(targetNode);
            if (slots && slots.has(slotId)) {
                slots.delete(slotId);
                this.totalReleasedCount.set(targetNode, (this.totalReleasedCount.get(targetNode) || 0) + 1);
                return true;
            }
        } else {
            for (const [k, slots] of this.activeSlots.entries()) {
                if (slots.has(slotId)) {
                    slots.delete(slotId);
                    this.totalReleasedCount.set(k, (this.totalReleasedCount.get(k) || 0) + 1);
                    return true;
                }
            }
        }

        return false;
    }

    getNodeMetrics(nodeKey: string): NodeCapacityMetrics {
        const key = this.normalizeKey(nodeKey);
        const max = this.getMaxConcurrency(key);
        const active = this.getActiveInFlight(key);
        const headroom = Math.max(0, max - active);
        const ratio = max > 0 ? active / max : 1.0;

        return {
            nodeKey: key,
            maxConcurrency: max,
            activeInFlight: active,
            availableHeadroom: headroom,
            utilizationRatio: Math.round(ratio * 1000) / 1000,
            utilizationPercent: Math.min(100, Math.round(ratio * 100)),
            isSaturated: ratio >= this.saturationThreshold,
            totalSlotsAcquired: this.totalAcquiredCount.get(key) || 0,
            totalSlotsReleased: this.totalReleasedCount.get(key) || 0
        };
    }

    getAllNodeMetrics(): Record<string, NodeCapacityMetrics> {
        const result: Record<string, NodeCapacityMetrics> = {};
        const allKeys = new Set([
            ...this.concurrencyLimits.keys(),
            ...this.activeSlots.keys(),
            ...this.totalAcquiredCount.keys()
        ]);

        for (const k of allKeys) {
            result[k] = this.getNodeMetrics(k);
        }

        return result;
    }

    reset(): void {
        this.activeSlots.clear();
        this.totalAcquiredCount.clear();
        this.totalReleasedCount.clear();
    }
}

export const globalNodeCapacityManager = new NodeCapacityManager();

export interface SpecialistOutcomeFeedback {
    success: boolean;
    qualityRating?: number;   // 0.0 to 1.0 (from critic or default 0.85)
    durationMs?: number;      // Execution latency
    domain?: string;          // Matched domain (e.g. 'Security & Auth', 'Performance & Latency')
    tokensUsed?: number;
    error?: string;
}

export interface DomainCapabilityStats {
    trials: number;
    successes: number;
    totalReward: number;
    averageReward: number;
    lastUpdated: number;
}

export interface SpecialistCapabilityProfile {
    agentRole: string;
    trials: number;
    successes: number;
    failures: number;
    completionRate: number;      // 0.0 to 1.0
    totalReward: number;
    averageReward: number;       // Empirical mean reward
    latencyEmaMs: number;
    domainStats: Record<string, DomainCapabilityStats>;
    lastUpdated: number;
}

export interface CapabilityProfilerConfig {
    explorationConstant?: number;      // c in UCB1 formula: UCB1 = mu_i + c * sqrt(2 * ln(N) / N_i), default 0.707
    emaAlpha?: number;                 // Smoothing factor for latency EMA (default 0.25)
    defaultLatencyBaselineMs?: number; // Latency normalization baseline (default 1500ms)
}

/**
 * Reinforcement Learning Specialist Capability Profiler.
 * Uses Multi-Armed Bandit with Upper Confidence Bound (UCB1) reward scoring
 * to adaptively schedule specialist agents based on historical verification ratings,
 * task completion rates, domain affinity outcomes, and latency.
 */
export class SpecialistCapabilityProfiler {
    private profiles: Map<string, SpecialistCapabilityProfile> = new Map();
    private explorationConstant: number;
    private emaAlpha: number;
    private defaultLatencyBaselineMs: number;
    private totalTrials: number = 0;

    constructor(config?: CapabilityProfilerConfig) {
        this.explorationConstant = config?.explorationConstant ?? 0.707;
        this.emaAlpha = config?.emaAlpha ?? 0.25;
        this.defaultLatencyBaselineMs = config?.defaultLatencyBaselineMs ?? 1500;
    }

    private getOrCreateProfile(agentRole: string): SpecialistCapabilityProfile {
        const key = (agentRole || '').trim();
        let profile = this.profiles.get(key);
        if (!profile) {
            profile = {
                agentRole: key,
                trials: 0,
                successes: 0,
                failures: 0,
                completionRate: 1.0,
                totalReward: 0,
                averageReward: 0.85,
                latencyEmaMs: this.defaultLatencyBaselineMs,
                domainStats: {},
                lastUpdated: Date.now()
            };
            this.profiles.set(key, profile);
        }
        return profile;
    }

    /**
     * Computes the normalized reinforcement learning reward R in [0.0, 1.0]
     * factoring in task completion, verification quality rating, and execution latency.
     */
    calculateReward(feedback: SpecialistOutcomeFeedback): number {
        if (!feedback.success) {
            return 0.05; // heavily penalized for failures/exceptions
        }

        const quality = Math.min(1.0, Math.max(0.0, feedback.qualityRating ?? 0.85));
        const latency = feedback.durationMs ?? this.defaultLatencyBaselineMs;
        const latencyRatio = Math.max(0, 1.0 - (latency / (this.defaultLatencyBaselineMs * 3)));

        // Reward composition: 50% success base + 35% verification quality + 15% latency efficiency
        const reward = 0.50 + (quality * 0.35) + (latencyRatio * 0.15);
        return Math.min(1.0, Math.max(0.05, Math.round(reward * 1000) / 1000));
    }

    /**
     * Records execution outcome feedback and updates reinforcement learning capability profiles.
     */
    recordOutcome(agentRole: string, feedback: SpecialistOutcomeFeedback | number): void {
        const key = (agentRole || '').trim();
        if (!key) return;

        const profile = this.getOrCreateProfile(key);
        const fb: SpecialistOutcomeFeedback = typeof feedback === 'number'
            ? { success: feedback > 0.3, qualityRating: feedback }
            : feedback;

        const reward = this.calculateReward(fb);
        const now = Date.now();

        profile.trials++;
        this.totalTrials++;

        if (fb.success) {
            profile.successes++;
        } else {
            profile.failures++;
        }

        profile.completionRate = profile.trials > 0
            ? Math.round((profile.successes / profile.trials) * 100) / 100
            : 1.0;

        profile.totalReward += reward;
        profile.averageReward = Math.round((profile.totalReward / profile.trials) * 1000) / 1000;

        if (fb.durationMs !== undefined && fb.durationMs > 0) {
            profile.latencyEmaMs = Math.round(
                (profile.latencyEmaMs * (1 - this.emaAlpha)) + (fb.durationMs * this.emaAlpha)
            );
        }

        if (fb.domain) {
            let ds = profile.domainStats[fb.domain];
            if (!ds) {
                ds = {
                    trials: 0,
                    successes: 0,
                    totalReward: 0,
                    averageReward: 0.85,
                    lastUpdated: now
                };
                profile.domainStats[fb.domain] = ds;
            }
            ds.trials++;
            if (fb.success) ds.successes++;
            ds.totalReward += reward;
            ds.averageReward = Math.round((ds.totalReward / ds.trials) * 1000) / 1000;
            ds.lastUpdated = now;
        }

        profile.lastUpdated = now;
    }

    /**
     * Calculates Upper Confidence Bound (UCB1) capability score for an agent role.
     * Balances empirical performance (exploitation) with exploration uncertainty.
     */
    getUcb1Score(agentRole: string, domain?: string): number {
        const profile = this.getOrCreateProfile(agentRole);

        // Untried specialists receive an optimistic exploration bonus to ensure trial
        if (profile.trials === 0) {
            return 1.0 + this.explorationConstant;
        }

        const totalN = Math.max(1, this.totalTrials);
        const agentN = profile.trials;

        // Exploitation component: blend domain-specific performance with overall average
        let meanReward = profile.averageReward;
        if (domain && profile.domainStats[domain] && profile.domainStats[domain].trials > 0) {
            const ds = profile.domainStats[domain];
            meanReward = (ds.averageReward * 0.70) + (profile.averageReward * 0.30);
        }

        // Exploration component: c * sqrt(2 * ln(N) / N_i)
        const explorationBonus = this.explorationConstant * Math.sqrt((2 * Math.log(totalN)) / agentN);
        const ucb = meanReward + explorationBonus;

        return Math.round(ucb * 1000) / 1000;
    }

    /**
     * Calculates empirical capability score based on verification rewards and task completion rate
     * without Multi-Armed Bandit exploration inflation. Ideal for stable cluster lead election.
     */
    getCapabilityScore(agentRole: string, domain?: string): number {
        const profile = this.profiles.get((agentRole || '').trim());
        if (!profile || profile.trials === 0) {
            return 0.85;
        }

        let meanReward = profile.averageReward;
        if (domain && profile.domainStats[domain] && profile.domainStats[domain].trials > 0) {
            const ds = profile.domainStats[domain];
            meanReward = (ds.averageReward * 0.70) + (profile.averageReward * 0.30);
        }

        return Math.round(meanReward * profile.completionRate * 1000) / 1000;
    }

    getProfile(agentRole: string): SpecialistCapabilityProfile | undefined {
        const p = this.profiles.get((agentRole || '').trim());
        if (!p) return undefined;
        return {
            ...p,
            domainStats: { ...p.domainStats }
        };
    }

    getAllProfiles(): Record<string, SpecialistCapabilityProfile> {
        const result: Record<string, SpecialistCapabilityProfile> = {};
        for (const [k, p] of this.profiles.entries()) {
            result[k] = {
                ...p,
                domainStats: { ...p.domainStats }
            };
        }
        return result;
    }

    reset(): void {
        this.profiles.clear();
        this.totalTrials = 0;
    }
}

export const globalSpecialistProfiler = new SpecialistCapabilityProfiler();

export interface SpecialistDomainRule {
    domain: string;
    roleKeywords: string[];
    taskKeywords: string[];
}

export interface ChunkAssignment {
    chunkIndex: number;
    estimatedTokens: number;
    agentId: string;
    agentRole: string;
    provider: string;
    affinityScore: number;
    rlScore?: number;
    nodeHeadroom?: number;
    isSpillover?: boolean;
    allocatedTokens: number;
    reason: string;
}

export interface SpecialistRoutingPlan {
    totalChunks: number;
    totalEstimatedTokens: number;
    assignments: ChunkAssignment[];
    specialistSummary: Record<string, {
        role: string;
        chunksAssigned: number;
        tokensAllocated: number;
        nodeHeadroom?: number;
        isSaturated?: boolean;
    }>;
}

export interface SpecialistCandidate {
    id?: string;
    role: string;
    provider: string;
}

/**
 * Evaluates semantic affinity between task content and specialist roles,
 * factoring in token budgets and load to produce optimal chunk distributions.
 */
export class SpecialistAffinityRouter {
    private domainRules: SpecialistDomainRule[] = [
        {
            domain: 'Security & Auth',
            roleKeywords: ['security', 'auth', 'secops', 'crypt', 'compliance', 'cve', 'vulnerability', 'auditor'],
            taskKeywords: ['security', 'auth', 'token', 'jwt', 'vulnerability', 'cve', 'exploit', 'injection', 'permission', 'credential', 'attack', 'firewall', 'secret', 'breach', 'xss', 'csrf', 'tls', 'ssl', 'sanitize', 'password', 'oauth', 'acl', 'encryption']
        },
        {
            domain: 'Performance & Latency',
            roleKeywords: ['performance', 'optimization', 'latency', 'speed', 'scale', 'resource', 'infra', 'profiler'],
            taskKeywords: ['latency', 'throughput', 'memory', 'cpu', 'bottleneck', 'slow', 'cache', 'speed', 'profiling', 'optimization', 'tpm', 'timeout', 'concurrency', 'leak', 'benchmark', 'load', 'allocat', 'scale', 'io']
        },
        {
            domain: 'Data & Schema',
            roleKeywords: ['data', 'schema', 'sql', 'database', 'etl', 'analyst', 'modeler'],
            taskKeywords: ['schema', 'csv', 'json', 'sql', 'database', 'query', 'table', 'columns', 'records', 'aggregat', 'metrics', 'rows', 'transform', 'field', 'migration', 'index', 'relational', 'document', 'dataset']
        },
        {
            domain: 'Architecture & System Design',
            roleKeywords: ['architect', 'design', 'lead', 'system', 'core', 'orchestrator'],
            taskKeywords: ['architecture', 'design', 'system', 'orchestrat', 'state', 'pipeline', 'component', 'workflow', 'service', 'event', 'microservice', 'distributed', 'consensus', 'cluster', 'failover', 'topology']
        },
        {
            domain: 'Code & Syntax',
            roleKeywords: ['developer', 'engineer', 'code', 'syntax', 'debugger', 'tester'],
            taskKeywords: ['function', 'syntax', 'typescript', 'python', 'code', 'stack trace', 'error', 'bug', 'exception', 'compile', 'lint', 'class', 'method', 'runtime', 'nullpointer', 'typeerror', 'import', 'export']
        }
    ];

    private tokenManager: TokenBudgetManager;
    private loadBalancer: AdaptiveLoadBalancer;
    private capabilityProfiler: SpecialistCapabilityProfiler;
    private capacityManager: NodeCapacityManager;

    constructor(
        tokenManager?: TokenBudgetManager,
        loadBalancer?: AdaptiveLoadBalancer,
        capabilityProfiler?: SpecialistCapabilityProfiler,
        capacityManager?: NodeCapacityManager
    ) {
        this.tokenManager = tokenManager || globalTokenBudgetManager;
        this.loadBalancer = loadBalancer || globalLoadBalancer;
        this.capabilityProfiler = capabilityProfiler || globalSpecialistProfiler;
        this.capacityManager = capacityManager || globalNodeCapacityManager;
    }

    /**
     * Calculates affinity score (0.0 to 1.0) between an agent's role and a task / data payload.
     */
    scoreAffinity(agentRole: string, content: string): { score: number; matchedDomain?: string } {
        const roleLower = (agentRole || '').toLowerCase();
        const contentLower = (content || '').toLowerCase();

        let bestScore = 0.1;
        let matchedDomain: string | undefined = undefined;

        for (const rule of this.domainRules) {
            const roleMatches = rule.roleKeywords.some(rk => roleLower.includes(rk));
            if (!roleMatches) continue;

            let matchHits = 0;
            for (const tk of rule.taskKeywords) {
                if (contentLower.includes(tk)) {
                    matchHits++;
                }
            }

            if (matchHits > 0) {
                const keywordStrength = matchHits / (matchHits + 2);
                const score = 0.4 + (keywordStrength * 0.6);
                if (score > bestScore) {
                    bestScore = score;
                    matchedDomain = rule.domain;
                }
            } else {
                if (0.3 > bestScore) {
                    bestScore = 0.3;
                    matchedDomain = rule.domain;
                }
            }
        }

        if (bestScore === 0.1 && (roleLower.includes('analyst') || roleLower.includes('specialist'))) {
            bestScore = 0.25;
        }

        return { score: Math.round(bestScore * 100) / 100, matchedDomain };
    }

    /**
     * Generates a balanced, token-aware, capacity-governed assignment plan for chunks across specialist agents.
     * Prevents node saturation and dynamically spills over tasks to available candidate nodes.
     */
    planDistribution<T extends SpecialistCandidate>(task: string, chunks: string[], agents: T[]): SpecialistRoutingPlan {
        if (!agents || agents.length === 0) {
            throw new Error('No agents available for dynamic specialist routing');
        }

        const assignments: ChunkAssignment[] = [];
        const specialistSummary: Record<string, {
            role: string;
            chunksAssigned: number;
            tokensAllocated: number;
            nodeHeadroom?: number;
            isSaturated?: boolean;
        }> = {};
        
        for (const a of agents) {
            const nodeKey = a.id || a.role;
            const initHeadroom = Math.min(
                this.capacityManager.getCapacityHeadroom(nodeKey),
                this.capacityManager.getCapacityHeadroom(a.provider)
            );
            specialistSummary[a.role] = {
                role: a.role,
                chunksAssigned: 0,
                tokensAllocated: 0,
                nodeHeadroom: initHeadroom,
                isSaturated: initHeadroom <= 0
            };
        }

        let totalEstTokens = 0;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const estTokens = Math.max(10, Math.ceil(chunk.length / 4));
            totalEstTokens += estTokens;
            const combinedContent = `${task}\n${chunk}`;

            const candidates = agents.map(agent => {
                const nodeKey = agent.id || agent.role;
                const { score: affinity, matchedDomain } = this.scoreAffinity(agent.role, combinedContent);

                const currentAssigned = specialistSummary[agent.role]?.chunksAssigned || 0;
                const rawNodeHeadroom = this.capacityManager.getCapacityHeadroom(nodeKey);
                const rawProvHeadroom = this.capacityManager.getCapacityHeadroom(agent.provider);
                const baseHeadroom = Math.min(rawNodeHeadroom, rawProvHeadroom);
                const effectiveHeadroom = Math.max(0, baseHeadroom - currentAssigned);

                const maxConcurrency = Math.min(
                    this.capacityManager.getMaxConcurrency(nodeKey),
                    this.capacityManager.getMaxConcurrency(agent.provider)
                );
                const activeInFlight = Math.max(
                    this.capacityManager.getActiveInFlight(nodeKey),
                    this.capacityManager.getActiveInFlight(agent.provider)
                );
                const effectiveUtilization = maxConcurrency > 0
                    ? Math.min(1.0, (activeInFlight + currentAssigned) / maxConcurrency)
                    : 1.0;

                const isNodeSaturated = effectiveHeadroom <= 0 ||
                    this.capacityManager.isSaturated(nodeKey) ||
                    this.capacityManager.isSaturated(agent.provider);

                // Node capacity score: heavily downrank saturated nodes to spill over
                const nodeCapacityScore = isNodeSaturated ? 0.01 : Math.max(0.1, 1.0 - effectiveUtilization);

                // Token budget capacity score
                const provRemaining = this.tokenManager.getRemainingBudget(agent.provider);
                const provUtilization = this.tokenManager.getUtilizationRatio(agent.provider);
                const tokenCapacityScore = provRemaining < estTokens ? 0.05 : (1.0 - provUtilization * 0.5);

                // Combined capacity score (50% node concurrency headroom + 50% token budget)
                const capacityScore = (nodeCapacityScore * 0.50) + (tokenCapacityScore * 0.50);

                // Workload distribution: balance number of chunks assigned per agent
                const balanceScore = 1.0 / (1 + currentAssigned * 0.5);

                // RL Capability Score (UCB1)
                const ucbScore = this.capabilityProfiler.getUcb1Score(agent.role, matchedDomain);
                const normalizedUcb = Math.min(1.0, Math.max(0.05, ucbScore / 1.5));

                // 30% affinity + 25% RL capability (UCB1) + 30% capacity (node + token) + 15% workload distribution
                const combinedScore = (affinity * 0.30) + (normalizedUcb * 0.25) + (capacityScore * 0.30) + (balanceScore * 0.15);

                return {
                    agent,
                    nodeKey,
                    affinity,
                    matchedDomain,
                    effectiveHeadroom,
                    isNodeSaturated,
                    nodeCapacityScore,
                    tokenCapacityScore,
                    capacityScore,
                    combinedScore,
                    normalizedUcb,
                    ucbScore,
                    provRemaining
                };
            });

            candidates.sort((a, b) => b.combinedScore - a.combinedScore);
            const best = candidates[0];
            const chosen = best.agent;

            // Detect whether spillover occurred from a saturated candidate with equal or higher affinity
            const saturatedCandidates = candidates.filter(c => c.isNodeSaturated);
            const spilloverFrom = saturatedCandidates.find(c => c.agent !== chosen && c.affinity >= best.affinity - 0.05);
            const isSpillover = !!spilloverFrom;

            let reason = '';
            if (isSpillover && spilloverFrom) {
                reason = `Spillover reroute: '${spilloverFrom.agent.role}' capacity saturated (0 headroom); allocated to '${chosen.role}' (headroom ${best.effectiveHeadroom})`;
            } else if (best.matchedDomain) {
                reason = `Matched '${best.matchedDomain}' (affinity ${(best.affinity * 100).toFixed(0)}%, headroom ${best.effectiveHeadroom}, RL UCB ${(best.normalizedUcb * 100).toFixed(0)}%)`;
            } else {
                reason = `Capacity allocation (headroom ${best.effectiveHeadroom}, RL UCB ${(best.normalizedUcb * 100).toFixed(0)}%)`;
            }

            assignments.push({
                chunkIndex: i,
                estimatedTokens: estTokens,
                agentId: chosen.id || chosen.role,
                agentRole: chosen.role,
                provider: chosen.provider,
                affinityScore: best.affinity,
                rlScore: Math.round(best.normalizedUcb * 100) / 100,
                nodeHeadroom: best.effectiveHeadroom,
                isSpillover,
                allocatedTokens: estTokens,
                reason
            });

            specialistSummary[chosen.role].chunksAssigned++;
            specialistSummary[chosen.role].tokensAllocated += estTokens;
            specialistSummary[chosen.role].nodeHeadroom = Math.max(0, best.effectiveHeadroom - 1);
            specialistSummary[chosen.role].isSaturated = specialistSummary[chosen.role].nodeHeadroom <= 0;

            this.tokenManager.recordUsage(chosen.provider, estTokens, chosen.role);
        }

        return {
            totalChunks: chunks.length,
            totalEstimatedTokens: totalEstTokens,
            assignments,
            specialistSummary
        };
    }
}

export const globalSpecialistRouter = new SpecialistAffinityRouter();
