import { describe, it, expect } from 'vitest';
import { djb2Hash, djb2Index } from './hash.ts';
import { clampProbability, logit, sigmoid, invLogit } from '../math/probabilityMath.ts';
import { TokenEstimator } from '../compression/tokenEstimator.ts';
import { parseRetryAfterHeader, parseRetryAfterMs } from './httpTimeouts.ts';

describe('Foundational Utilities Deduplication (Goal 1)', () => {
    describe('djb2Hash & djb2Index', () => {
        it('computes deterministic signed 32-bit hashes', () => {
            const h1 = djb2Hash('test_key_123');
            const h2 = djb2Hash('test_key_123');
            expect(h1).toBe(h2);
            expect(typeof h1).toBe('number');
            expect(h1).not.toBe(0);
        });

        it('returns bounded non-negative modulo index', () => {
            const vocabSize = 10000;
            const index = djb2Index('anomalous_token', vocabSize);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(index).toBeLessThan(vocabSize);
        });

        it('handles empty and special characters cleanly', () => {
            expect(djb2Hash('')).toBe(5381);
            expect(djb2Index('', 100)).toBe(5381 % 100);
            expect(djb2Index('invalid_size', 0)).toBe(0);
        });
    });

    describe('Probability Math (clampProbability, logit, sigmoid, invLogit)', () => {
        it('clamps probabilities and normalizes percentage values', () => {
            expect(clampProbability(0.5)).toBe(0.5);
            expect(clampProbability(0)).toBe(0.01);
            expect(clampProbability(1)).toBe(0.99);
            expect(clampProbability(75)).toBe(0.75);
            expect(clampProbability(NaN)).toBe(0.5);
            expect(clampProbability(Infinity)).toBe(0.5);
        });

        it('converts between probability and logit bidirectionally', () => {
            const originalProb = 0.72;
            const logOdds = logit(originalProb);
            const recoveredProb = sigmoid(logOdds);
            expect(Math.abs(recoveredProb - originalProb)).toBeLessThan(0.001);
        });

        it('handles extreme logit values without overflow', () => {
            expect(sigmoid(100)).toBeCloseTo(1, 2);
            expect(sigmoid(-100)).toBeCloseTo(0, 2);
            expect(invLogit(0)).toBe(0.5);
        });
    });

    describe('TokenEstimator Unified Methods', () => {
        it('estimates tokens from character count using configurable divisor', () => {
            expect(TokenEstimator.estimateFromChars(400)).toBe(100);
            expect(TokenEstimator.estimateFromChars(401)).toBe(101);
            expect(TokenEstimator.estimateFromChars(380, 3.8)).toBe(100);
            expect(TokenEstimator.estimateFromChars(0)).toBe(0);
        });

        it('estimates tokens from text using countTokens', () => {
            const count = TokenEstimator.estimateFromText('Hello world from the swarm token estimator');
            expect(count).toBeGreaterThan(5);
        });
    });

    describe('HTTP Timeouts & Retry-After Parser', () => {
        it('parses numeric seconds from headers', () => {
            expect(parseRetryAfterHeader('5')).toBe(5000);
            expect(parseRetryAfterHeader('2.5')).toBe(2500);
            expect(parseRetryAfterHeader('')).toBeNull();
            expect(parseRetryAfterHeader(null)).toBeNull();
        });

        it('parses future HTTP dates from headers', () => {
            const futureDate = new Date(Date.now() + 10000).toUTCString();
            const parsed = parseRetryAfterHeader(futureDate);
            expect(parsed).toBeGreaterThan(8000);
            expect(parsed).toBeLessThanOrEqual(10000);
        });

        it('parses error objects with properties, headers, or messages', () => {
            // Property
            expect(parseRetryAfterMs({ retryAfterMs: 4000 })).toBe(4000);
            expect(parseRetryAfterMs({ retryAfter: 3 })).toBe(3000);

            // Headers
            expect(parseRetryAfterMs({ headers: { 'retry-after': '6' } })).toBe(6000);

            // Error message regex
            expect(parseRetryAfterMs(new Error('Rate limit exceeded: try again in 4s'))).toBe(4000);
            expect(parseRetryAfterMs(new Error('retry-after: 8000ms'))).toBe(8000);
            expect(parseRetryAfterMs(new Error('Quota reached, wait 2 minutes'))).toBe(60000); // capped at maxCooldownMs
        });

        it('clamps retry-after duration between min and max cooldown thresholds', () => {
            expect(parseRetryAfterMs('0.1', 15000, 1000, 60000)).toBe(1000); // clamped to min
            expect(parseRetryAfterMs('120', 15000, 1000, 60000)).toBe(60000); // clamped to max
        });
    });
});
