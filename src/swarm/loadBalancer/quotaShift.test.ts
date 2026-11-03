import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetManager, globalTokenBudgetManager } from './tokenBudgetManager.ts';
import { AdaptiveLoadBalancer } from './adaptiveLoadBalancer.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Quota Shift & TokenBudgetManager Rate Limit Header Sync', () => {
    let budgetManager: TokenBudgetManager;

    beforeEach(() => {
        budgetManager = new TokenBudgetManager({
            defaultTpmLimit: 10000,
            providerTpmLimits: {
                groq: 6000,
                mistral: 30000
            }
        });
    });

    it('applyProviderHeaders reads x-ratelimit-remaining-tokens and sets remaining budget', () => {
        expect(budgetManager.getRemainingBudget('groq')).toBe(6000);

        // Simulate provider response header indicating 1,200 remaining tokens
        budgetManager.applyProviderHeaders('groq', {
            'x-ratelimit-remaining-tokens': '1200',
            'x-ratelimit-reset-requests': '2.5'
        });

        expect(budgetManager.getRemainingBudget('groq')).toBe(1200);
        expect(budgetManager.canAllocate('groq', 1000)).toBe(true);
        expect(budgetManager.canAllocate('groq', 1500)).toBe(false);
    });

    it('remaining tokens below the next prompt shift the seat', async () => {
        let primaryCalled = false;
        let backupCalled = false;

        ProviderRegistry.register({
            providerName: 'seat-shift-primary',
            async call() {
                primaryCalled = true;
                return JSON.stringify({ result: 'primary' });
            }
        });

        ProviderRegistry.register({
            providerName: 'seat-shift-backup',
            async call() {
                backupCalled = true;
                return JSON.stringify({ result: 'backup' });
            }
        });

        // Throttle primary provider so remaining tokens (50) < prompt tokens (~200)
        globalTokenBudgetManager.setTpmLimit('seat-shift-primary', 6000);
        globalTokenBudgetManager.applyProviderHeaders('seat-shift-primary', {
            'x-ratelimit-remaining-tokens': '50'
        });
        globalTokenBudgetManager.setTpmLimit('seat-shift-backup', 30000);

        const agent = new Agent('Analyst Node', 'model-primary', 'seat-shift-primary', 'k', undefined, [
            { provider: 'seat-shift-backup', modelName: 'model-backup', apiKey: 'k' }
        ]);

        const context = new SwarmContext();
        const prompt = 'Please analyze this market data in detail and produce a complete evaluation report. '.repeat(10);
        const result = await agent.run(prompt, context);

        // Primary provider must NOT have been called due to proactive seat shift
        expect(primaryCalled).toBe(false);
        // Backup provider was called
        expect(backupCalled).toBe(true);
        expect(result).toBeDefined();
    });

    it('daily-limit response sets a breaker until reset time', () => {
        const lb = new AdaptiveLoadBalancer();
        const provider = 'mock-daily-provider';

        // Initial score is healthy
        const initialScore = lb.calculateScore(provider);
        expect(initialScore).toBeGreaterThan(0);

        // Record a daily limit failure
        lb.recordFailure(provider, new Error('429 Daily request quota exceeded. Reset in 3600s'));

        const telemetry = lb.getTelemetry(provider);
        expect(telemetry.status).toBe('cooldown');
        expect(telemetry.cooldownUntil).toBeGreaterThan(Date.now() + 3000000);

        // Heavily penalized score preventing selection
        const penalizedScore = lb.calculateScore(provider);
        expect(penalizedScore).toBeLessThan(0);
    });
});
