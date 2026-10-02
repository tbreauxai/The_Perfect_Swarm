import type {
    CircuitState,
    ModelCircuitBreakerConfig,
    ModelCircuitBreakerStats
} from './types.ts';

/**
 * Circuit Breaker pattern to protect against repeatedly failing model endpoints.
 */
export class ModelCircuitBreaker {
    private failureThreshold: number;
    private resetTimeoutMs: number;
    private successThreshold: number;
    private records: Map<string, {
        state: CircuitState;
        consecutiveFailures: number;
        consecutiveSuccesses: number;
        lastFailureTime?: number;
        lastSuccessTime?: number;
        nextAttemptTime?: number;
    }> = new Map();

    constructor(config?: ModelCircuitBreakerConfig) {
        this.failureThreshold = config?.failureThreshold ?? 3;
        this.resetTimeoutMs = config?.resetTimeoutMs ?? 30000;
        this.successThreshold = config?.successThreshold ?? 1;
    }

    public getKey(provider: string, modelId: string): string {
        return `${provider.toLowerCase().trim()}:${modelId.trim()}`;
    }

    public getState(provider: string, modelId: string): CircuitState {
        const key = this.getKey(provider, modelId);
        const record = this.records.get(key);
        if (!record) return 'CLOSED';

        if (record.state === 'OPEN') {
            const now = Date.now();
            if (record.nextAttemptTime && now >= record.nextAttemptTime) {
                record.state = 'HALF_OPEN';
                record.consecutiveSuccesses = 0;
                return 'HALF_OPEN';
            }
        }
        return record.state;
    }

    public isAvailable(provider: string, modelId: string): boolean {
        const state = this.getState(provider, modelId);
        return state === 'CLOSED' || state === 'HALF_OPEN';
    }

    public recordSuccess(provider: string, modelId: string): void {
        const key = this.getKey(provider, modelId);
        const record = this.records.get(key) || {
            state: 'CLOSED',
            consecutiveFailures: 0,
            consecutiveSuccesses: 0
        };

        record.consecutiveSuccesses++;
        record.lastSuccessTime = Date.now();

        if (record.state === 'HALF_OPEN') {
            if (record.consecutiveSuccesses >= this.successThreshold) {
                record.state = 'CLOSED';
                record.consecutiveFailures = 0;
                record.nextAttemptTime = undefined;
            }
        } else {
            record.consecutiveFailures = 0;
        }

        this.records.set(key, record);
    }

    public recordFailure(provider: string, modelId: string, _error?: any): void {
        const key = this.getKey(provider, modelId);
        const record = this.records.get(key) || {
            state: 'CLOSED',
            consecutiveFailures: 0,
            consecutiveSuccesses: 0
        };

        record.consecutiveFailures++;
        record.lastFailureTime = Date.now();
        record.consecutiveSuccesses = 0;

        if (record.state === 'HALF_OPEN' || record.consecutiveFailures >= this.failureThreshold) {
            record.state = 'OPEN';
            record.nextAttemptTime = Date.now() + this.resetTimeoutMs;
        }

        this.records.set(key, record);
    }

    public reset(provider: string, modelId: string): void {
        this.records.delete(this.getKey(provider, modelId));
    }

    public resetAll(): void {
        this.records.clear();
    }

    public getStats(provider: string, modelId: string): ModelCircuitBreakerStats {
        const state = this.getState(provider, modelId);
        const record = this.records.get(this.getKey(provider, modelId));
        return {
            state,
            failureCount: record?.consecutiveFailures ?? 0,
            successCount: record?.consecutiveSuccesses ?? 0,
            lastFailureTime: record?.lastFailureTime,
            lastSuccessTime: record?.lastSuccessTime,
            nextAttemptTime: record?.nextAttemptTime
        };
    }
}
