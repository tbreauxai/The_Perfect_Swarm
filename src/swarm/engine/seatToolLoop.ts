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
  gameIds?: string[];
  marketType?: string;
  marketTypesByGame?: Record<string, string>;
  propParamsByGame?: Record<string, Array<{ player_id: string; stat_category: string }>>;
  cache?: GameQueryCache;
  runConfig?: any;
  options?: {
    env?: Record<string, string | undefined>;
    fetchFn?: typeof fetch;
    qdrantClient?: any;
  };
}

export function resolvePrefetchMarketType(marketHint?: string): 'all' | 'spread' | 'total' | 'ml' {
  const norm = String(marketHint || '').trim().toLowerCase();
  if (norm === 'spread' || norm === 'spreads') return 'spread';
  if (norm === 'total' || norm === 'totals') return 'total';
  if (norm === 'ml' || norm === 'moneyline' || norm === 'h2h') return 'ml';
  return 'all';
}

export interface ToolEvidenceItem {
  tool: string;
  eventId: string;
  summary: string;
}

export interface SeatToolLoopResult {
  report: string;
  rounds: number;
  toolCallsExecuted: string[];
  coveredEventIds: string[];
  toolEvidence: string;
  toolEvidenceItems: ToolEvidenceItem[];
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
  const coveredEventIds = new Set<string>();
  const toolEvidenceItems: ToolEvidenceItem[] = [];

  const gameIds: string[] = (params.gameIds && params.gameIds.length > 0)
    ? params.gameIds
    : (gameId && gameId !== 'unknown-game' ? [gameId] : []);

  const buildPrefetchCalls = (tools: string[]) => {
    const calls: { tool: string; parameters: Record<string, unknown> }[] = [];
    const targetGames = gameIds.length > 0 ? gameIds : [gameId];
    const availableTools = tools.filter(t => registry.has(t));
    const coreTools = ['get_injury_and_roster_delta', 'get_matchup_fundamentals'].filter(t => availableTools.includes(t));
    const extraTools = availableTools.filter(t => t !== 'get_injury_and_roster_delta' && t !== 'get_matchup_fundamentals');

    for (const gId of targetGames) {
      for (const t of coreTools) {
        if (calls.length >= budget.maxToolCalls) break;
        calls.push({ tool: t, parameters: { game_id: gId } });
      }
      if (calls.length >= budget.maxToolCalls) break;
    }

    for (const gId of targetGames) {
      if (calls.length >= budget.maxToolCalls) break;
      for (const t of extraTools) {
        if (calls.length >= budget.maxToolCalls) break;
        if (t === 'get_player_prop_splits') {
          const propsForGame = params.propParamsByGame?.[gId];
          if (Array.isArray(propsForGame) && propsForGame.length > 0) {
            for (const prop of propsForGame) {
              if (calls.length >= budget.maxToolCalls) break;
              if (prop?.player_id && prop?.stat_category) {
                calls.push({
                  tool: t,
                  parameters: {
                    game_id: gId,
                    player_id: prop.player_id,
                    stat_category: prop.stat_category
                  }
                });
              }
            }
          }
          continue;
        }
        if (t === 'get_market_movement') {
          const mType = resolvePrefetchMarketType(params.marketTypesByGame?.[gId] ?? params.marketType);
          calls.push({ tool: t, parameters: { game_id: gId, market_type: mType } });
        } else {
          calls.push({ tool: t, parameters: { game_id: gId } });
        }
      }
    }
    return calls;
  };

  const executeCalls = async (calls: { tool: string; parameters: Record<string, unknown> }[]) => {
    const callsToRun = calls.slice(0, budget.maxToolCalls);
    const results = await Promise.all(
      callsToRun.map(async (c) => {
        executedTools.push(c.tool);
        const targetGameId = (c.parameters.game_id as string) || (c.parameters.p_game_id as string) || (c.parameters.id as string) || gameId;
        const startTime = Date.now();
        const res = await executeToolWithCacheAndTimeout(
          { tool: c.tool, parameters: c.parameters },
          { game_id: targetGameId },
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
        if (res?.success === true && typeof res.summary === 'string' && res.summary.trim().length > 0) {
          toolEvidenceItems.push({
            tool: c.tool,
            eventId: targetGameId,
            summary: res.summary.trim()
          });
        }
        return { res, targetGameId, summary: res.summary };
      })
    );

    let summaryText = '';
    for (const item of results) {
      if (!item.summary) continue;
      const piece = summaryText ? `\n\n${item.summary}` : item.summary;
      if (summaryText.length + piece.length <= budget.maxToolResultChars) {
        summaryText += piece;
        if (item.targetGameId && item.targetGameId !== 'unknown-game') {
          coveredEventIds.add(item.targetGameId);
        }
      } else {
        const remainingChars = budget.maxToolResultChars - summaryText.length;
        if (remainingChars > 30) {
          summaryText += (summaryText ? '\n\n' : '') + item.summary.slice(0, remainingChars - 15) + '\n…[truncated]';
          if (item.targetGameId && item.targetGameId !== 'unknown-game') {
            coveredEventIds.add(item.targetGameId);
          }
        }
        break;
      }
    }
    const unfetchedGames = gameIds.filter(gId => !coveredEventIds.has(gId));
    if (unfetchedGames.length > 0) {
      const notFetchedLine = `[Not Fetched]: ${unfetchedGames.map(g => `${g}: not fetched`).join(', ')}`;
      const sep = summaryText ? '\n\n' : '';
      if (summaryText.length + sep.length + notFetchedLine.length <= budget.maxToolResultChars) {
        summaryText += sep + notFetchedLine;
      } else if (notFetchedLine.length <= budget.maxToolResultChars) {
        const keep = Math.max(0, budget.maxToolResultChars - sep.length - notFetchedLine.length);
        summaryText = (keep > 0 ? summaryText.slice(0, keep) + sep : '') + notFetchedLine;
      }
    }
    return summaryText;
  };

  const isCriticSeat = (s: string) => {
    const norm = s.toLowerCase().trim();
    return norm === 'critic' || norm === 'risk' || norm === 'risk_critic' || norm.includes('critic') || norm.includes('risk');
  };
  const isBettingRoleSeat = (s: string) => {
    const norm = s.toLowerCase().trim();
    return norm === 'a1' || norm === 'quant' || norm === 'a2' || norm === 'market';
  };

  const getPrefetchToolsForSeat = (): string[] => {
    const norm = seat.toLowerCase().trim();
    if (norm === 'a1' || norm === 'quant') {
      return ['get_matchup_fundamentals', 'get_player_prop_splits', 'get_injury_and_roster_delta']
        .filter(t => registry.has(t));
    }
    if (norm === 'a2' || norm === 'market') {
      return ['get_market_movement', 'get_injury_and_roster_delta']
        .filter(t => registry.has(t));
    }
    return baseTools.filter(t => registry.has(t));
  };

  if (isCriticSeat(seat) || (isBettingRoleSeat(seat) && gameIds.length > 0 && hasBaseTools)) {
    // Prefetch role tools server-side into maxToolResultChars budget,
    // then run one JSON round with no tools.
    const prefetchCalls = buildPrefetchCalls(getPrefetchToolsForSeat());
    const toolResultsSummary = prefetchCalls.length > 0 ? await executeCalls(prefetchCalls) : '';

    const prefetchedPrompt = assertPromptFits(agent.provider, {
      systemInstruction,
      prompt,
      toolResults: toolResultsSummary ? `Tool results:\n${toolResultsSummary}\n\n${finalInstruction}` : finalInstruction
    });

    const prefetchedConfig: any = {
      groqMode: 'chat',
      systemInstruction,
      ...params.runConfig
    };
    delete prefetchedConfig.tools;
    delete prefetchedConfig.toolChoice;

    const output = await runAgentWithDeadline(prefetchedPrompt, prefetchedConfig);
    return {
      report: output,
      rounds: 1,
      toolCallsExecuted: executedTools,
      coveredEventIds: Array.from(coveredEventIds),
      toolEvidence: toolResultsSummary,
      toolEvidenceItems
    };
  }

  let round1Output = '';
  try {
    const r1Config: any = {
      groqMode: 'chat',
      systemInstruction,
      ...params.runConfig
    };
    const isStrict = Boolean(params.runConfig?.zodSchema || (params.runConfig as any)?.schema);
    if (nativeTools.length > 0 && !isStrict) {
      r1Config.tools = nativeTools;
      r1Config.toolChoice = 'auto';
      delete r1Config.responseMimeType;
      delete r1Config.responseSchema;
    } else {
      delete r1Config.tools;
      delete r1Config.toolChoice;
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
      const prefetchCalls = buildPrefetchCalls(baseTools.filter(t => registry.has(t)));
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
        toolCallsExecuted: executedTools,
        coveredEventIds: Array.from(coveredEventIds),
        toolEvidence: toolResultsSummary,
        toolEvidenceItems
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
      toolCallsExecuted: [],
      coveredEventIds: [],
      toolEvidence: '',
      toolEvidenceItems: []
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
    toolCallsExecuted: executedTools,
    coveredEventIds: Array.from(coveredEventIds),
    toolEvidence: toolResultsSummary,
    toolEvidenceItems
  };
}
