import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    ModelCircuitBreaker,
    ModelHealthCache,
    TwoTierModelHealthChecker,
    type ModelTarget
} from './health.ts';

describe('Model Health Checker & Circuit Breaker', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('ModelCircuitBreaker', () => {
        it('initializes in CLOSED state and allows traffic', () => {
            const breaker = new ModelCircuitBreaker({ failureThreshold: 3 });
            expect(breaker.getState('gemini', 'gemini-2.5-flash')).toBe('CLOSED');
            expect(breaker.isAvailable('gemini', 'gemini-2.5-flash')).toBe(true);
        });

        it('trips from CLOSED to OPEN after failureThreshold consecutive failures', () => {
            const breaker = new ModelCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
            
            breaker.recordFailure('groq', 'llama-3.3-70b');
            expect(breaker.getState('groq', 'llama-3.3-70b')).toBe('CLOSED');
            expect(breaker.isAvailable('groq', 'llama-3.3-70b')).toBe(true);

            breaker.recordFailure('groq', 'llama-3.3-70b');
            expect(breaker.getState('groq', 'llama-3.3-70b')).toBe('CLOSED');

            breaker.recordFailure('groq', 'llama-3.3-70b'); // 3rd failure trips
            expect(breaker.getState('groq', 'llama-3.3-70b')).toBe('OPEN');
            expect(breaker.isAvailable('groq', 'llama-3.3-70b')).toBe(false);
        });

        it('recovers to HALF_OPEN after cooldown and resets to CLOSED on success', async () => {
            const breaker = new ModelCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });

            breaker.recordFailure('mistral', 'mistral-large');
            breaker.recordFailure('mistral', 'mistral-large');
            expect(breaker.getState('mistral', 'mistral-large')).toBe('OPEN');

            // Wait for cooldown
            await new Promise(r => setTimeout(r, 60));

            expect(breaker.getState('mistral', 'mistral-large')).toBe('HALF_OPEN');
            expect(breaker.isAvailable('mistral', 'mistral-large')).toBe(true);

            // Success closes the breaker
            breaker.recordSuccess('mistral', 'mistral-large');
            expect(breaker.getState('mistral', 'mistral-large')).toBe('CLOSED');
            expect(breaker.isAvailable('mistral', 'mistral-large')).toBe(true);
        });

        it('re-trips to OPEN immediately if probe fails in HALF_OPEN', async () => {
            const breaker = new ModelCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });

            breaker.recordFailure('github', 'gpt-4o');
            breaker.recordFailure('github', 'gpt-4o');
            expect(breaker.getState('github', 'gpt-4o')).toBe('OPEN');

            await new Promise(r => setTimeout(r, 60));
            expect(breaker.getState('github', 'gpt-4o')).toBe('HALF_OPEN');

            // Probe fails
            breaker.recordFailure('github', 'gpt-4o');
            expect(breaker.getState('github', 'gpt-4o')).toBe('OPEN');
            expect(breaker.isAvailable('github', 'gpt-4o')).toBe(false);
        });

        it('provides stats on failure counts and state transitions', () => {
            const breaker = new ModelCircuitBreaker({ failureThreshold: 3 });
            breaker.recordFailure('openrouter', 'anthropic/claude-3.5-sonnet');
            breaker.recordFailure('openrouter', 'anthropic/claude-3.5-sonnet');

            const stats = breaker.getStats('openrouter', 'anthropic/claude-3.5-sonnet');
            expect(stats.state).toBe('CLOSED');
            expect(stats.failureCount).toBe(2);
            expect(stats.successCount).toBe(0);
            expect(stats.lastFailureTime).toBeDefined();
        });
    });

    describe('ModelHealthCache', () => {
        it('enforces 5-10 minute TTL bounds by default', () => {
            const cache = new ModelHealthCache(60000); // requested 1m -> clamped to 5m (300000ms)
            const status = {
                modelId: 'test-model',
                provider: 'test',
                healthy: true,
                latencyMs: 50,
                tier1Success: true,
                tier2Success: true,
                circuitState: 'CLOSED' as const,
                lastChecked: Date.now(),
                expiresAt: 0
            };

            cache.set('test', 'test-model', status);
            const cached = cache.get('test', 'test-model');
            expect(cached).toBeDefined();
            // Expiry should be ~300000ms from now
            expect(cached!.expiresAt - cached!.lastChecked).toBeGreaterThanOrEqual(300000);
            expect(cached!.expiresAt - cached!.lastChecked).toBeLessThanOrEqual(600000);
        });

        it('returns undefined for expired items', () => {
            const cache = new ModelHealthCache(300000);
            const now = Date.now();
            const expiredStatus = {
                modelId: 'exp-model',
                provider: 'test',
                healthy: true,
                latencyMs: 20,
                tier1Success: true,
                tier2Success: true,
                circuitState: 'CLOSED' as const,
                lastChecked: now - 400000,
                expiresAt: now - 1000 // expired
            };

            cache.set('test', 'exp-model', expiredStatus);
            // Manually overwrite expiresAt in map to simulate clock passage
            (cache as any).cache.set('test:exp-model', expiredStatus);

            expect(cache.get('test', 'exp-model')).toBeUndefined();
            expect(cache.hasValid('test', 'exp-model')).toBe(false);
        });

        it('invalidates and clears cached entries cleanly', () => {
            const cache = new ModelHealthCache();
            const status = {
                modelId: 'm1',
                provider: 'p1',
                healthy: true,
                latencyMs: 10,
                tier1Success: true,
                tier2Success: true,
                circuitState: 'CLOSED' as const,
                lastChecked: Date.now(),
                expiresAt: Date.now() + 300000
            };

            cache.set('p1', 'm1', status);
            expect(cache.hasValid('p1', 'm1')).toBe(true);

            cache.invalidate('p1', 'm1');
            expect(cache.hasValid('p1', 'm1')).toBe(false);

            cache.set('p1', 'm1', status);
            cache.clear();
            expect(cache.size()).toBe(0);
        });
    });

    describe('TwoTierModelHealthChecker', () => {
        it('verifies simulated provider immediately as healthy', async () => {
            const checker = new TwoTierModelHealthChecker();
            const result = await checker.checkModel({ provider: 'simulated', modelId: 'simulated-v1' });

            expect(result.healthy).toBe(true);
            expect(result.tier1Success).toBe(true);
            expect(result.tier2Success).toBe(true);
            expect(result.circuitState).toBe('CLOSED');
        });

        it('skips Tier 2 when Tier 1 HEAD check fails', async () => {
            const checker = new TwoTierModelHealthChecker({ failureThreshold: 3 });
            let tier1Called = false;
            let tier2Called = false;

            const result = await checker.checkModel(
                { provider: 'custom', modelId: 'model-fail-t1' },
                {
                    customTier1Check: async () => {
                        tier1Called = true;
                        return false; // Tier 1 fails
                    },
                    customTier2Check: async () => {
                        tier2Called = true;
                        return true;
                    }
                }
            );

            expect(tier1Called).toBe(true);
            expect(tier2Called).toBe(false); // MUST skip Tier 2
            expect(result.healthy).toBe(false);
            expect(result.tier1Success).toBe(false);
            expect(result.tier2Success).toBe(false);
            expect(result.error).toContain('Tier 1');
        });

        it('runs Tier 2 when Tier 1 succeeds, and marks healthy if both pass', async () => {
            const checker = new TwoTierModelHealthChecker();
            let tier1Called = false;
            let tier2Called = false;

            const result = await checker.checkModel(
                { provider: 'custom', modelId: 'model-pass-both' },
                {
                    customTier1Check: async () => {
                        tier1Called = true;
                        return true;
                    },
                    customTier2Check: async () => {
                        tier2Called = true;
                        return true;
                    }
                }
            );

            expect(tier1Called).toBe(true);
            expect(tier2Called).toBe(true);
            expect(result.healthy).toBe(true);
            expect(result.tier1Success).toBe(true);
            expect(result.tier2Success).toBe(true);
        });

        it('aborts check when timeout is exceeded (short timeout requirement)', async () => {
            const checker = new TwoTierModelHealthChecker();

            const startTime = Date.now();
            const result = await checker.checkModel(
                { provider: 'custom', modelId: 'model-hanging' },
                {
                    timeoutMs: 150, // fast timeout for test
                    customTier1Check: async (_p, _m, _k, signal) => {
                        return new Promise((resolve, reject) => {
                            const timer = setTimeout(() => resolve(true), 1000);
                            signal?.addEventListener('abort', () => {
                                clearTimeout(timer);
                                reject(new Error('AbortError'));
                            });
                        });
                    }
                }
            );
            const duration = Date.now() - startTime;

            expect(result.healthy).toBe(false);
            expect(duration).toBeLessThan(600);
            expect(result.error).toBeDefined();
        });

        it('immediately returns OPEN without hitting network when circuit breaker is tripped', async () => {
            const checker = new TwoTierModelHealthChecker({ failureThreshold: 2 });
            let networkCallCount = 0;

            const opts = {
                customTier1Check: async () => {
                    networkCallCount++;
                    return false;
                }
            };

            // Fail twice to trip circuit breaker
            await checker.checkModel({ provider: 'groq', modelId: 'flaky-model' }, opts);
            await checker.checkModel({ provider: 'groq', modelId: 'flaky-model' }, { ...opts, forceRefresh: true });

            expect(checker.circuitBreaker.getState('groq', 'flaky-model')).toBe('OPEN');
            expect(networkCallCount).toBe(2);

            // 3rd call must short-circuit without incrementing networkCallCount
            const thirdResult = await checker.checkModel({ provider: 'groq', modelId: 'flaky-model' }, { ...opts, forceRefresh: true });
            expect(networkCallCount).toBe(2);
            expect(thirdResult.circuitState).toBe('OPEN');
            expect(thirdResult.healthy).toBe(false);
            expect(thirdResult.error).toContain('Circuit breaker is OPEN');
        });

        it('executes parallel async health checks across multiple models', async () => {
            const checker = new TwoTierModelHealthChecker();
            const targets: ModelTarget[] = [
                { provider: 'p1', modelId: 'm1' },
                { provider: 'p1', modelId: 'm2' },
                { provider: 'p2', modelId: 'm3' },
                { provider: 'simulated', modelId: 'm4' }
            ];

            const results = await checker.checkModelsInParallel(targets, {
                customTier1Check: async (_p, id) => id !== 'm2', // m2 fails tier 1
                customTier2Check: async () => true
            });

            expect(results.size).toBe(4);
            expect(results.get('p1:m1')?.healthy).toBe(true);
            expect(results.get('p1:m2')?.healthy).toBe(false);
            expect(results.get('p2:m3')?.healthy).toBe(true);
            expect(results.get('simulated:m4')?.healthy).toBe(true);
        });
    });
});
