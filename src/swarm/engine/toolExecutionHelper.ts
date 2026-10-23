import type { SwarmContext } from '../context.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCallRequest, ToolExecutionResult } from '../tools/types.ts';
import type { MemoryCortex } from '../memory/cortex.ts';

export interface ProcessToolCallsOptions {
    rawOutput: any;
    toolRegistry: ToolRegistry;
    context: SwarmContext;
    memoryCortex?: MemoryCortex;
    task: string;
    targetAppId?: string;
    enableOddsPlanFallback?: boolean;
}

export interface ProcessToolCallsResult {
    toolCalls: ToolCallRequest[];
    toolResults: ToolExecutionResult[];
    strippedOutput: any;
    hasToolCalls: boolean;
}

/**
 * Parses, executes, and records deterministic tool calls emitted by agents.
 * Records execution events into SwarmContext, updates MemoryCortex action plan caches,
 * and strips tool invocation blocks from raw output.
 */
export async function processAndRecordToolCalls(
    options: ProcessToolCallsOptions
): Promise<ProcessToolCallsResult> {
    const {
        rawOutput,
        toolRegistry,
        context,
        memoryCortex,
        task,
        targetAppId,
        enableOddsPlanFallback
    } = options;

    const rawStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
    const toolCalls = toolRegistry.parseToolCalls(rawStr);
    const toolResults = toolCalls.length > 0 ? await toolRegistry.executeAllToolCalls(toolCalls) : [];

    for (const tr of toolResults) {
        context.addEvent({
            agentRole: 'Deterministic Tool Engine',
            action: `Executed Tool: ${tr.tool}`,
            modelName: 'Local/DeterministicTool',
            prompt: JSON.stringify(tr.parameters),
            output: tr.success ? tr.result : { error: tr.error },
            durationMs: tr.durationMs
        });
    }

    if (toolCalls.length > 0 && memoryCortex) {
        try {
            await memoryCortex.cacheActionPlan(task, {
                intent: toolCalls[0].tool,
                entities: { ...(toolCalls[0].parameters || {}) },
                toolExecutionSteps: toolCalls.map(tc => ({
                    tool: tc.tool,
                    parameters: tc.parameters,
                    dynamicFetchRequired: true
                })),
                targetAppId
            });
        } catch {
            // Non-critical background cache write
        }
    } else if (
        enableOddsPlanFallback &&
        toolCalls.length === 0 &&
        memoryCortex &&
        task &&
        (task.toLowerCase().includes('odds') || task.toLowerCase().includes('implied probability'))
    ) {
        const oddsMatch = task.match(/(?:odds|for)\s+([0-9]+(?:\.[0-9]+)?(?:\/[0-9]+)?|[+-][0-9]+)/i);
        if (oddsMatch && oddsMatch[1]) {
            try {
                memoryCortex.cacheActionPlan(task, {
                    intent: 'probability_odds_converter',
                    entities: { odds: oddsMatch[1] },
                    toolExecutionSteps: [{
                        tool: 'probability_odds_converter',
                        parameters: { odds: oddsMatch[1] },
                        dynamicFetchRequired: true
                    }],
                    targetAppId
                }).catch(() => {});
            } catch {
                // Non-critical background cache write
            }
        }
    }

    const strippedOutput = typeof rawOutput === 'string'
        ? toolRegistry.stripToolCalls(rawOutput)
        : rawOutput;

    return {
        toolCalls,
        toolResults,
        strippedOutput,
        hasToolCalls: toolCalls.length > 0
    };
}
