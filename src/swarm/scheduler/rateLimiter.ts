import type { ProviderRateLimitProfile } from './types.ts';

/**
 * Token Bucket & Sliding Window Rate Limiter.
 * Tracks Requests Per Minute (RPM) and Tokens Per Minute (TPM) per provider,
 * calculating required backpressure delays to avoid 429 quota exhaustion.
 */
export class TokenBucketRateLimiter {
    private profiles: Map<string, ProviderRateLimitProfile> = new Map();
    private requestBuckets: Map<string, { count: number; lastReplenishMs: number }> = new Map();
    private tokenBuckets: Map<string, { tokens: number; lastReplenishMs: number }> = new Map();

    constructor(customLimits?: Record<string, Partial<ProviderRateLimitProfile>>) {
        // Calibrated baseline free-tier rate limits:
        const defaults: Record<string, ProviderRateLimitProfile> = {
            groq: { maxRpm: 30, maxTpm: 6000 },
            mistral: { maxRpm: 60, maxTpm: 12000 },
            github: { maxRpm: 15, maxTpm: 8000 },
            openrouter: { maxRpm: 60, maxTpm: 15000 },
            gemini: { maxRpm: 120, maxTpm: 30000 },
            simulated: { maxRpm: 10000, maxTpm: 1000000 },
            mock: { maxRpm: 10000, maxTpm: 1000000 },
            default: { maxRpm: 60, maxTpm: 10000 }
        };

        for (const [k, v] of Object.entries(defaults)) {
            this.profiles.set(k.toLowerCase(), v);
        }

        if (customLimits) {
            for (const [k, v] of Object.entries(customLimits)) {
                const def = this.getProfile(k);
                this.profiles.set(k.toLowerCase(), {
                    maxRpm: v.maxRpm ?? def.maxRpm,
                    maxTpm: v.maxTpm ?? def.maxTpm
                });
            }
        }
    }

    private normalizeKey(provider?: string): string {
        return (provider || 'default').toLowerCase().trim();
    }

    getProfile(provider?: string): ProviderRateLimitProfile {
        const key = this.normalizeKey(provider);
        return this.profiles.get(key) ?? this.profiles.get('default')!;
    }

    setProfile(provider: string, profile: Partial<ProviderRateLimitProfile>): void {
        const key = this.normalizeKey(provider);
        const curr = this.getProfile(key);
        this.profiles.set(key, {
            maxRpm: profile.maxRpm ?? curr.maxRpm,
            maxTpm: profile.maxTpm ?? curr.maxTpm
        });
    }

    private replenish(provider: string, now: number): { requestTokens: number; tokenAllowance: number } {
        const key = this.normalizeKey(provider);
        const profile = this.getProfile(key);

        // Replenish request bucket
        let reqBucket = this.requestBuckets.get(key);
        if (!reqBucket) {
            reqBucket = { count: profile.maxRpm, lastReplenishMs: now };
            this.requestBuckets.set(key, reqBucket);
        } else {
            const elapsed = Math.max(0, now - reqBucket.lastReplenishMs);
            const added = (elapsed / 60000) * profile.maxRpm;
            reqBucket.count = Math.min(profile.maxRpm, reqBucket.count + added);
            reqBucket.lastReplenishMs = now;
        }

        // Replenish token bucket
        let tokBucket = this.tokenBuckets.get(key);
        if (!tokBucket) {
            tokBucket = { tokens: profile.maxTpm, lastReplenishMs: now };
            this.tokenBuckets.set(key, tokBucket);
        } else {
            const elapsed = Math.max(0, now - tokBucket.lastReplenishMs);
            const added = (elapsed / 60000) * profile.maxTpm;
            tokBucket.tokens = Math.min(profile.maxTpm, tokBucket.tokens + added);
            tokBucket.lastReplenishMs = now;
        }

        return { requestTokens: reqBucket.count, tokenAllowance: tokBucket.tokens };
    }

    /**
     * Calculates delay in milliseconds needed before acquiring tokens for provider.
     * Returns 0 if sufficient capacity is currently available.
     */
    getDelayUntilAvailable(provider?: string, estimatedTokens: number = 200, now: number = Date.now()): number {
        const key = this.normalizeKey(provider);
        const profile = this.getProfile(key);
        const { requestTokens, tokenAllowance } = this.replenish(key, now);

        let delayMs = 0;

        if (requestTokens < 1) {
            const neededReqs = 1 - requestTokens;
            const reqDelay = (neededReqs / profile.maxRpm) * 60000;
            delayMs = Math.max(delayMs, reqDelay);
        }

        if (tokenAllowance < estimatedTokens) {
            const neededTokens = estimatedTokens - tokenAllowance;
            const tokDelay = (neededTokens / profile.maxTpm) * 60000;
            delayMs = Math.max(delayMs, tokDelay);
        }

        return Math.ceil(delayMs);
    }

    canAcquire(provider?: string, estimatedTokens: number = 200, now: number = Date.now()): boolean {
        return this.getDelayUntilAvailable(provider, estimatedTokens, now) === 0;
    }

    /**
     * Consumes tokens for a scheduled execution if available.
     * Returns true if successfully acquired, false if rate limit would be exceeded.
     */
    acquire(provider?: string, estimatedTokens: number = 200, now: number = Date.now()): boolean {
        const key = this.normalizeKey(provider);
        if (!this.canAcquire(key, estimatedTokens, now)) {
            return false;
        }

        const reqBucket = this.requestBuckets.get(key)!;
        const tokBucket = this.tokenBuckets.get(key)!;

        reqBucket.count = Math.max(0, reqBucket.count - 1);
        tokBucket.tokens = Math.max(0, tokBucket.tokens - estimatedTokens);

        return true;
    }

    reset(): void {
        this.requestBuckets.clear();
        this.tokenBuckets.clear();
    }
}
