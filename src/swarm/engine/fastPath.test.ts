import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './index.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { ToolRegistry } from '../tools/index.ts';
import { MemoryCortex } from '../memory.ts';
import { globalPayloadCache, globalSemanticCache } from '../cache.ts';
import { globalTieredCache } from '../tieredCache.ts';

describe('Fast-Path Deterministic Tools & Action Plan Cache', () => {
    let callCount = 0;

    beforeEach(() => {
        callCount = 0;
        globalPayloadCache.clear();
        globalSemanticCache.clear();
        globalTieredCache.clear();

        ProviderRegistry.register({
            providerName: 'fastpath-mock-prov',
            async call(options) {
                callCount++;
                if (options.prompt?.includes('calculate_odds') || options.systemInstruction?.includes('calculate_odds')) {
                    return '[TOOL_CALL:{"tool":"calculate_odds","parameters":{"odds":2.5}}]\n' + JSON.stringify({
                        insights: [
                            'Executing requested odds calculation.'
                        ],
                        anomalies: [],
                        summary: 'Tool invocation completed'
                    });
                }
                return JSON.stringify({
                    insights: ['Standard fast-path insight without tools.'],
                    anomalies: [],
                    summary: 'Direct completion'
                });
            }
        });
    });

    it('executes tool calls emitted by fast analyst and includes tool result in insights', async () => {
        const customTools = new ToolRegistry([
            {
                name: 'calculate_odds',
                description: 'Calculates probability from decimal odds',
                parameters: {
                    odds: { type: 'number', description: 'Decimal odds' }
                },
                execute: async (params: { odds: number }) => {
                    return { impliedProbability: 1 / params.odds, decimalOdds: params.odds };
                }
            }
        ]);

        const memoryCortex = new MemoryCortex({ defaultAppId: 'fast-tool-test' });

        const result = await executeSwarmWorkflow({
            task: 'calculate_odds for decimal 2.5',
            data: '',
            forceFullSwarm: false, // allow fast-path
            tools: customTools,
            memoryCortex,
            settings: {
                appId: 'fast-tool-test',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'fastpath-mock-prov', apiKey: 'k', model: 'm' },
                    { id: 'analyst', role: 'Fast Analyst', provider: 'fastpath-mock-prov', apiKey: 'k', model: 'm' }
                ]
            }
        });

        expect(result).toBeDefined();
        // Verify fast-path event was triggered
        const fastPathEvent = result.events.find(e => e.action === 'Fast-Path Short-Circuit Activated');
        expect(fastPathEvent).toBeDefined();

        // Verify deterministic tool execution event
        const toolEvent = result.events.find(e => e.action === 'Executed Tool: calculate_odds');
        expect(toolEvent).toBeDefined();
        expect(toolEvent?.output).toEqual({ impliedProbability: 0.4, decimalOdds: 2.5 });

        // Verify tool result was injected into final analysis insights
        const insights = result.finalAnalysis?.components?.[0]?.props?.insights || [];
        const toolInsight = insights.find((i: any) => i.message?.includes('[Tool Result: calculate_odds]'));
        expect(toolInsight).toBeDefined();
        expect(toolInsight.message).toContain('"impliedProbability":0.4');

        // Verify Action Plan was cached in memoryCortex
        const actionStats = memoryCortex.getActionPlanCacheStats();
        expect(actionStats.size).toBeGreaterThan(0);
    });

    it('bypasses model invocation entirely on Action Plan Cache hit within fast-path', async () => {
        const customTools = new ToolRegistry([
            {
                name: 'calculate_odds',
                description: 'Calculates probability from decimal odds',
                parameters: {
                    odds: { type: 'number', description: 'Decimal odds' }
                },
                execute: async (params: { odds: number }) => {
                    return { impliedProbability: 1 / params.odds, decimalOdds: params.odds };
                }
            }
        ]);

        const memoryCortex = new MemoryCortex({ defaultAppId: 'fast-cache-test' });

        // Pre-populate action plan cache
        await memoryCortex.cacheActionPlan('calculate_odds for decimal 2.5', {
            intent: 'calculate_odds',
            entities: { odds: 2.5 },
            toolExecutionSteps: [{
                tool: 'calculate_odds',
                parameters: { odds: 2.5 },
                dynamicFetchRequired: true
            }],
            targetAppId: 'fast-cache-test'
        });

        const initialCallCount = callCount;

        const result = await executeSwarmWorkflow({
            task: 'calculate_odds for decimal 2.5',
            data: '',
            forceFullSwarm: false,
            tools: customTools,
            memoryCortex,
            settings: {
                appId: 'fast-cache-test',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'fastpath-mock-prov', apiKey: 'k', model: 'm' },
                    { id: 'analyst', role: 'Fast Analyst', provider: 'fastpath-mock-prov', apiKey: 'k', model: 'm' }
                ]
            }
        });

        // Fast-path model should NOT have been invoked
        expect(callCount).toBe(initialCallCount);

        // Verify Action Plan Cache Hit event
        const cacheHitEvent = result.events.find(e => e.action === 'Action Plan Cache Hit (Fast-Path Bypassed Model)');
        expect(cacheHitEvent).toBeDefined();

        // Verify fresh live tool outputs in insights
        const insights = result.finalAnalysis?.components?.[0]?.props?.insights || [];
        const toolInsight = insights.find((i: any) => i.message?.includes('[Tool Result: calculate_odds]'));
        expect(toolInsight).toBeDefined();
        expect(toolInsight.message).toContain('"impliedProbability":0.4');
    });

    it('resiliently handles non-JSON raw outputs from fast analyst using guardAnalystResponse', async () => {
        ProviderRegistry.register({
            providerName: 'malformed-mock-prov',
            async call() {
                return 'Plain text summary without JSON syntax.';
            }
        });

        const result = await executeSwarmWorkflow({
            task: 'ping healthcheck',
            data: '',
            forceFullSwarm: false,
            settings: {
                appId: 'fast-resilient-test',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'malformed-mock-prov', apiKey: 'k', model: 'm' },
                    { id: 'analyst', role: 'Fast Analyst', provider: 'malformed-mock-prov', apiKey: 'k', model: 'm' }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        const insights = result.finalAnalysis?.components?.[0]?.props?.insights || [];
        expect(insights.length).toBeGreaterThan(0);
        expect(insights[0].message).toContain('without JSON syntax.');
    });
});
