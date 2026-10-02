/**
 * Predictive Latency Model using Exponential Weighted Moving Averages (EWMA).
 * Predicts task execution latency based on domain, provider, and estimated token length.
 */
export class PredictiveLatencyModel {
    private emaLatencies: Map<string, number> = new Map();
    private alpha: number;
    private tokenCostFactorMs: number;

    constructor(alpha: number = 0.3, tokenCostFactorMs: number = 0.15) {
        this.alpha = alpha;
        this.tokenCostFactorMs = tokenCostFactorMs;
    }

    private makeKey(domain?: string, provider?: string): string {
        const d = (domain || 'general').toLowerCase();
        const p = (provider || 'default').toLowerCase();
        return `${d}:${p}`;
    }

    predictDurationMs(domain?: string, provider?: string, estimatedTokens: number = 200): number {
        const key = this.makeKey(domain, provider);
        const provKey = (provider || 'default').toLowerCase();

        const baseLatency = this.emaLatencies.get(key)
            ?? this.emaLatencies.get(provKey)
            ?? 400; // Default estimate 400ms

        const tokenExtra = estimatedTokens * this.tokenCostFactorMs;
        return Math.round(baseLatency + tokenExtra);
    }

    recordCompletion(domain: string | undefined, provider: string | undefined, estimatedTokens: number, actualDurationMs: number): void {
        const key = this.makeKey(domain, provider);
        const provKey = (provider || 'default').toLowerCase();

        const prevKey = this.emaLatencies.get(key);
        if (prevKey === undefined) {
            this.emaLatencies.set(key, actualDurationMs);
        } else {
            this.emaLatencies.set(key, Math.round((this.alpha * actualDurationMs) + ((1 - this.alpha) * prevKey)));
        }

        const prevProv = this.emaLatencies.get(provKey);
        if (prevProv === undefined) {
            this.emaLatencies.set(provKey, actualDurationMs);
        } else {
            this.emaLatencies.set(provKey, Math.round((this.alpha * actualDurationMs) + ((1 - this.alpha) * prevProv)));
        }
    }

    reset(): void {
        this.emaLatencies.clear();
    }
}
