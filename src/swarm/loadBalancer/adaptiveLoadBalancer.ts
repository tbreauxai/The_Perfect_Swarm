import type { Provider, ProviderCredential } from '../types.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';
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
    rewardScore?: number;
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
 * Parses dynamic retry-after or rate-limit wait duration from an error object or error message.
 * Supports standard HTTP retry-after headers, numeric milliseconds/seconds properties,
 * and text-based retry directives (e.g., 'try again in 2s', 'wait 15 seconds', 'retry-after: 5').
 * Clamps result between minCooldownMs (default: 1000) and maxCooldownMs (default: 60000).
 */
export function parseRetryAfterMs(
    error: any,
    defaultCooldownMs: number = 15000,
    minCooldownMs: number = 1000,
    maxCooldownMs: number = 60000
): number {
    if (!error) return defaultCooldownMs;

    // 1. Explicit properties on error object
    if (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) {
        return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(error.retryAfterMs)));
    }
    if (typeof error.retryAfter === 'number' && error.retryAfter > 0) {
        return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(error.retryAfter * 1000)));
    }

    // 2. HTTP response headers on error
    const headerVal = error.headers?.get ? error.headers.get('retry-after') : error.headers?.['retry-after'];
    if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
        const sec = parseFloat(headerVal);
        if (!isNaN(sec) && sec > 0) {
            return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(sec * 1000)));
        }
        const dateMs = Date.parse(headerVal);
        if (!isNaN(dateMs) && dateMs > Date.now()) {
            return Math.max(minCooldownMs, Math.min(maxCooldownMs, dateMs - Date.now()));
        }
    }

    // 3. String regex matching from error message
    const errMsg = String(error?.message || error || '');
    const match = errMsg.match(/(?:retry-after|retry after|try again in|wait|retry_after)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|m|min|minutes|s|sec|seconds)?/i);
    if (match) {
        const val = parseFloat(match[1]);
        if (!isNaN(val) && val > 0) {
            const unit = (match[2] || 's').toLowerCase();
            let ms = val * 1000;
            if (unit === 'ms') {
                ms = val;
            } else if (unit.startsWith('m')) {
                ms = val * 60 * 1000;
            }
            return Math.max(minCooldownMs, Math.min(maxCooldownMs, Math.round(ms)));
        }
    }

    return defaultCooldownMs;
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
                rateLimitCount: 0,
                rewardScore: 0.85
            };
            this.telemetry.set(key, t);
        }
        return t;
    }

    /**
     * Records reinforcement learning reward signal for a provider.
     * Higher reward boosts provider priority during failover cascades.
     */
    recordReward(provider: Provider, reward: number): void {
        const t = this.getOrCreateTelemetry(provider);
        const clamped = Math.max(0.0, Math.min(1.0, reward));
        t.rewardScore = t.rewardScore !== undefined
            ? Math.round(((t.rewardScore * 0.70) + (clamped * 0.30)) * 1000) / 1000
            : clamped;
    }

    getReward(provider: Provider): number {
        const t = this.getOrCreateTelemetry(provider);
        return t.rewardScore ?? 0.85;
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

        // Higher RL reward elevates provider priority during failover cascades
        const rewardMultiplier = t.rewardScore !== undefined ? 0.5 + (t.rewardScore * 0.5) : 0.925;
        score *= rewardMultiplier;

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
            const cooldownDuration = parseRetryAfterMs(error, this.rateLimitCooldownMs);
            t.cooldownUntil = Date.now() + cooldownDuration;
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
