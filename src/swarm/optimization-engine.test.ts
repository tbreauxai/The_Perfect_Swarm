import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    PredictionWorkerPool,
    TieredPredictionEngine,
    DomainSubComputationCache,
    TokenWeightProfiler,
    DomainPreFilter,
    ConfidenceEarlyExitEvaluator,
    type PartialPrediction
} from './optimization.ts';
import { executeSwarmWorkflow } from './engine/index.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('Goal 2: Worker Pool Parallelization, Tiered Inference & Streaming Integration', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('PredictionWorkerPool', () => {
        it('executes tasks concurrently up to maxConcurrency', async () => {
            const pool = new PredictionWorkerPool({ maxConcurrency: 3 });
            let activePeak = 0;
            let currentActive = 0;

            const makeTask = (delayMs: number, id: string) => async () => {
                currentActive++;
                activePeak = Math.max(activePeak, currentActive);
                await new Promise(r => setTimeout(r, delayMs));
                currentActive--;
                return `done-${id}`;
            };

            const tasks = [
                makeTask(40, '1'),
                makeTask(40, '2'),
                makeTask(40, '3'),
                makeTask(40, '4'),
                makeTask(40, '5')
            ];

            const results = await pool.submitBatch(tasks);
            expect(results).toEqual(['done-1', 'done-2', 'done-3', 'done-4', 'done-5']);
            expect(activePeak).toBeLessThanOrEqual(3);
            expect(activePeak).toBeGreaterThanOrEqual(2);

            const stats = pool.getStats();
            expect(stats.completedTasks).toBe(5);
            expect(stats.failedTasks).toBe(0);
        });

        it('prioritizes high priority tasks over normal and low tasks', async () => {
            const pool = new PredictionWorkerPool({ maxConcurrency: 1 }); // Serial execution to test ordering
            const executionOrder: string[] = [];

            const makeTask = (id: string, delayMs: number = 20) => async () => {
                await new Promise(r => setTimeout(r, delayMs));
                executionOrder.push(id);
                return id;
            };

            // Start blocker task
            const blocker = pool.submit(makeTask('blocker', 30));

            // Submit in queue: low, normal, high
            const low = pool.submit(makeTask('low-1'), { priority: 'low' });
            const normal = pool.submit(makeTask('normal-1'), { priority: 'normal' });
            const high = pool.submit(makeTask('high-1'), { priority: 'high' });

            await Promise.all([blocker, low, normal, high]);

            // blocker first, then high-1, then normal-1, then low-1
            expect(executionOrder).toEqual(['blocker', 'high-1', 'normal-1', 'low-1']);
        });

        it('enforces task timeout and handles rejection', async () => {
            const pool = new PredictionWorkerPool({ maxConcurrency: 2, defaultTaskTimeoutMs: 50 });
            
            const hangingTask = () => new Promise(r => setTimeout(r, 200));

            await expect(pool.submit(hangingTask, { timeoutMs: 30 })).rejects.toThrow(/timed out after 30ms/);
            expect(pool.getStats().failedTasks).toBe(1);
        });
    });

    describe('TieredPredictionEngine', () => {
        it('executes Tier 1 fast approx, emits partial result, and exits early on high confidence', async () => {
            const engine = new TieredPredictionEngine();
            const partialsEmitted: PartialPrediction[] = [];

            const tier1Fn = vi.fn().mockResolvedValue({
                market: 'Moneyline',
                predictedOutcome: 'Home Win',
                confidence: 0.91, // Above 0.85 threshold
                summary: 'Dominant home form and critical away injuries'
            });

            const tier2Fn = vi.fn().mockResolvedValue({
                market: 'Moneyline',
                detailedRefinement: 'Deep simulation results'
            });

            const result = await engine.execute({
                task: 'Predict Liverpool vs Everton',
                data: { home: 'Liverpool', away: 'Everton', odds: { home: 1.30, away: 9.00 } },
                tier1Fn,
                tier2Fn,
                onPartialResult: (p) => partialsEmitted.push(p),
                options: { enableEarlyExit: true }
            });

            expect(tier1Fn).toHaveBeenCalledTimes(1);
            expect(tier2Fn).not.toHaveBeenCalled(); // Bypassed!
            expect(result.earlyExit).toBe(true);
            expect(result.tier).toBe('tier1_approx');
            expect(result.partialResultEmitted).toBe(true);
            expect(partialsEmitted).toHaveLength(1);
            expect(partialsEmitted[0].confidence).toBe(0.91);
            expect(result.earlyExitDecision?.canEarlyExit).toBe(true);
            expect(result.earlyExitDecision?.estimatedLatencySavedMs).toBeGreaterThan(0);
        });

        it('proceeds to Tier 2 accurate refinement when Tier 1 confidence is uncertain', async () => {
            const engine = new TieredPredictionEngine();
            const partialsEmitted: PartialPrediction[] = [];

            const tier1Fn = vi.fn().mockResolvedValue({
                market: 'Moneyline',
                predictedOutcome: 'Uncertain Matchup',
                confidence: 0.58, // Below 0.85 threshold
                alternatives: [
                    { outcome: 'Home Win', probability: 0.52 },
                    { outcome: 'Away Win', probability: 0.48 }
                ],
                summary: 'Tightly contested rivalry with equal form'
            });

            const tier2Fn = vi.fn().mockResolvedValue({
                ui_title: 'Refined Rivalry Analysis',
                refinedOutcome: 'Away Win (Draw No Bet)',
                confidence: 0.74,
                deepSimulationPasses: 10000
            });

            const result = await engine.execute({
                task: 'Predict Milan vs Inter',
                data: { home: 'Milan', away: 'Inter' },
                tier1Fn,
                tier2Fn,
                onPartialResult: (p) => partialsEmitted.push(p),
                options: { enableEarlyExit: true }
            });

            expect(tier1Fn).toHaveBeenCalledTimes(1);
            expect(tier2Fn).toHaveBeenCalledTimes(1); // Ran refinement!
            expect(result.earlyExit).toBe(false);
            expect(result.tier).toBe('tier2_refined');
            expect(result.finalResult.refinedOutcome).toBe('Away Win (Draw No Bet)');
            expect(partialsEmitted).toHaveLength(1);
        });
    });

    describe('executeSwarmWorkflow Optimization Integration', () => {
        beforeEach(() => {
            ProviderRegistry.register({
                providerName: 'custom-mock',
                async call(opts) {
                    if (opts.systemInstruction?.includes('Swarm Verification Critic')) {
                        return JSON.stringify({ pass: true, feedback: 'Verified sports predictions' });
                    }
                    if (opts.systemInstruction?.includes('Swarm Orchestrator') || opts.prompt.includes('Analyst Reports:')) {
                        return JSON.stringify({
                            ui_title: 'Manager Synthesis Analysis',
                            components: [
                                { id: 'c1', type: 'InsightList', props: { title: 'Insights', insights: [{ type: 'info', message: 'Team form verified' }] } }
                            ]
                        });
                    }
                    return JSON.stringify({
                        insights: ['Arsenal won 5 consecutive home games', 'Manchester City missing starting center back'],
                        anomalies: ['Unusual line movement towards home dog'],
                        summary: 'High confidence match prediction (confidence: 0.89)'
                    });
                }
            });
        });

        it('streams early partial results and attaches optimization telemetry', async () => {
            const partialResults: any[] = [];
            const stages: string[] = [];

            const result = await executeSwarmWorkflow({
                task: 'Premier League Match Prediction: Arsenal vs Chelsea',
                data: JSON.stringify({
                    fixture: 'Arsenal vs Chelsea',
                    odds: { home: 1.85, draw: 3.50, away: 4.20 },
                    debug: { traceId: 'unused-noisy-trace', verboseLogs: 'A'.repeat(500) }
                }),
                onPartialResult: (p) => partialResults.push(p),
                onStage: (s) => stages.push(s.stage),
                settings: {
                    agents: [
                        { id: 'manager', role: 'Manager Node', provider: 'custom-mock', model: 'fast-model' },
                        { id: 'a1', role: 'Sports Analyst', provider: 'custom-mock', model: 'analyst-model' }
                    ],
                    optimizationSettings: {
                        enabled: true,
                        enableEarlyExit: true,
                        confidenceThreshold: 0.85
                    }
                }
            });

            expect(result).toBeDefined();
            expect(result.optimization).toBeDefined();
            expect(result.optimization?.partialResultEmitted).toBe(true);
            expect(partialResults.length).toBeGreaterThan(0);
            expect(stages).toContain('partial_prediction');
            expect(result.optimization?.earlyExit).toBe(true);
            expect(result.optimization?.tier).toBe('tier1_approx');
            expect(result.optimization?.latencySavedMs).toBeGreaterThan(0);
        });

        it('short-circuits instantly on sub-computation cache hit', async () => {
            const subCache = new DomainSubComputationCache();
            const cachedAnalysis = {
                ui_title: 'Cached Sub-Computation Matchup',
                components: [
                    { id: 'c1', type: 'InsightList', props: { title: 'Form', insights: [{ type: 'info', message: 'Instant cached H2H' }] } }
                ]
            };

            // Seed cache
            const cacheTask = 'H2H Analysis: Real Madrid vs Barcelona';
            const { globalDomainSubComputationCache } = await import('./optimization.ts');
            globalDomainSubComputationCache.set('market_odds', cacheTask, cachedAnalysis);

            const result = await executeSwarmWorkflow({
                task: cacheTask,
                data: 'Some raw stats',
                settings: {
                    agents: [
                        { id: 'manager', role: 'Manager Node', provider: 'custom-mock', model: 'fast' },
                        { id: 'a1', role: 'Odds Specialist', provider: 'custom-mock', model: 'fast' }
                    ],
                    optimizationSettings: {
                        enabled: true,
                        enableSubComputationCache: true
                    }
                }
            });

            expect(result.finalAnalysis).toEqual(cachedAnalysis);
            expect(result.optimization?.earlyExit).toBe(true);
            expect(result.optimization?.latencySavedMs).toBeGreaterThan(0);
        });
    });
});
