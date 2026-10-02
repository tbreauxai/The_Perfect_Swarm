import type {
    ModelCircuitBreakerConfig,
    ModelHealthStatus,
    HealthCheckOptions,
    ModelTarget
} from './types.ts';
import { ModelCircuitBreaker } from './circuitBreaker.ts';
import { ModelHealthCache } from './healthCache.ts';

/**
 * Two-Tier Model Health Checker:
 * - Tier 1: Lightweight HEAD / metadata request
 * - Tier 2: Minimal inference ping
 * Supports parallel async checks, 2-3s short timeouts, 5-10m TTL caching, and circuit breaker.
 */
export class TwoTierModelHealthChecker {
    public circuitBreaker: ModelCircuitBreaker;
    public cache: ModelHealthCache;

    constructor(
        breakerConfig?: ModelCircuitBreakerConfig,
        defaultTtlMs: number = 5 * 60 * 1000
    ) {
        this.circuitBreaker = new ModelCircuitBreaker(breakerConfig);
        this.cache = new ModelHealthCache(defaultTtlMs);
    }

    /**
     * Executes a two-tier health check for a single model with a 2-3s timeout.
     */
    public async checkModel(
        target: ModelTarget,
        options?: HealthCheckOptions
    ): Promise<ModelHealthStatus> {
        const { provider, modelId, apiKey } = target;
        const timeoutMs = options?.timeoutMs ?? 2500; // 2.5s default (within 2-3s requirement)
        const ttlMs = options?.ttlMs;
        const forceRefresh = options?.forceRefresh ?? false;

        // 1. Check cache if not forcing refresh
        if (!forceRefresh) {
            const cached = this.cache.get(provider, modelId);
            if (cached) {
                // Attach real-time circuit state
                return {
                    ...cached,
                    circuitState: this.circuitBreaker.getState(provider, modelId)
                };
            }
        }

        // 2. Check circuit breaker state: if OPEN, fail immediately without hitting network
        const circuitState = this.circuitBreaker.getState(provider, modelId);
        if (circuitState === 'OPEN') {
            const openStatus: ModelHealthStatus = {
                modelId,
                provider,
                healthy: false,
                latencyMs: 0,
                tier1Success: false,
                tier2Success: false,
                circuitState: 'OPEN',
                lastChecked: Date.now(),
                expiresAt: Date.now() + (ttlMs ?? 300000),
                error: 'Circuit breaker is OPEN (repeated failures)'
            };
            this.cache.set(provider, modelId, openStatus, ttlMs);
            return openStatus;
        }

        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            // Simulated provider is always healthy
            if (provider === 'simulated' || provider === 'mock') {
                clearTimeout(timeoutId);
                const status: ModelHealthStatus = {
                    modelId,
                    provider,
                    healthy: true,
                    latencyMs: Date.now() - startTime,
                    tier1Success: true,
                    tier2Success: true,
                    circuitState: this.circuitBreaker.getState(provider, modelId),
                    lastChecked: Date.now(),
                    expiresAt: Date.now() + (ttlMs ?? 300000)
                };
                this.circuitBreaker.recordSuccess(provider, modelId);
                this.cache.set(provider, modelId, status, ttlMs);
                return status;
            }

            // Tier 1: Lightweight HEAD / metadata request
            let tier1Pass = false;
            try {
                tier1Pass = options?.customTier1Check
                    ? await options.customTier1Check(provider, modelId, apiKey, controller.signal)
                    : await this.defaultTier1Check(provider, modelId, apiKey, controller.signal);
            } catch {
                tier1Pass = false;
            }

            if (!tier1Pass) {
                clearTimeout(timeoutId);
                this.circuitBreaker.recordFailure(provider, modelId);
                const status: ModelHealthStatus = {
                    modelId,
                    provider,
                    healthy: false,
                    latencyMs: Date.now() - startTime,
                    tier1Success: false,
                    tier2Success: false, // Skipped because Tier 1 failed
                    circuitState: this.circuitBreaker.getState(provider, modelId),
                    lastChecked: Date.now(),
                    expiresAt: Date.now() + (ttlMs ?? 300000),
                    error: 'Tier 1 HEAD / metadata check failed or timed out'
                };
                this.cache.set(provider, modelId, status, ttlMs);
                return status;
            }

            // Tier 2: Minimal inference ping (only if Tier 1 passed)
            let tier2Pass = false;
            if (options?.skipTier2) {
                tier2Pass = true; // skip = assume passed if tier 1 passed
            } else {
                try {
                    tier2Pass = options?.customTier2Check
                        ? await options.customTier2Check(provider, modelId, apiKey, controller.signal)
                        : await this.defaultTier2Check(provider, modelId, apiKey, controller.signal);
                } catch {
                    tier2Pass = false;
                }
            }

            clearTimeout(timeoutId);
            const latencyMs = Date.now() - startTime;

            if (!tier2Pass) {
                this.circuitBreaker.recordFailure(provider, modelId);
                const status: ModelHealthStatus = {
                    modelId,
                    provider,
                    healthy: false,
                    latencyMs,
                    tier1Success: true,
                    tier2Success: false,
                    circuitState: this.circuitBreaker.getState(provider, modelId),
                    lastChecked: Date.now(),
                    expiresAt: Date.now() + (ttlMs ?? 300000),
                    error: 'Tier 2 minimal inference ping failed'
                };
                this.cache.set(provider, modelId, status, ttlMs);
                return status;
            }

            // Both tiers passed
            this.circuitBreaker.recordSuccess(provider, modelId);
            const status: ModelHealthStatus = {
                modelId,
                provider,
                healthy: true,
                latencyMs,
                tier1Success: true,
                tier2Success: true,
                circuitState: this.circuitBreaker.getState(provider, modelId),
                lastChecked: Date.now(),
                expiresAt: Date.now() + (ttlMs ?? 300000)
            };
            this.cache.set(provider, modelId, status, ttlMs);
            return status;

        } catch (err: any) {
            clearTimeout(timeoutId);
            const isTimeout = err?.name === 'AbortError' || controller.signal.aborted;
            this.circuitBreaker.recordFailure(provider, modelId, err);
            const status: ModelHealthStatus = {
                modelId,
                provider,
                healthy: false,
                latencyMs: Date.now() - startTime,
                tier1Success: false,
                tier2Success: false,
                circuitState: this.circuitBreaker.getState(provider, modelId),
                lastChecked: Date.now(),
                expiresAt: Date.now() + (ttlMs ?? 300000),
                error: isTimeout ? `Health check timed out after ${timeoutMs}ms` : (err?.message || 'Health check error')
            };
            this.cache.set(provider, modelId, status, ttlMs);
            return status;
        }
    }

    /**
     * Executes parallel async health checks for multiple models with concurrency control.
     */
    public async checkModelsInParallel(
        targets: ModelTarget[],
        options?: HealthCheckOptions
    ): Promise<Map<string, ModelHealthStatus>> {
        const results = new Map<string, ModelHealthStatus>();
        if (!targets || targets.length === 0) return results;

        const maxConcurrency = Math.max(1, options?.maxConcurrency ?? 8);
        let currentIndex = 0;

        const worker = async () => {
            while (currentIndex < targets.length) {
                const index = currentIndex++;
                const target = targets[index];
                if (!target) break;
                const status = await this.checkModel(target, options);
                const key = this.circuitBreaker.getKey(target.provider, target.modelId);
                results.set(key, status);
            }
        };

        const workers = Array.from({ length: Math.min(maxConcurrency, targets.length) }, () => worker());
        await Promise.all(workers);

        return results;
    }

    /**
     * Default Tier 1 check: lightweight HEAD or metadata endpoint.
     */
    private async defaultTier1Check(
        provider: string,
        modelId: string,
        apiKey?: string,
        signal?: AbortSignal
    ): Promise<boolean> {
        try {
            switch (provider) {
                case 'openrouter': {
                    const res = await fetch('https://openrouter.ai/api/v1/models', {
                        method: 'HEAD',
                        signal
                    });
                    return res.ok || res.status === 405 || res.status === 200;
                }
                case 'groq': {
                    if (!apiKey) return false;
                    const res = await fetch(`https://api.groq.com/openai/v1/models/${encodeURIComponent(modelId)}`, {
                        method: 'HEAD',
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                        signal
                    });
                    return res.ok || res.status === 200 || res.status === 405;
                }
                case 'gemini': {
                    if (!apiKey) return false;
                    const cleanModel = modelId.replace('models/', '');
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}?key=${apiKey}`, {
                        method: 'GET',
                        signal
                    });
                    return res.ok;
                }
                case 'mistral': {
                    if (!apiKey) return false;
                    const res = await fetch(`https://api.mistral.ai/v1/models/${encodeURIComponent(modelId)}`, {
                        method: 'GET',
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                        signal
                    });
                    return res.ok;
                }
                case 'github': {
                    if (!apiKey) return false;
                    const res = await fetch('https://models.inference.ai.azure.com/models', {
                        method: 'HEAD',
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                        signal
                    });
                    return res.ok || res.status === 405 || res.status === 200;
                }
                default:
                    return true;
            }
        } catch {
            return false;
        }
    }

    /**
     * Default Tier 2 check: minimal inference ping.
     */
    private async defaultTier2Check(
        provider: string,
        modelId: string,
        apiKey?: string,
        signal?: AbortSignal
    ): Promise<boolean> {
        try {
            switch (provider) {
                case 'openrouter': {
                    if (!apiKey) return true; // Can't ping inference without key, treat Tier 1 as sufficient
                    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: modelId,
                            messages: [{ role: 'user', content: 'ping' }],
                            max_tokens: 1
                        }),
                        signal
                    });
                    return res.ok;
                }
                case 'groq': {
                    if (!apiKey) return false;
                    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: modelId,
                            messages: [{ role: 'user', content: 'ping' }],
                            max_tokens: 1
                        }),
                        signal
                    });
                    return res.ok;
                }
                case 'gemini': {
                    if (!apiKey) return false;
                    const cleanModel = modelId.replace('models/', '');
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: 'ping' }] }],
                            generationConfig: { maxOutputTokens: 1 }
                        }),
                        signal
                    });
                    return res.ok;
                }
                case 'mistral': {
                    if (!apiKey) return false;
                    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: modelId,
                            messages: [{ role: 'user', content: 'ping' }],
                            max_tokens: 1
                        }),
                        signal
                    });
                    return res.ok;
                }
                case 'github': {
                    if (!apiKey) return false;
                    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: modelId,
                            messages: [{ role: 'user', content: 'ping' }],
                            max_tokens: 1
                        }),
                        signal
                    });
                    return res.ok;
                }
                default:
                    return true;
            }
        } catch {
            return false;
        }
    }
}
