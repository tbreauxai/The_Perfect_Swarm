import { describe, it, expect, beforeEach } from 'vitest';
import { ActionPlanCacheInterceptor, type ActionPlanInput } from './actionPlanCache.ts';
import { DeterministicLocalEmbeddingProvider } from './memory.ts';

describe('ActionPlanCacheInterceptor', () => {
    let interceptor: ActionPlanCacheInterceptor;
    let embedder: DeterministicLocalEmbeddingProvider;

    beforeEach(() => {
        interceptor = new ActionPlanCacheInterceptor({
            similarityThreshold: 0.96,
            maxEntries: 10,
            defaultTtlMs: 60000
        });
        embedder = new DeterministicLocalEmbeddingProvider();
    });

    it('returns cache miss on empty cache', async () => {
        const query = 'What are the current decimal odds for Arsenal vs Chelsea?';
        const vec = await embedder.embed(query);
        const result = interceptor.lookup(vec);

        expect(result.hit).toBe(false);
        expect(result.actionPlan).toBeUndefined();
        expect(interceptor.getStats().misses).toBe(1);
        expect(interceptor.getStats().hits).toBe(0);
    });

    it('hits cache for identical query (> 0.96 similarity) with sub-5ms latency and saves ~43ms', async () => {
        const query = 'Calculate implied probability for decimal odds 1.85';
        const vec = await embedder.embed(query);

        const planInput: ActionPlanInput = {
            intent: 'probability_odds_conversion',
            entities: { odds: 1.85, format: 'decimal' },
            toolExecutionSteps: [
                {
                    tool: 'probability_odds_converter',
                    parameters: { odds: 1.85, format: 'decimal' }
                }
            ],
            targetAppId: 'betting-app'
        };

        interceptor.set(vec, planInput);

        const lookup = interceptor.lookup(vec, 'betting-app');
        expect(lookup.hit).toBe(true);
        expect(lookup.similarity).toBeGreaterThanOrEqual(0.96);
        expect(lookup.actionPlan).toBeDefined();
        expect(lookup.actionPlan?.intent).toBe('probability_odds_conversion');
        expect(lookup.actionPlan?.entities.odds).toBe(1.85);
        expect(lookup.latencyMs).toBeLessThan(10); // Verifies sub-10ms (typically ~1-2ms)

        const stats = interceptor.getStats();
        expect(stats.hits).toBe(1);
        expect(stats.estimatedLatencySavedMs).toBe(43);
        expect(stats.hitRatio).toBe(1.0);
    });

    it('hits cache for semantically identical query with punctuation variation (> 0.96)', async () => {
        const query1 = 'Calculate implied probability for decimal odds 1.85';
        const query2 = 'Calculate implied probability for decimal odds 1.85.';
        const vec1 = await embedder.embed(query1);
        const vec2 = await embedder.embed(query2);

        interceptor.set(vec1, {
            intent: 'odds_calc',
            entities: { odds: 1.85 },
            toolExecutionSteps: [{ tool: 'probability_odds_converter', parameters: { odds: 1.85 } }]
        });

        const lookup = interceptor.lookup(vec2);
        expect(lookup.hit).toBe(true);
        expect(lookup.similarity).toBeGreaterThanOrEqual(0.96);
    });

    it('misses cache for semantically distinct query (< 0.96 similarity)', async () => {
        const queryOdds = 'Calculate implied probability for decimal odds 1.85';
        const queryWeather = 'What is the server CPU utilization threshold?';
        const vecOdds = await embedder.embed(queryOdds);
        const vecWeather = await embedder.embed(queryWeather);

        interceptor.set(vecOdds, {
            intent: 'odds_calc',
            entities: { odds: 1.85 },
            toolExecutionSteps: [{ tool: 'probability_odds_converter', parameters: { odds: 1.85 } }]
        });

        const lookup = interceptor.lookup(vecWeather);
        expect(lookup.hit).toBe(false);
        expect(interceptor.getStats().misses).toBe(1);
    });

    it('strictly enforces zero-stale-odds invariant by stripping volatile odds data', async () => {
        const query = 'Live odds for Real Madrid vs Barcelona';
        const vec = await embedder.embed(query);

        const planWithStaleOdds: ActionPlanInput = {
            intent: 'live_odds_fetch',
            entities: {
                fixture: 'Real Madrid vs Barcelona',
                market: 'moneyline',
                liveOdds: { home: 2.10, draw: 3.50, away: 3.10 }, // Volatile field!
                finalAnalysis: 'Real Madrid is heavily favored.'   // Volatile field!
            },
            toolExecutionSteps: [
                {
                    tool: 'live_odds_api',
                    parameters: { fixtureId: 'RMA-BAR' },
                    dynamicFetchRequired: true
                }
            ]
        };

        const storedPlan = interceptor.set(vec, planWithStaleOdds);

        // Verify volatile fields were stripped
        expect((storedPlan.entities as any).liveOdds).toBeUndefined();
        expect((storedPlan.entities as any).finalAnalysis).toBeUndefined();
        expect(storedPlan.entities.fixture).toBe('Real Madrid vs Barcelona');
        expect(storedPlan.entities.market).toBe('moneyline');
        expect(storedPlan.toolExecutionSteps[0].tool).toBe('live_odds_api');
    });

    it('executes dynamic live plan dynamically on cache hit to serve fresh odds', async () => {
        const query = 'Get current odds for Lakers vs Celtics';
        const vec = await embedder.embed(query);

        interceptor.set(vec, {
            intent: 'nba_odds',
            entities: { match: 'LAL-BOS' },
            toolExecutionSteps: [
                {
                    tool: 'probability_odds_converter',
                    parameters: { odds: '1.75', format: 'decimal' }
                }
            ]
        });

        const lookup = interceptor.lookup(vec);
        expect(lookup.hit).toBe(true);
        expect(lookup.actionPlan).toBeDefined();

        // Simulate dynamic tool execution with fresh odds calculation
        let dynamicCallExecuted = false;
        const results = await interceptor.executeLivePlan(lookup.actionPlan!, async (tool, params) => {
            dynamicCallExecuted = true;
            expect(tool).toBe('probability_odds_converter');
            expect(params.odds).toBe('1.75');
            return { impliedProbability: 0.5714, decimalOdds: 1.75 };
        });

        expect(dynamicCallExecuted).toBe(true);
        expect(results).toHaveLength(1);
        expect(results[0].result.impliedProbability).toBe(0.5714);
        expect(interceptor.getStats().dynamicFetchesExecuted).toBe(1);
    });

    it('evicts LRU entries when maxEntries capacity is reached', async () => {
        const smallInterceptor = new ActionPlanCacheInterceptor({ maxEntries: 2, similarityThreshold: 0.96 });

        const vec1 = [1, 0, 0, 0];
        const vec2 = [0, 1, 0, 0];
        const vec3 = [0, 0, 1, 0];

        smallInterceptor.set(vec1, { intent: 'intent1', entities: {}, toolExecutionSteps: [] });
        smallInterceptor.set(vec2, { intent: 'intent2', entities: {}, toolExecutionSteps: [] });
        expect(smallInterceptor.getStats().size).toBe(2);

        // Insert 3rd entry - should evict vec1
        smallInterceptor.set(vec3, { intent: 'intent3', entities: {}, toolExecutionSteps: [] });
        expect(smallInterceptor.getStats().size).toBe(2);
        expect(smallInterceptor.getStats().evictions).toBe(1);

        const res1 = smallInterceptor.lookup(vec1);
        expect(res1.hit).toBe(false);

        const res3 = smallInterceptor.lookup(vec3);
        expect(res3.hit).toBe(true);
    });
});
