import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AdaptiveLoadBalancer, parseRetryAfterMs, globalLoadBalancer } from './adaptiveLoadBalancer.ts';
import type { Provider, ProviderCredential } from '../types.ts';

describe('parseRetryAfterMs', () => {
    it('returns default cooldown for empty or undefined error', () => {
        expect(parseRetryAfterMs(null, 5000)).toBe(5000);
        expect(parseRetryAfterMs(undefined, 5000)).toBe(5000);
    });

    it('extracts from retryAfterMs property', () => {
        expect(parseRetryAfterMs({ retryAfterMs: 4000 })).toBe(4000);
    });

    it('extracts from retryAfter property (seconds)', () => {
        expect(parseRetryAfterMs({ retryAfter: 4 })).toBe(4000);
    });

    it('extracts from HTTP header retry-after (seconds)', () => {
        const err = {
            headers: new Headers({ 'retry-after': '6' })
        };
        expect(parseRetryAfterMs(err)).toBe(6000);
    });

    it('extracts from HTTP header retry-after (date)', () => {
        const futureDate = new Date(Date.now() + 10000).toUTCString();
        const err = {
            headers: new Headers({ 'retry-after': futureDate })
        };
        const res = parseRetryAfterMs(err);
        // Date parsing precision can be off by a few ms
        expect(res).toBeGreaterThanOrEqual(9000);
        expect(res).toBeLessThanOrEqual(11000);
    });

    it('extracts from string message with different units', () => {
        expect(parseRetryAfterMs({ message: 'try again in 5s' })).toBe(5000);
        expect(parseRetryAfterMs(new Error('wait 3000ms'))).toBe(3000);
        // default maxCooldownMs is 60000. So 2m will be clamped to 60000.
        expect(parseRetryAfterMs('retry-after: 2m')).toBe(60000);
    });

    it('clamps values between min and max cooldown', () => {
        expect(parseRetryAfterMs({ retryAfterMs: 500 }, 15000, 1000, 60000)).toBe(1000);
        expect(parseRetryAfterMs({ retryAfterMs: 120000 }, 15000, 1000, 60000)).toBe(60000);
    });
});

describe('AdaptiveLoadBalancer', () => {
    let lb: AdaptiveLoadBalancer;

    beforeEach(() => {
        lb = new AdaptiveLoadBalancer({
            emaAlpha: 0.5,
            inFlightPenaltyMs: 100,
            rateLimitCooldownMs: 10000,
            degradedThresholdErrors: 2
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('initializes telemetry correctly for a new provider', () => {
        const t = lb.getTelemetry('openai');
        expect(t.provider).toBe('openai');
        expect(t.status).toBe('healthy');
        expect(t.inFlightRequests).toBe(0);
        expect(t.successCount).toBe(0);
    });

    it('records and retrieves rewards', () => {
        lb.recordReward('anthropic', 0.9);
        // The implementation initializes rewardScore to 0.85
        // clamped = 0.9
        // ((0.85 * 0.7) + (0.9 * 0.3)) = 0.595 + 0.27 = 0.865
        expect(lb.getReward('anthropic')).toBeCloseTo(0.865);

        // Successive rewards are smoothed
        lb.recordReward('anthropic', 0.4);
        const newReward = lb.getReward('anthropic');
        expect(newReward).toBeLessThan(0.865);
    });

    it('records start, success, and updates EMA', () => {
        lb.recordStart('gemini');
        expect(lb.getTelemetry('gemini').inFlightRequests).toBe(1);

        lb.recordSuccess('gemini', 200); // Initial EMA is 400. alpha is 0.5. new = 0.5 * 200 + 0.5 * 400 = 300
        const t = lb.getTelemetry('gemini');
        expect(t.inFlightRequests).toBe(0);
        expect(t.successCount).toBe(1);
        expect(t.latencyEmaMs).toBe(300);
        expect(t.status).toBe('healthy');
    });

    it('handles failures, rate limits, and timeouts properly', () => {
        lb.recordStart('local');
        lb.recordFailure('local', new Error('timeout'));
        let t = lb.getTelemetry('local');
        expect(t.status).toBe('degraded');
        expect(t.failureCount).toBe(1);

        lb.recordStart('local2');
        lb.recordFailure('local2', new Error('429 Too Many Requests, try again in 5s'));
        t = lb.getTelemetry('local2');
        expect(t.status).toBe('cooldown');
        expect(t.rateLimitCount).toBe(1);
        expect(t.cooldownUntil).toBe(Date.now() + 5000);
    });

    it('calculates score correctly prioritizing health and latency', () => {
        lb.recordStart('p1');
        lb.recordSuccess('p1', 100); // Good provider

        lb.recordStart('p2');
        lb.recordFailure('p2', new Error('timeout')); // Degraded

        lb.recordStart('p3');
        lb.recordFailure('p3', new Error('429 too many requests')); // Cooldown

        const s1 = lb.calculateScore('p1');
        const s2 = lb.calculateScore('p2');
        const s3 = lb.calculateScore('p3');

        expect(s1).toBeGreaterThan(s2);
        expect(s2).toBeGreaterThan(s3);
    });

    it('selectOptimalProvider selects highest score', () => {
        const candidates: ProviderCredential[] = [
            { provider: 'p1', apiKey: 'a' },
            { provider: 'p2', apiKey: 'b' },
            { provider: 'p3', apiKey: 'c' }
        ];

        lb.recordStart('p1');
        lb.recordFailure('p1', new Error('429'));

        lb.recordStart('p2');
        lb.recordFailure('p2', new Error('timeout'));

        lb.recordStart('p3');
        lb.recordSuccess('p3', 100);

        const optimal = lb.selectOptimalProvider(candidates);
        expect(optimal.provider).toBe('p3');
    });

    it('throws when selectOptimalProvider has empty array', () => {
        expect(() => lb.selectOptimalProvider([])).toThrow();
    });

    it('returns immediately for single candidate in selectOptimalProvider', () => {
        const candidates: ProviderCredential[] = [
            { provider: 'p1', apiKey: 'a' }
        ];
        lb.recordStart('p1');
        lb.recordFailure('p1', new Error('429'));

        const optimal = lb.selectOptimalProvider(candidates);
        expect(optimal.provider).toBe('p1');
    });

    it('executeWithTelemetry runs function and tracks metrics on success', async () => {
        const result = await lb.executeWithTelemetry('test-p', async () => {
            return 'ok';
        });
        expect(result).toBe('ok');
        const t = lb.getTelemetry('test-p');
        expect(t.successCount).toBe(1);
        expect(t.inFlightRequests).toBe(0);
    });

    it('executeWithTelemetry propagates error and tracks failure', async () => {
        await expect(lb.executeWithTelemetry('test-p-err', async () => {
            throw new Error('timeout');
        })).rejects.toThrow('timeout');

        const t = lb.getTelemetry('test-p-err');
        expect(t.failureCount).toBe(1);
        expect(t.status).toBe('degraded');
    });

    it('reset clears all telemetry', () => {
        lb.recordStart('test');
        lb.reset();
        const all = lb.getAllTelemetry();
        expect(Object.keys(all).length).toBe(0);
    });
});
