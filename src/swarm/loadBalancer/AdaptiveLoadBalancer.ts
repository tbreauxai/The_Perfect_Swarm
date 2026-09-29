import { ProviderTelemetry, LoadBalancerConfig, TokenBudgetConfig, TokenUsageRecord, TokenBudgetMetrics, NodeCapacityConfig, CapacitySlot, NodeCapacityMetrics, SpecialistOutcomeFeedback, DomainCapabilityStats, SpecialistCapabilityProfile, CapabilityProfilerConfig, SpecialistDomainRule, ChunkAssignment, SpecialistRoutingPlan, SpecialistCandidate, ProviderHealthStatus } from "./types.ts";
import { Provider, ProviderCredential } from "../types.ts";

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
        if (t.cooldownUntil && now < t.cooldownUntil) {
            return -1000 + (t.cooldownUntil - now) * -0.1; // heavily penalized
        }

        const effectiveLatency = Math.max(50, t.latencyEmaMs + (t.inFlightRequests * this.inFlightPenaltyMs));
        let score = 100000 / effectiveLatency;
        if (t.status === 'degraded') {
            score *= 0.3;
        }

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
        t.latencyEmaMs = Math.round((this.emaAlpha * durationMs) + ((1 - this.emaAlpha) * t.latencyEmaMs));
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
