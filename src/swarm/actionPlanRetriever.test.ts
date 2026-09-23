import { describe, it, expect } from 'vitest';
import { MemoryCortex, DeterministicLocalEmbeddingProvider } from './memory.ts';
import { executeSwarmWorkflow } from './engine/index.ts';
import { SwarmContext } from './context.ts';
import { ToolRegistry } from './tools/registry.ts';
import { probabilityTool } from './tools/builtin.ts';

describe('Agent Retriever Action Plan Cache Integration', () => {
    it('integrates Action Plan Cache with MemoryCortex to bypass vector search on hit', async () => {
        const embeddingProvider = new DeterministicLocalEmbeddingProvider();
        const cortex = new MemoryCortex({
            isolatedStore: true,
            embeddingProvider
        });

        const query1 = 'What is the implied probability for decimal odds 2.50?';
        const query2 = 'What is the implied probability for decimal odds 2.50.'; // High similarity > 0.96

        // 1. Initial lookup -> Cache Miss
        const missLookup = await cortex.lookupActionPlan(query1);
        expect(missLookup.hit).toBe(false);

        // 2. Cache Action Plan (intent + entities + steps, strictly no volatile response)
        await cortex.cacheActionPlan(query1, {
            intent: 'probability_odds_converter',
            entities: { odds: 2.50, format: 'decimal' },
            toolExecutionSteps: [
                {
                    tool: 'probability_odds_converter',
                    parameters: { odds: 2.50, format: 'decimal' }
                }
            ]
        });

        // 3. Similar query lookup -> Cache Hit (> 0.96)
        const hitLookup = await cortex.lookupActionPlan(query2);
        expect(hitLookup.hit).toBe(true);
        expect(hitLookup.similarity).toBeGreaterThanOrEqual(0.96);
        expect(hitLookup.actionPlan).toBeDefined();
        expect(hitLookup.actionPlan?.intent).toBe('probability_odds_converter');
        expect(hitLookup.actionPlan?.entities.odds).toBe(2.50);
        expect(hitLookup.latencyMs).toBeLessThan(10); // Verified ~1-2ms lookup

        // 4. MemoryCortex.retrieve() also bypasses vector search
        const retrieved = await cortex.retrieve(query2);
        expect(retrieved).toHaveLength(1);
        expect(retrieved[0].isActionPlanHit).toBe(true);
        expect(retrieved[0].latencySavedMs).toBe(43);
    });

    it('executes full swarm workflow with Action Plan Cache hit bypassing Qdrant and fetching live odds dynamically', async () => {
        const embeddingProvider = new DeterministicLocalEmbeddingProvider();
        const cortex = new MemoryCortex({
            isolatedStore: true,
            embeddingProvider
        });

        const tools = new ToolRegistry([probabilityTool]);

        const query1 = 'Convert odds 2.0 to implied probability';
        const query2 = 'Convert odds 2.0 to implied probability.'; // Semantically identical query (> 0.96)

        // Seed the action plan in cortex (simulating prior planning/extraction)
        await cortex.cacheActionPlan(query1, {
            intent: 'probability_odds_converter',
            entities: { odds: 2.0, format: 'decimal' },
            toolExecutionSteps: [
                {
                    tool: 'probability_odds_converter',
                    parameters: { odds: 2.0, format: 'decimal' }
                }
            ]
        });

        const context = new SwarmContext();
        const events: any[] = [];
        context.subscribe(e => events.push(e));

        const result = await executeSwarmWorkflow({
            task: query2,
            data: '',
            cortex,
            tools,
            context,
            forceFullSwarm: true, // Force through full swarm pipeline to test Step 3 interceptor
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'simulated', model: 'mock-model', apiKey: 'mock' },
                    { id: 'analyst-1', role: 'Odds Analyst', provider: 'simulated', model: 'mock-model', apiKey: 'mock' }
                ]
            }
        });

        expect(result).toBeDefined();

        // Verify that the Action Plan Cache Interceptor triggered
        const cacheHitEvent = events.find(e =>
            e.agentRole === 'Semantic Action Cache Interceptor' &&
            e.action === 'Action Plan Cache Hit (Qdrant Bypassed)'
        );
        expect(cacheHitEvent).toBeDefined();
        expect(cacheHitEvent.output.qdrantBypassed).toBe(true);
        expect(cacheHitEvent.output.latencySavedMs).toBe(43);

        // Verify that dynamic live tool execution occurred on-the-fly
        const liveFetchEvent = events.find(e =>
            e.agentRole === 'Semantic Action Cache Interceptor' &&
            e.action === 'Dynamic Live Data Fetch Completed'
        );
        expect(liveFetchEvent).toBeDefined();
        expect(liveFetchEvent.output).toHaveLength(1);
        expect(liveFetchEvent.output[0].tool).toBe('probability_odds_converter');
        expect(liveFetchEvent.output[0].result.impliedProbability).toBe(0.5);

        // Verify that the standard Qdrant "Targeted Cortex Retrieval" event was NOT emitted (bypassed)
        const qdrantRetrievalEvent = events.find(e =>
            e.agentRole === 'System Orchestrator' &&
            e.action === 'Targeted Cortex Retrieval'
        );
        expect(qdrantRetrievalEvent).toBeUndefined();

        // Verify cache stats show incremented hits and dynamic fetches
        const stats = cortex.getActionPlanCacheStats();
        expect(stats.hits).toBeGreaterThanOrEqual(1);
        expect(stats.dynamicFetchesExecuted).toBeGreaterThanOrEqual(1);
    });

    it('guarantees fresh odds execution and avoids serving stale cached odds', async () => {
        const embeddingProvider = new DeterministicLocalEmbeddingProvider();
        const cortex = new MemoryCortex({
            isolatedStore: true,
            embeddingProvider
        });

        let currentMarketOdds = 1.50; // Dynamic market odds that change over time

        const tools = new ToolRegistry([
            {
                name: 'live_odds_feed',
                description: 'Fetches live market odds',
                parameters: { fixture: { type: 'string', description: 'Fixture ID', required: true } },
                execute: async (params: any) => ({
                    fixture: params.fixture,
                    liveOdds: currentMarketOdds,
                    timestamp: Date.now()
                })
            }
        ]);

        const taskQuery = 'Get live odds for fixture Arsenal-Chelsea';

        // Cache the action plan
        await cortex.cacheActionPlan(taskQuery, {
            intent: 'live_odds_feed',
            entities: { fixture: 'ARS-CHE' },
            toolExecutionSteps: [
                {
                    tool: 'live_odds_feed',
                    parameters: { fixture: 'ARS-CHE' }
                }
            ]
        });

        // 1st run: currentMarketOdds = 1.50
        const context1 = new SwarmContext();
        const events1: any[] = [];
        context1.subscribe(e => events1.push(e));

        await executeSwarmWorkflow({
            task: taskQuery,
            data: '',
            cortex,
            tools,
            context: context1,
            forceFullSwarm: true,
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'simulated', model: 'mock', apiKey: 'mock' },
                    { id: 'analyst-1', role: 'Analyst', provider: 'simulated', model: 'mock', apiKey: 'mock' }
                ]
            }
        });

        const liveEvent1 = events1.find(e => e.action === 'Dynamic Live Data Fetch Completed');
        expect(liveEvent1).toBeDefined();
        expect(liveEvent1.output[0].result.liveOdds).toBe(1.50);

        // Odds shift in real life to 1.95!
        currentMarketOdds = 1.95;

        // 2nd run: Cache hit should STILL return fresh odds 1.95, NOT stale 1.50
        const context2 = new SwarmContext();
        const events2: any[] = [];
        context2.subscribe(e => events2.push(e));

        await executeSwarmWorkflow({
            task: taskQuery,
            data: '',
            cortex,
            tools,
            context: context2,
            forceFullSwarm: true,
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'simulated', model: 'mock', apiKey: 'mock' },
                    { id: 'analyst-1', role: 'Analyst', provider: 'simulated', model: 'mock', apiKey: 'mock' }
                ]
            }
        });

        const liveEvent2 = events2.find(e => e.action === 'Dynamic Live Data Fetch Completed');
        expect(liveEvent2).toBeDefined();
        expect(liveEvent2.output[0].result.liveOdds).toBe(1.95); // FRESH odds guaranteed!
    });
});
