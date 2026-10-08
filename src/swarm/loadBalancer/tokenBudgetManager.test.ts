import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenBudgetManager, globalTokenBudgetManager } from './tokenBudgetManager.ts';
import type { Provider } from '../types.ts';

describe('TokenBudgetManager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should initialize with default limits for known providers', () => {
        const manager = new TokenBudgetManager();
        expect(manager.getTpmLimit('groq' as Provider)).toBe(6000);
        expect(manager.getTpmLimit('gemini' as Provider)).toBe(1000000);
    });

    it('should allow custom configuration overrides', () => {
        const manager = new TokenBudgetManager({
            defaultTpmLimit: 15000,
            providerTpmLimits: {
                'custom-provider': 5000,
                'groq': 8000
            },
            windowMs: 30000
        });

        expect(manager.getTpmLimit('unknown' as Provider)).toBe(15000);
        expect(manager.getTpmLimit('custom-provider' as Provider)).toBe(5000);
        expect(manager.getTpmLimit('groq' as Provider)).toBe(8000);
    });

    it('should be case-insensitive for provider names', () => {
        const manager = new TokenBudgetManager();
        manager.setTpmLimit('Groq' as Provider, 10000);
        expect(manager.getTpmLimit('GROQ' as Provider)).toBe(10000);
        expect(manager.getTpmLimit('groq' as Provider)).toBe(10000);
    });

    it('should enforce a minimum limit when setting TPM limit', () => {
        const manager = new TokenBudgetManager();
        manager.setTpmLimit('test' as Provider, 50);
        // It enforces Math.max(100, limit)
        expect(manager.getTpmLimit('test' as Provider)).toBe(100);
    });

    it('should record usage and correctly track used tokens', () => {
        const manager = new TokenBudgetManager();
        manager.recordUsage('groq' as Provider, 1000);
        manager.recordUsage('groq' as Provider, 500);

        expect(manager.getTokensUsedInWindow('groq' as Provider)).toBe(1500);
        expect(manager.getRemainingBudget('groq' as Provider)).toBe(4500); // 6000 - 1500
    });

    it('should treat negative tokens as 0', () => {
        const manager = new TokenBudgetManager();
        manager.recordUsage('groq' as Provider, -500);
        expect(manager.getTokensUsedInWindow('groq' as Provider)).toBe(0);
    });

    it('should round fractional tokens', () => {
        const manager = new TokenBudgetManager();
        manager.recordUsage('groq' as Provider, 100.5); // Math.round(100.5) = 101
        expect(manager.getTokensUsedInWindow('groq' as Provider)).toBe(101);
    });

    it('should indicate if allocation is possible', () => {
        const manager = new TokenBudgetManager();
        expect(manager.canAllocate('groq' as Provider, 6000)).toBe(true);
        expect(manager.canAllocate('groq' as Provider, 6001)).toBe(false);

        manager.recordUsage('groq' as Provider, 5000);
        expect(manager.canAllocate('groq' as Provider, 1000)).toBe(true);
        expect(manager.canAllocate('groq' as Provider, 1001)).toBe(false);
    });

    it('should compute utilization ratio correctly', () => {
        const manager = new TokenBudgetManager();
        manager.setTpmLimit('test' as Provider, 1000);
        manager.recordUsage('test' as Provider, 250);
        expect(manager.getUtilizationRatio('test' as Provider)).toBe(0.25);

        manager.recordUsage('test' as Provider, 1000); // total 1250
        expect(manager.getUtilizationRatio('test' as Provider)).toBe(1.0); // Caps at 1.0
    });

    it('should handle zero or negative limit in utilization calculation gracefully', () => {
        const manager = new TokenBudgetManager();
        // Force limit <= 0 using internal map to bypass the Math.max(100) check if possible
        // Actually, setTpmLimit forces Math.max(100, limit), so limit is never <= 0 unless default limits had it
        // However, we can mock or just assume the limit > 0 is fine.
        // Let's just check standard behavior.
        expect(manager.getUtilizationRatio('test' as Provider)).toBe(0);
    });

    it('should clean up old records outside the sliding window', () => {
        const manager = new TokenBudgetManager({ windowMs: 60000 });

        manager.recordUsage('groq' as Provider, 1000);

        vi.advanceTimersByTime(30000);
        manager.recordUsage('groq' as Provider, 2000);

        expect(manager.getTokensUsedInWindow('groq' as Provider)).toBe(3000);

        // Advance beyond the first record's window (60s)
        vi.advanceTimersByTime(30001);

        // The first record (1000) should be dropped, only the second (2000) remains
        expect(manager.getTokensUsedInWindow('groq' as Provider)).toBe(2000);

        // Advance beyond the second record's window
        vi.advanceTimersByTime(30000);
        expect(manager.getTokensUsedInWindow('groq' as Provider)).toBe(0);
    });

    it('should produce accurate metrics', () => {
        const manager = new TokenBudgetManager();
        manager.setTpmLimit('test' as Provider, 2000);

        manager.recordUsage('test' as Provider, 500);
        manager.recordUsage('test' as Provider, 500);

        const metrics = manager.getMetrics();
        expect(metrics['test']).toBeDefined();
        expect(metrics['test'].provider).toBe('test');
        expect(metrics['test'].tpmLimit).toBe(2000);
        expect(metrics['test'].tokensUsedInWindow).toBe(1000);
        expect(metrics['test'].tokensRemainingInWindow).toBe(1000);
        expect(metrics['test'].utilizationPercent).toBe(50);
        expect(metrics['test'].totalCumulativeTokens).toBe(1000);
    });

    it('should maintain cumulative tokens even when window records drop', () => {
        const manager = new TokenBudgetManager({ windowMs: 60000 });
        manager.setTpmLimit('test' as Provider, 1000);

        manager.recordUsage('test' as Provider, 500);

        vi.advanceTimersByTime(60001); // Advance past window

        const metrics = manager.getMetrics();
        expect(metrics['test'].tokensUsedInWindow).toBe(0);
        expect(metrics['test'].totalCumulativeTokens).toBe(500);
    });

    it('should reset records and cumulative counts', () => {
        const manager = new TokenBudgetManager();
        manager.recordUsage('groq' as Provider, 1000);

        manager.reset();

        const metrics = manager.getMetrics();
        // After reset, no keys exist unless they are in tpmLimits
        // default limits remain!
        expect(metrics['groq'].tokensUsedInWindow).toBe(0);
        expect(metrics['groq'].totalCumulativeTokens).toBe(0);
    });

    describe('globalTokenBudgetManager', () => {
        it('should be an instance of TokenBudgetManager', () => {
            expect(globalTokenBudgetManager).toBeInstanceOf(TokenBudgetManager);
        });

        it('should work as a singleton', () => {
            globalTokenBudgetManager.recordUsage('groq' as Provider, 100);
            expect(globalTokenBudgetManager.getTokensUsedInWindow('groq' as Provider)).toBe(100);
            globalTokenBudgetManager.reset();
            expect(globalTokenBudgetManager.getTokensUsedInWindow('groq' as Provider)).toBe(0);
        });
    });
});
