import { describe, it, expect, vi } from 'vitest';
import { processAndRecordToolCalls } from './toolExecutionHelper.ts';
import { SwarmContext } from '../context.ts';
import { ToolRegistry } from '../tools/registry.ts';

describe('Tool Execution and Context Recording Helper', () => {
    it('handles outputs without tool calls cleanly', async () => {
        const context = new SwarmContext();
        const registry = new ToolRegistry();
        const result = await processAndRecordToolCalls({
            rawOutput: 'Standard reasoning output',
            toolRegistry: registry,
            context,
            task: 'Analyze game trends'
        });

        expect(result.hasToolCalls).toBe(false);
        expect(result.toolCalls).toHaveLength(0);
        expect(result.toolResults).toHaveLength(0);
        expect(result.strippedOutput).toBe('Standard reasoning output');
        expect(context.events).toHaveLength(0);
    });

    it('parses, executes, records, and caches tool calls', async () => {
        const context = new SwarmContext();
        const registry = new ToolRegistry();
        registry.register({
            name: 'mock_calculator',
            description: 'Computes sum',
            parameters: {},
            execute: ({ a, b }: any) => ({ sum: a + b })
        });

        const mockCortex: any = {
            cacheActionPlan: vi.fn().mockResolvedValue(true)
        };

        const rawOutput = 'Thought: let us calculate.\n```json\n{"tool": "mock_calculator", "parameters": {"a": 2, "b": 3}}\n```';

        const result = await processAndRecordToolCalls({
            rawOutput,
            toolRegistry: registry,
            context,
            memoryCortex: mockCortex,
            task: 'Calculate 2+3',
            targetAppId: 'test-app'
        });

        expect(result.hasToolCalls).toBe(true);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolResults).toHaveLength(1);
        expect(result.toolResults[0].success).toBe(true);
        expect(result.toolResults[0].result).toEqual({ sum: 5 });

        // Event recorded in context
        const events = context.events;
        expect(events).toHaveLength(1);
        expect(events[0].agentRole).toBe('Deterministic Tool Engine');
        expect(events[0].action).toBe('Executed Tool: mock_calculator');

        // Cached on Cortex
        expect(mockCortex.cacheActionPlan).toHaveBeenCalledWith('Calculate 2+3', expect.objectContaining({
            intent: 'mock_calculator',
            targetAppId: 'test-app'
        }));
    });

    it('falls back to caching odds converter plan when enabled', async () => {
        const context = new SwarmContext();
        const registry = new ToolRegistry();
        const mockCortex: any = {
            cacheActionPlan: vi.fn().mockReturnValue(Promise.resolve(true))
        };

        await processAndRecordToolCalls({
            rawOutput: 'Implied probability analysis',
            toolRegistry: registry,
            context,
            memoryCortex: mockCortex,
            task: 'Calculate implied probability for +150 odds',
            enableOddsPlanFallback: true
        });

        expect(mockCortex.cacheActionPlan).toHaveBeenCalledWith(
            'Calculate implied probability for +150 odds',
            expect.objectContaining({
                intent: 'probability_odds_converter',
                entities: { odds: '+150' }
            })
        );
    });
});
