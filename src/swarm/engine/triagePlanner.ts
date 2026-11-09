import type { SeedManifest } from '../server/slimPayload.ts';
import { getHistoricalLessonsTool } from '../tools/dueloddsRpcTools.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { parseJsonSafe } from '../parser.ts';
import type { Provider } from '../types.ts';

export interface TriageToolCall {
  tool: string;
  parameters: Record<string, any>;
}

export interface TriagePlan {
  tool_calls: TriageToolCall[];
  reasoning: string;
  historical_lessons?: string[];
  candidate_id: string;
  game_id: string;
  sport: string;
  market_type: string;
}

export interface TriagePlannerOptions {
  provider?: Provider;
  modelName?: string;
  apiKey?: string;
  agent?: Agent;
  context?: SwarmContext;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  qdrantClient?: any;
  /**
   * Pre-fetched historical lessons. If not provided, getHistoricalLessonsTool is queried.
   */
  lessons?: string[];
}

const MAX_TOOL_BUDGET = 3;

/**
 * Deterministic fallback planning logic based on SeedManifest flags and available tools.
 * Used when no LLM key is configured, during offline test runs, or on LLM JSON parse errors.
 */
export function buildDeterministicTriagePlan(
  manifest: SeedManifest,
  lessons: string[] = []
): TriagePlan {
  const available = new Set(manifest.available_tools.map((t) => t.trim()));
  const calls: TriageToolCall[] = [];

  // Rule 1: If active injury tags exist, prioritize injury delta
  if (manifest.flags?.has_active_injury_tags && available.has('get_injury_and_roster_delta')) {
    calls.push({
      tool: 'get_injury_and_roster_delta',
      parameters: { game_id: manifest.game_id }
    });
  }

  // Rule 2: If player prop, prioritize player prop splits
  if (manifest.market_type === 'player_prop' && available.has('get_player_prop_splits')) {
    calls.push({
      tool: 'get_player_prop_splits',
      parameters: {
        player_id: manifest.pricing.selection,
        stat_category: 'default',
        line: manifest.pricing.line
      }
    });
  }

  // Rule 3: If not dome and within 48h, check weather/environment
  if (
    !manifest.flags?.is_dome &&
    (manifest.flags?.hours_to_kickoff ?? 0) <= 48 &&
    available.has('get_environment_and_weather')
  ) {
    calls.push({
      tool: 'get_environment_and_weather',
      parameters: { game_id: manifest.game_id, is_dome: false }
    });
  }

  // Rule 4: Market movement (spread / total / moneyline steam)
  if (calls.length < MAX_TOOL_BUDGET && available.has('get_market_movement')) {
    calls.push({
      tool: 'get_market_movement',
      parameters: { game_id: manifest.game_id, market_type: manifest.market_type }
    });
  }

  // Rule 5: Matchup fundamentals (pace, net margins)
  if (calls.length < MAX_TOOL_BUDGET && available.has('get_matchup_fundamentals')) {
    calls.push({
      tool: 'get_matchup_fundamentals',
      parameters: { game_id: manifest.game_id, window: 'L10' }
    });
  }

  // Enforce strict cap: at most 3 tool calls
  const finalCalls = calls.slice(0, MAX_TOOL_BUDGET);

  return {
    tool_calls: finalCalls,
    reasoning: `Deterministic triage based on manifest flags (injury: ${manifest.flags.has_active_injury_tags}, dome: ${manifest.flags.is_dome}, market: ${manifest.market_type}).`,
    historical_lessons: lessons,
    candidate_id: manifest.candidate_id,
    game_id: manifest.game_id,
    sport: manifest.sport,
    market_type: manifest.market_type
  };
}

/**
 * Hop 1 Triage Planner:
 * Analyzes SeedManifest + Qdrant historical lessons, selecting up to 3 tools from available_tools.
 */
export async function planTriage(
  manifest: SeedManifest,
  options?: TriagePlannerOptions
): Promise<TriagePlan> {
  const env = options?.env || (typeof process !== 'undefined' ? process.env : {});
  const context = options?.context || new SwarmContext();

  // 1. Fetch historical lessons if not provided
  let lessons = options?.lessons || [];
  if (lessons.length === 0) {
    try {
      const lessonRes = await getHistoricalLessonsTool.execute(
        {
          sport: manifest.sport,
          market_type: manifest.market_type,
          tags: [
            manifest.flags.is_dome ? 'dome' : 'outdoor',
            manifest.flags.has_active_injury_tags ? 'injury' : 'healthy'
          ]
        },
        {
          env,
          fetchFn: options?.fetchFn,
          qdrantClient: options?.qdrantClient
        }
      );
      if (lessonRes?.success && Array.isArray(lessonRes.data)) {
        lessons = lessonRes.data.map((l: any) => l.lesson || l.content || JSON.stringify(l));
      }
    } catch {
      // Degrade gracefully if lessons fetch fails
    }
  }

  // 2. If no Agent or LLM provider configured, return deterministic triage plan
  const hasAgent = Boolean(options?.agent);
  const provider = options?.provider || (env.GEMINI_API_KEY ? 'gemini' : env.GROQ_API_KEY ? 'groq' : undefined);
  const apiKey = options?.apiKey || (provider === 'gemini' ? env.GEMINI_API_KEY : provider === 'groq' ? env.GROQ_API_KEY : undefined);

  if (!hasAgent && (!provider || !apiKey)) {
    return buildDeterministicTriagePlan(manifest, lessons);
  }

  // 3. Construct Planner Agent
  let agent = options?.agent;
  if (!agent && provider && apiKey) {
    const model = options?.modelName || (provider === 'gemini' ? 'gemini-2.5-flash-lite' : 'llama-3.3-70b-versatile');
    agent = new Agent('Triage Planner', model, provider, apiKey);
  }

  if (!agent) {
    return buildDeterministicTriagePlan(manifest, lessons);
  }

  const lessonsPrompt = lessons.length > 0
    ? `\nHistorical Routing Lessons:\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
    : '';

  const prompt = `You are the Hop 1 Triage Planner for an algorithmic sports betting swarm.
Analyze the Seed Manifest and select UP TO 3 tools to retrieve critical market context.

Seed Manifest:
- Candidate ID: ${manifest.candidate_id}
- Game ID: ${manifest.game_id}
- Sport: ${manifest.sport}
- Market: ${manifest.market_type}
- Pick: ${manifest.pricing.selection} (Odds: ${manifest.pricing.book_odds}, Fair Prob: ${manifest.pricing.fair_prob}, Line: ${manifest.pricing.line ?? 'N/A'})
- Flags: dome=${manifest.flags.is_dome}, hours_to_kickoff=${manifest.flags.hours_to_kickoff}, injuries=${manifest.flags.has_active_injury_tags}
- Available Tools Whitelist: ${JSON.stringify(manifest.available_tools)}
${lessonsPrompt}

Guardrail Rules:
1. Select AT MOST 3 tools total.
2. Select ONLY tools that exist in Available Tools Whitelist. Any tool not in the whitelist is forbidden.
3. If flags.is_dome is true, do NOT call get_environment_and_weather.
4. For all game-level tools, provide "game_id": "${manifest.game_id}".

Return ONLY a valid JSON object matching this schema:
{
  "tool_calls": [
    {
      "tool": "tool_name",
      "parameters": { ... }
    }
  ],
  "reasoning": "Concise 1-sentence reason for choosing these tools"
}`;

  try {
    const rawOutput = await agent.run(prompt, context, {
      responseMimeType: 'application/json',
      timeoutMs: 4000
    });

    const parsed = typeof rawOutput === 'string' ? parseJsonSafe(rawOutput) : rawOutput;
    if (parsed && Array.isArray(parsed.tool_calls)) {
      const available = new Set(manifest.available_tools.map((t) => t.trim()));
      const validatedCalls: TriageToolCall[] = [];

      for (const call of parsed.tool_calls) {
        if (!call || typeof call.tool !== 'string') continue;
        const toolName = call.tool.trim();
        // Whitelist enforcement
        if (!available.has(toolName)) continue;
        // Dome short-circuit enforcement
        if (manifest.flags.is_dome && toolName === 'get_environment_and_weather') continue;

        const params = typeof call.parameters === 'object' && call.parameters !== null ? call.parameters : {};
        // Ensure game_id is present if tool needs it
        if (!params.game_id && toolName !== 'get_historical_lessons') {
          params.game_id = manifest.game_id;
        }

        validatedCalls.push({
          tool: toolName,
          parameters: params
        });

        if (validatedCalls.length >= MAX_TOOL_BUDGET) break;
      }

      if (validatedCalls.length > 0) {
        return {
          tool_calls: validatedCalls,
          reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'Selected via Hop 1 LLM planner',
          historical_lessons: lessons,
          candidate_id: manifest.candidate_id,
          game_id: manifest.game_id,
          sport: manifest.sport,
          market_type: manifest.market_type
        };
      }
    }
  } catch {
    // LLM call failed or timed out: fall back to deterministic plan
  }

  return buildDeterministicTriagePlan(manifest, lessons);
}
