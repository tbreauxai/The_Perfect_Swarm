import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    DomainSubComputationCache,
    TokenWeightProfiler,
    DomainPreFilter,
    ConfidenceEarlyExitEvaluator,
    type PartialPrediction
} from './optimization.ts';

describe('Goal 1: Sub-Computation Caching, Token Weight Profiling & Domain Pre-Filtering', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('DomainSubComputationCache', () => {
        it('stores and retrieves cached sub-computations per domain', () => {
            const cache = new DomainSubComputationCache({ defaultTtlMs: 60000 });
            
            cache.set('team_form', 'Arsenal', { formScore: 8.5, streak: 'WWWDW' });
            cache.set('market_odds', 'ARS-CHE-ML', { home: 1.75, draw: 3.60, away: 4.50 });

            const form = cache.get('team_form', 'Arsenal');
            expect(form).toEqual({ formScore: 8.5, streak: 'WWWDW' });

            const odds = cache.get('market_odds', 'ARS-CHE-ML');
            expect(odds).toEqual({ home: 1.75, draw: 3.60, away: 4.50 });

            // Case insensitivity & trimming
            expect(cache.get('team_form', '  arsenal  ')).toEqual({ formScore: 8.5, streak: 'WWWDW' });
        });

        it('handles misses correctly and tracks hit ratio', () => {
            const cache = new DomainSubComputationCache();
            expect(cache.get('team_form', 'NonExistent')).toBeUndefined();

            cache.set('head_to_head', 'LIV-MCI', { last10Wins: { liv: 4, mci: 4, draw: 2 } });
            expect(cache.get('head_to_head', 'LIV-MCI')).toBeDefined();

            const metrics = cache.getMetrics();
            expect(metrics.hits).toBe(1);
            expect(metrics.misses).toBe(1);
            expect(metrics.hitRatio).toBe(0.5);
            expect(metrics.subcomputationsSaved).toBe(1);
        });

        it('expires entries after TTL', async () => {
            const cache = new DomainSubComputationCache({ defaultTtlMs: 30 }); // 30ms TTL
            cache.set('market_odds', 'TEST-KEY', { odds: 2.10 });

            expect(cache.get('market_odds', 'TEST-KEY')).toEqual({ odds: 2.10 });

            await new Promise(r => setTimeout(r, 45));

            expect(cache.get('market_odds', 'TEST-KEY')).toBeUndefined();
            expect(cache.getMetrics().evictions).toBe(1);
        });

        it('evicts oldest entries when maxEntries is reached', () => {
            const cache = new DomainSubComputationCache({ maxEntries: 2 });
            cache.set('team_form', 'TeamA', { pts: 10 });
            cache.set('team_form', 'TeamB', { pts: 20 });
            cache.set('team_form', 'TeamC', { pts: 30 }); // Evicts TeamA

            expect(cache.get('team_form', 'TeamA')).toBeUndefined();
            expect(cache.get('team_form', 'TeamB')).toBeDefined();
            expect(cache.get('team_form', 'TeamC')).toBeDefined();
            expect(cache.getMetrics().evictions).toBe(1);
        });

        it('getOrCompute resolves cached value without calling computeFn repeatedly', async () => {
            const cache = new DomainSubComputationCache();
            const spyFn = vi.fn().mockResolvedValue({ formIndex: 9.2 });

            const res1 = await cache.getOrCompute('team_form', 'RealMadrid', spyFn);
            const res2 = await cache.getOrCompute('team_form', 'RealMadrid', spyFn);

            expect(res1).toEqual({ formIndex: 9.2 });
            expect(res2).toEqual({ formIndex: 9.2 });
            expect(spyFn).toHaveBeenCalledTimes(1);
        });

        it('invalidates by domain or single key', () => {
            const cache = new DomainSubComputationCache();
            cache.set('team_form', 'Team1', 1);
            cache.set('team_form', 'Team2', 2);
            cache.set('market_odds', 'Odds1', 3);

            cache.invalidate('team_form', 'Team1');
            expect(cache.get('team_form', 'Team1')).toBeUndefined();
            expect(cache.get('team_form', 'Team2')).toBe(2);

            cache.invalidate('team_form');
            expect(cache.get('team_form', 'Team2')).toBeUndefined();
            expect(cache.get('market_odds', 'Odds1')).toBe(3);

            cache.clear();
            expect(cache.get('market_odds', 'Odds1')).toBeUndefined();
        });
    });

    describe('TokenWeightProfiler', () => {
        const profiler = new TokenWeightProfiler();

        it('accurately estimates token weights and flags heavy metadata', () => {
            const payload = {
                metadata: {
                    apiVersion: '2.4.1',
                    trackingId: 'req-89823-xyz',
                    deepDebugLogs: 'A'.repeat(800),
                    systemConfig: { env: 'production', cluster: 'us-east-1' }
                },
                matches: [
                    { home: 'Lakers', away: 'Warriors', spread: -4.5 }
                ]
            };

            const report = profiler.profile(payload);
            expect(report.totalTokens).toBeGreaterThan(200);
            expect(report.metadataTokens).toBeGreaterThan(report.dataTokens);
            expect(report.metadataWeightRatio).toBeGreaterThan(0.5);
            expect(report.recommendations.some(r => r.includes('Metadata accounts for'))).toBe(true);
        });

        it('detects baseline differences and flags token expansion', () => {
            const baseline = {
                matches: [
                    { home: 'Arsenal', away: 'Chelsea', odds: 1.95 }
                ]
            };

            const inflatedCurrent = {
                matches: [
                    { home: 'Arsenal', away: 'Chelsea', odds: 1.95 }
                ],
                telemetry: {
                    verboseTrace: 'Trace info '.repeat(100)
                },
                unsupportedMarkets: [
                    { id: 'extra-1', data: 'extra info '.repeat(50) }
                ]
            };

            const diff = profiler.diffBaselines(inflatedCurrent, baseline);
            expect(diff.isBloated).toBe(true);
            expect(diff.tokenDivergenceRatio).toBeGreaterThan(1.0); // More than double
            expect(diff.addedKeys).toContain('telemetry');
            expect(diff.addedKeys).toContain('unsupportedMarkets');
            expect(diff.recommendation).toContain('Detected');
        });
    });

    describe('DomainPreFilter', () => {
        const preFilter = new DomainPreFilter();

        it('prunes noisy fields and dead/stale betting data', () => {
            const dirtyBettingData = {
                eventId: 'EVT-101',
                homeTeam: 'Liverpool',
                awayTeam: 'Man City',
                odds: { home: 2.10, away: 3.20 },
                debug: {
                    httpStatus: 200,
                    stackTrace: 'trace lines...',
                    breadcrumbs: ['step1', 'step2']
                },
                telemetry: {
                    latencyMs: 45
                },
                staleOdds: {
                    stale: true,
                    suspended: true
                },
                emptyList: []
            };

            const result = preFilter.filter(dirtyBettingData);
            expect(result.filteredData.homeTeam).toBe('Liverpool');
            expect(result.filteredData.debug).toBeUndefined();
            expect(result.filteredData.telemetry).toBeUndefined();
            expect(result.filteredData.emptyList).toBeUndefined();
            expect(result.tokensSaved).toBeGreaterThan(0);
            expect(result.prunedFieldsCount).toBeGreaterThan(0);
        });

        it('drops closed matches and limits max match items', () => {
            const rawFeed = {
                fixtures: [
                    { matchId: 'M1', home: 'Team A', status: 'upcoming', volume: 50000 },
                    { matchId: 'M2', home: 'Team B', status: 'finished', volume: 80000 }, // Finished
                    { matchId: 'M3', home: 'Team C', status: 'canceled', volume: 10000 }, // Canceled
                    { matchId: 'M4', home: 'Team D', status: 'upcoming', volume: 500 }     // Low liquidity
                ]
            };

            const result = preFilter.filter(rawFeed, {
                dropClosedMatches: true,
                minLiquidityVolume: 1000
            });

            expect(result.filteredData.fixtures).toHaveLength(1);
            expect(result.filteredData.fixtures[0].matchId).toBe('M1');
            expect(result.prunedRecordsCount).toBe(3);
        });
    });

    describe('ConfidenceEarlyExitEvaluator', () => {
        const evaluator = new ConfidenceEarlyExitEvaluator({
            defaultConfidenceThreshold: 0.85,
            defaultMarginThreshold: 0.35
        });

        it('permits early exit when confidence meets high-confidence threshold', () => {
            const highConfidencePrediction: PartialPrediction = {
                market: 'Moneyline',
                predictedOutcome: 'Home Win',
                confidence: 0.89,
                probability: 0.89
            };

            const decision = evaluator.evaluate(highConfidencePrediction);
            expect(decision.canEarlyExit).toBe(true);
            expect(decision.bypassedRefinement).toBe(true);
            expect(decision.tier).toBe('tier1_approx');
            expect(decision.estimatedLatencySavedMs).toBeGreaterThan(0);
        });

        it('permits early exit when decisive probability margin exists between top alternatives', () => {
            const decisiveMarginPrediction: PartialPrediction = {
                market: 'Spread',
                predictedOutcome: 'Cover -3.5',
                confidence: 0.72, // Below 0.85, but decisive gap
                alternatives: [
                    { outcome: 'Cover -3.5', probability: 0.72 },
                    { outcome: 'Fail to Cover', probability: 0.28 }
                ]
            };

            // 0.72 - 0.28 = 0.44 margin >= 0.35
            const decision = evaluator.evaluate(decisiveMarginPrediction);
            expect(decision.canEarlyExit).toBe(true);
            expect(decision.margin).toBeCloseTo(0.44, 2);
            expect(decision.reason).toContain('Decisive outcome margin');
        });

        it('requires Tier 2 refinement when confidence is low and margin is close', () => {
            const uncertainPrediction: PartialPrediction = {
                market: 'Over/Under 2.5',
                predictedOutcome: 'Over',
                confidence: 0.54,
                alternatives: [
                    { outcome: 'Over', probability: 0.54 },
                    { outcome: 'Under', probability: 0.46 }
                ]
            };

            // 0.54 - 0.46 = 0.08 margin < 0.35
            const decision = evaluator.evaluate(uncertainPrediction);
            expect(decision.canEarlyExit).toBe(false);
            expect(decision.bypassedRefinement).toBe(false);
            expect(decision.tier).toBe('tier2_refined');
            expect(decision.reason).toContain('Tier 2 refinement required');
        });
    });
});
