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

export const PROVIDER_CALL_DEADLINES: Record<string, number> = {
  groq: 20000,
  gemini: 30000,
  others: 30000
};

export const SEAT_DEADLINE_MS = 75000;

export function getProviderCallDeadlineMs(provider: string): number {
  return PROVIDER_CALL_DEADLINES[provider] ?? PROVIDER_CALL_DEADLINES.others ?? 30000;
}

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
  runConfig?: any;
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
  const hasBaseTools = baseTools.some(t => registry.has(t));
  const candidateNames = hasBaseTools ? [...baseTools] : registry.list().map(t => t.name);

  // Check if get_historical_lessons fits in the prompt budget
  if (hasBaseTools && registry.has('get_historical_lessons')) {
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

  const scopedRegistry = hasBaseTools ? registry.scoped(candidateNames) : registry;
  const nativeTools = scopedRegistry.toOpenAiTools();
  const toolSchemasStr = JSON.stringify(nativeTools);

  // Ensure Round 1 prompt fits budget
  assertPromptFits(agent.provider, {
    systemInstruction,
    toolSchemas: toolSchemasStr,
    prompt
  });

  const seatStartAt = Date.now();
  const seatDeadlineAt = seatStartAt + SEAT_DEADLINE_MS;

  const logFailure = (startTime: number, err: any) => {
    const durationMs = Date.now() - startTime;
    const msg = String(err?.message || err || '');
    let reason = 'unknown_error';
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('TIMEOUT') || msg.includes('AbortError')) {
      reason = 'timeout';
    } else {
      const httpMatch = msg.match(/\b(4\d\d|5\d\d)\b/) || (err?.status ? [String(err.status), String(err.status)] : null);
      if (httpMatch) {
        reason = `http_${httpMatch[1]}`;
      } else if (msg.includes('tool') || msg.includes('PGRST')) {
        reason = 'tool_error';
      } else {
        reason = msg.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30) || 'error';
      }
    }
    const model = agent.modelName || 'default';
    console.warn(`[seat] ${seat} ${agent.provider}/${model} failed reason=${reason} ms=${durationMs}`);
  };

  const runAgent = async (p: string, cfg: any) => {
    if (typeof agent.run === 'function' && agent.run.length === 2) {
      return agent.run(p, cfg);
    }
    return agent.run(p, context, cfg);
  };

  const runAgentWithDeadline = async (p: string, cfg: any) => {
    const callStartTime = Date.now();
    const remainingSeatMs = seatDeadlineAt - callStartTime;
    if (remainingSeatMs <= 0) {
      const err = new Error('seat_deadline_timeout');
      logFailure(callStartTime, err);
      throw err;
    }

    const providerDeadlineMs = getProviderCallDeadlineMs(agent.provider);
    const callTimeoutMs = Math.min(providerDeadlineMs, remainingSeatMs);
    const controller = new AbortController();
    const configWithSignal = {
      ...cfg,
      signal: controller.signal,
      timeoutMs: Math.max(1000, callTimeoutMs - 2000)
    };

    let timer: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const reason = remainingSeatMs <= callTimeoutMs ? 'seat_timeout' : 'call_timeout';
        reject(new Error(reason));
      }, callTimeoutMs);
    });

    try {
      return await Promise.race([
        runAgent(p, configWithSignal),
        timeoutPromise
      ]);
    } catch (err: any) {
      logFailure(callStartTime, err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const executedTools: string[] = [];

  const executeCalls = async (calls: { tool: string; parameters: Record<string, unknown> }[]) => {
    const callsToRun = calls.slice(0, budget.maxToolCalls);
    const results = await Promise.all(
      callsToRun.map(async (c) => {
        executedTools.push(c.tool);
        const startTime = Date.now();
        const res = await executeToolWithCacheAndTimeout(
          { tool: c.tool, parameters: c.parameters },
          { game_id: (c.parameters.game_id as string) || (c.parameters.p_game_id as string) || gameId },
          registry,
          cache,
          1500,
          options
        );
        if (context?.addEvent) {
          const actionStr = `Executed Tool: ${c.tool}`;
          if ((context as any).events && Array.isArray((context as any).events)) {
            context.addEvent({
              agentRole: seat,
              action: actionStr,
              modelName: `${agent.provider} / ${agent.modelName || 'analyst'}`,
              prompt: JSON.stringify(c.parameters),
              tool: c.tool,
              output: res.success ? (res.data ?? res.summary) : { error: res.error },
              durationMs: Date.now() - startTime
            });
          } else {
            (context.addEvent as any)(actionStr);
          }
        }
        return res;
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
    const r1Config: any = {
      groqMode: 'chat',
      systemInstruction,
      ...params.runConfig
    };
    if (nativeTools.length > 0) {
      r1Config.tools = nativeTools;
      r1Config.toolChoice = 'auto';
      delete r1Config.responseMimeType;
      delete r1Config.responseSchema;
    }
    round1Output = await runAgentWithDeadline(prompt, r1Config);
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

      const fallbackOutput = await runAgentWithDeadline(fallbackPrompt, {
        groqMode: 'chat',
        systemInstruction,
        ...params.runConfig
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

  const round2Output = await runAgentWithDeadline(round2Prompt, {
    groqMode: 'chat',
    systemInstruction,
    ...params.runConfig
  });

  return {
    report: round2Output,
    rounds: 2,
    toolCallsExecuted: executedTools
  };
}
