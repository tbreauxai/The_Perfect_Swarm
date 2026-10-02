export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'UNCHECKED';

export interface ModelCircuitBreakerConfig {
    /** Number of consecutive failures to trip circuit breaker from CLOSED to OPEN (default: 3) */
    failureThreshold?: number;
    /** Cooldown duration in ms before moving from OPEN to HALF_OPEN (default: 30,000ms = 30s) */
    resetTimeoutMs?: number;
    /** Number of consecutive successes in HALF_OPEN to reset circuit breaker to CLOSED (default: 1) */
    successThreshold?: number;
}

export interface ModelCircuitBreakerStats {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime?: number;
    lastSuccessTime?: number;
    nextAttemptTime?: number;
}

export interface ModelHealthStatus {
    modelId: string;
    provider: string;
    healthy: boolean;
    latencyMs: number | null;
    tier1Success: boolean; // Lightweight HEAD / metadata reachability check
    tier2Success: boolean; // Minimal inference ping check
    circuitState: CircuitState;
    lastChecked: number;
    expiresAt: number;
    error?: string;
    note?: string;
}

export interface HealthCheckOptions {
    /** Overall health check timeout in ms (default: 2500ms; satisfies 2-3s requirement) */
    timeoutMs?: number;
    /** Cache TTL in ms (default: 300,000ms = 5m; satisfies 5-10m requirement) */
    ttlMs?: number;
    /** Maximum parallel concurrent checks (default: 8) */
    maxConcurrency?: number;
    /** Bypass cache and force fresh check */
    forceRefresh?: boolean;
    /** Skip tier 2 checks */
    skipTier2?: boolean;
    /** Custom Tier 1 check hook */
    customTier1Check?: (provider: string, modelId: string, apiKey?: string, signal?: AbortSignal) => Promise<boolean>;
    /** Custom Tier 2 check hook */
    customTier2Check?: (provider: string, modelId: string, apiKey?: string, signal?: AbortSignal) => Promise<boolean>;
}

export interface ModelTarget {
    provider: string;
    modelId: string;
    apiKey?: string;
}
