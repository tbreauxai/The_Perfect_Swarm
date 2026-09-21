/**
 * Live Telemetry Metrics Collector for AI Swarm Optimizer Dashboard
 * Tracks request latency (sliding window), request counts, LLM token usage, and cache metrics.
 */

export interface TelemetrySnapshot {
    totalRequests: number;
    successCount: number;
    failureCount: number;
    totalTokensBurned: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    overallLatency: {
        mean: number;
        p95: number;
        p99: number;
    };
    cacheHitRatio: number;
    errorRate: number;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    provider: string;
    model: string;
    estimatedCostUsd: number;
}

export interface RequestLatencySample {
    timestamp: number;
    durationMs: number;
    success: boolean;
    path: string;
}

const SLIDING_WINDOW_SIZE = 500;

// Cost per 1K tokens for different providers (approximate, in USD)
const PROVIDER_COST_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
    'gemini': { prompt: 0.000075, completion: 0.0003 }, // Gemini 1.5 Flash free tier
    'groq': { prompt: 0.0, completion: 0.0 }, // Free tier
    'openrouter': { prompt: 0.0001, completion: 0.0003 }, // Varies by model
    'mistral': { prompt: 0.00025, completion: 0.00025 },
    'github': { prompt: 0.0, completion: 0.0 }, // Free tier
    'simulated': { prompt: 0.0, completion: 0.0 },
    'default': { prompt: 0.00015, completion: 0.0006 }
};

export class TelemetryMetricsCollector {
    private static instance: TelemetryMetricsCollector;
    
    // Sliding window for request latencies (last 500 requests)
    private requestLatencies: RequestLatencySample[] = [];
    
    // Request counters
    private totalRequests: number = 0;
    private successCount: number = 0;
    private failureCount: number = 0;
    
    // LLM Token tracking
    private totalPromptTokens: number = 0;
    private totalCompletionTokens: number = 0;
    private totalTokensBurned: number = 0;
    private estimatedCostUsd: number = 0;
    
    // Token usage history for debugging
    private tokenUsageHistory: TokenUsage[] = [];
    
    // Cache metrics
    private cacheHits: number = 0;
    private cacheMisses: number = 0;

    private constructor() {}

    public static getInstance(): TelemetryMetricsCollector {
        if (!TelemetryMetricsCollector.instance) {
            TelemetryMetricsCollector.instance = new TelemetryMetricsCollector();
        }
        return TelemetryMetricsCollector.instance;
    }

    /**
     * Records an HTTP request latency sample
     */
    public recordRequest(params: {
        durationMs: number;
        success: boolean;
        path: string;
    }): void {
        const sample: RequestLatencySample = {
            timestamp: Date.now(),
            durationMs: Math.max(0, Math.round(params.durationMs)),
            success: params.success,
            path: params.path
        };

        this.requestLatencies.push(sample);
        this.totalRequests++;
        
        if (params.success) {
            this.successCount++;
        } else {
            this.failureCount++;
        }

        // Maintain sliding window of last 500 requests
        if (this.requestLatencies.length > SLIDING_WINDOW_SIZE) {
            this.requestLatencies.shift();
        }
    }

    /**
     * Records LLM token usage from a provider response
     */
    public recordTokenUsage(params: {
        promptTokens: number;
        completionTokens: number;
        provider: string;
        model: string;
    }): void {
        const promptTokens = Math.max(0, Math.round(params.promptTokens));
        const completionTokens = Math.max(0, Math.round(params.completionTokens));
        const totalTokens = promptTokens + completionTokens;

        this.totalPromptTokens += promptTokens;
        this.totalCompletionTokens += completionTokens;
        this.totalTokensBurned += totalTokens;

        // Calculate estimated cost
        const providerKey = params.provider.toLowerCase();
        const costRates = PROVIDER_COST_PER_1K_TOKENS[providerKey] || PROVIDER_COST_PER_1K_TOKENS.default;
        const cost = (promptTokens / 1000) * costRates.prompt + (completionTokens / 1000) * costRates.completion;
        this.estimatedCostUsd += cost;

        // Store in history (keep last 1000 entries)
        this.tokenUsageHistory.push({
            promptTokens,
            completionTokens,
            totalTokens,
            provider: params.provider,
            model: params.model,
            estimatedCostUsd: cost
        });
        if (this.tokenUsageHistory.length > 1000) {
            this.tokenUsageHistory.shift();
        }
    }

    /**
     * Records a cache hit
     */
    public recordCacheHit(): void {
        this.cacheHits++;
    }

    /**
     * Records a cache miss
     */
    public recordCacheMiss(): void {
        this.cacheMisses++;
    }

    /**
     * Gets cache hit ratio (0-1)
     */
    public getCacheHitRatio(): number {
        const total = this.cacheHits + this.cacheMisses;
        if (total === 0) return 0;
        return Number((this.cacheHits / total).toFixed(4));
    }

    /**
     * Calculates latency percentiles from sliding window
     */
    private calculateLatencyPercentiles(): { mean: number; p95: number; p99: number } {
        if (this.requestLatencies.length === 0) {
            return { mean: 0, p95: 0, p99: 0 };
        }

        const durations = this.requestLatencies.map(s => s.durationMs).sort((a, b) => a - b);
        const count = durations.length;
        const sum = durations.reduce((acc, v) => acc + v, 0);
        const mean = sum / count;

        const getPercentile = (p: number): number => {
            const idx = Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
            return durations[idx];
        };

        return {
            mean: Number(mean.toFixed(2)),
            p95: getPercentile(95),
            p99: getPercentile(99)
        };
    }

    /**
     * Gets the current telemetry snapshot matching the required schema
     */
    public getSnapshot(): TelemetrySnapshot {
        const latency = this.calculateLatencyPercentiles();
        const errorRate = this.totalRequests > 0 
            ? Number((this.failureCount / this.totalRequests).toFixed(4))
            : 0;

        return {
            totalRequests: this.totalRequests,
            successCount: this.successCount,
            failureCount: this.failureCount,
            totalTokensBurned: this.totalTokensBurned,
            promptTokens: this.totalPromptTokens,
            completionTokens: this.totalCompletionTokens,
            estimatedCostUsd: Number(this.estimatedCostUsd.toFixed(6)),
            overallLatency: latency,
            cacheHitRatio: this.getCacheHitRatio(),
            errorRate
        };
    }

    /**
     * Resets all metrics
     */
    public reset(): void {
        this.requestLatencies = [];
        this.totalRequests = 0;
        this.successCount = 0;
        this.failureCount = 0;
        this.totalPromptTokens = 0;
        this.totalCompletionTokens = 0;
        this.totalTokensBurned = 0;
        this.estimatedCostUsd = 0;
        this.tokenUsageHistory = [];
        this.cacheHits = 0;
        this.cacheMisses = 0;
    }

    /**
     * Syncs cache metrics from external cache instances
     */
    public syncCacheMetrics(hits: number, misses: number): void {
        this.cacheHits = hits;
        this.cacheMisses = misses;
    }
}

export const globalTelemetryCollector = TelemetryMetricsCollector.getInstance();

/**
 * Middleware function to track request latency for Hono routes
 */
export function createTelemetryMiddleware(collector: TelemetryMetricsCollector = globalTelemetryCollector) {
    return async (c: any, next: any) => {
        const startTime = Date.now();
        const path = c.req.path;
        
        try {
            await next();
            const durationMs = Date.now() - startTime;
            const success = c.res.status < 400;
            collector.recordRequest({
                durationMs,
                success,
                path
            });
        } catch (err) {
            const durationMs = Date.now() - startTime;
            collector.recordRequest({
                durationMs,
                success: false,
                path
            });
            throw err;
        }
    };
}

/**
 * Extracts token usage from various provider response formats
 */
export function extractTokenUsage(response: any, provider: string): { promptTokens: number; completionTokens: number } | null {
    if (!response) return null;

    try {
        switch (provider.toLowerCase()) {
            case 'gemini':
                if (response.usageMetadata) {
                    return {
                        promptTokens: response.usageMetadata.promptTokenCount || 0,
                        completionTokens: response.usageMetadata.candidatesTokenCount || 0
                    };
                }
                break;
                
            case 'groq':
            case 'openrouter':
            case 'mistral':
            case 'github':
                if (response.usage) {
                    return {
                        promptTokens: response.usage.prompt_tokens || 0,
                        completionTokens: response.usage.completion_tokens || 0
                    };
                }
                break;
        }
    } catch (e) {
        // Silently fail - token tracking is best effort
    }
    
    return null;
}

/**
 * Estimates tokens from text when provider doesn't return usage
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}
