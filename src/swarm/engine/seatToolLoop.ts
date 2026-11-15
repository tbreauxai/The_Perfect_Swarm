/**
 * Tool-first seat execution loop.
 *
 * Implements a strict two-round tool loop:
 * Round 1: Native tools scoped strictly to the seat role (toOpenAiTools <= 920 chars).
 * Parallel tool execution via executeToolWithCacheAndTimeout (1500ms timeout).
 * Round 2: Prompt + capped tool results + final instruction (no tools). Max 2 rounds.
 * Fallback: If Groq rejects tools (tool-use 400), prefetches role tools and executes 1 round.
 */

import type { Agent } from '../agent.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { seatBudget, assertPromptFits, type SeatBudget } from '../context/promptBudget.ts';
import { executeToolWithCacheAndTimeout } from './triageExecutor.ts';
import { GameQueryCache } from '../cache/gameQueryCache.ts';
import type { SwarmContext } from '../context.ts';

export interface RunSeatWithToolsParams {
  agent: Agent;
  seat: string;
  prompt: string;
  systemInstruction?: string;
  registry: ToolRegistry;
  budget?: SeatBudget;
  context?: SwarmContext;
  finalInstruction?: string;
  gameId?: string;
  cache?: GameQueryCache;
  options?: {
    env?: Record<string, string | undefined>;
    fetchFn?: typeof fetch;
    qdrantClient?: any;
  };
}

export interface SeatToolLoopResult {
  report: string;
  rounds: number;
  toolCallsExecuted: string[];
}

export function getRoleToolNames(seat: string): string[] {
  const norm = seat.toLowerCase().trim();
  if (norm === 'a1' || norm === 'quant') {
    return ['get_matchup_fundamentals', 'get_player_prop_splits'];
  }
  if (norm === 'a2' || norm === 'market') {
    return ['get_market_movement'];
  }
  if (norm === 'critic' || norm === 'risk' || norm === 'risk_critic') {
    return ['get_injury_and_roster_delta', 'get_environment_and_weather'];
  }
  return ['get_matchup_fundamentals', 'get_market_movement'];
}

export async function runSeatWithTools(params: RunSeatWithToolsParams): Promise<SeatToolLoopResult> {
  const {
    agent,
    seat,
    prompt,
    systemInstruction,
    registry,
    context,
    finalInstruction = 'Answer now, no tool calls.',
    gameId = 'unknown-game',
    cache = new GameQueryCache(),
    options
  } = params;

  const budget = params.budget || seatBudget(agent.provider);
  const baseTools = getRoleToolNames(seat);

  // Check if get_historical_lessons fits in the prompt budget
  const candidateNames = [...baseTools];
  if (registry.has('get_historical_lessons')) {
    const testScoped = registry.scoped([...candidateNames, 'get_historical_lessons']);
    const testSchemas = JSON.stringify(testScoped.toOpenAiTools());
    try {
      assertPromptFits(agent.provider, {
        systemInstruction,
        toolSchemas: testSchemas,
        prompt
      });
      candidateNames.push('get_historical_lessons');
    } catch {
      // Omit historical lessons if adding it would exceed the prompt budget
    }
  }

  const scopedRegistry = registry.scoped(candidateNames);
  const nativeTools = scopedRegistry.toOpenAiTools();
  const toolSchemasStr = JSON.stringify(nativeTools);

  // Ensure Round 1 prompt fits budget
  assertPromptFits(agent.provider, {
    systemInstruction,
    toolSchemas: toolSchemasStr,
    prompt
  });

  const executedTools: string[] = [];

  const executeCalls = async (calls: { tool: string; parameters: Record<string, unknown> }[]) => {
    const callsToRun = calls.slice(0, budget.maxToolCalls);
    const results = await Promise.all(
      callsToRun.map(async (c) => {
        executedTools.push(c.tool);
        context?.addEvent?.(`Executed Tool: ${c.tool}`);
        return executeToolWithCacheAndTimeout(
          { tool: c.tool, parameters: c.parameters },
          { game_id: (c.parameters.game_id as string) || (c.parameters.p_game_id as string) || gameId },
          registry,
          cache,
          1500,
          options
        );
      })
    );

    let summaryText = results.map(r => r.summary).filter(Boolean).join('\n\n');
    if (summaryText.length > budget.maxToolResultChars) {
      summaryText = summaryText.slice(0, budget.maxToolResultChars - 15) + '\n…[truncated]';
    }
    return summaryText;
  };

  let round1Output = '';
  try {
    round1Output = await agent.run(prompt, {
      tools: nativeTools,
      toolChoice: 'auto',
      groqMode: 'chat',
      systemInstruction
    });
  } catch (err: any) {
    const msg = String(err?.message || err);
    const isToolError =
      msg.includes('400') ||
      msg.includes('tool_use_failed') ||
      msg.includes('tool-use') ||
      msg.includes('tool call');

    if (agent.provider === 'groq' && isToolError) {
      // Groq native tool rejection fallback: prefetch role tools and run 1 round
      const prefetchCalls = baseTools.map(t => ({
        tool: t,
        parameters: { game_id: gameId }
      }));
      const toolResultsSummary = await executeCalls(prefetchCalls);

      const fallbackPrompt = assertPromptFits(agent.provider, {
        systemInstruction,
        prompt,
        toolResults: `Tool results:\n${toolResultsSummary}\n\n${finalInstruction}`
      });

      const fallbackOutput = await agent.run(fallbackPrompt, {
        groqMode: 'chat',
        systemInstruction
      });

      return {
        report: fallbackOutput,
        rounds: 1,
        toolCallsExecuted: executedTools
      };
    }
    throw err;
  }

  // Parse tool calls produced by model
  const toolCalls = scopedRegistry.parseToolCalls(round1Output);

  // If no tool calls in Round 1, output is final
  if (toolCalls.length === 0) {
    return {
      report: round1Output,
      rounds: 1,
      toolCallsExecuted: []
    };
  }

  // Execute Round 1 tool calls
  const toolResultsSummary = await executeCalls(toolCalls);

  // Round 2: prompt + tool results + final instruction (no tools)
  const round2Prompt = assertPromptFits(agent.provider, {
    systemInstruction,
    prompt,
    toolResults: `Tool results:\n${toolResultsSummary}\n\n${finalInstruction}`
  });

  const round2Output = await agent.run(round2Prompt, {
    groqMode: 'chat',
    systemInstruction
  });

  return {
    report: round2Output,
    rounds: 2,
    toolCallsExecuted: executedTools
  };
}
