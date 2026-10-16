import { fetchDaySlate, sanitizeDateStrings } from './espnSlate.ts';
import {
  buildJudgePrompt,
  formatGameToColumnar,
  parseAndValidateJudgeOutput,
  computeModelSnapshot
} from './judgePrompt.ts';
import {
  getSupabaseConfig,
  partitionSlateGames,
  upsertGameJudgment,
  insertBaselineLineSnapshots,
  type SupabaseConfig
} from './supabase.ts';
import { gradeAndRecordFinalGames } from './feedback.ts';
import type { MorningBatchResult, SlateGame } from './types.ts';
import { executeSwarmWorkflow } from '../engine/index.ts';

export * from './types.ts';
export * from './espnSlate.ts';
export * from './judgePrompt.ts';
export * from './supabase.ts';
export * from './feedback.ts';

export interface MorningAgentConfig {
  id: string;
  role: string;
  provider: 'gemini' | 'groq' | 'openrouter';
  model: string;
}

/**
 * Builds the default 4-agent DuelOdds pregame topology based on available API keys:
 * - a1: Quant Proposer (gemini-3.1-flash-lite) if GEMINI_API_KEY
 * - a2: Market Proposer (openai/gpt-oss-120b) if GROQ_API_KEY
 * - critic: Risk Critic (nvidia/nemotron-3-ultra-550b-a55b:free) if OPENROUTER_API_KEY
 * - manager: GodView Compiler (openai/gpt-oss-120b) if GROQ_API_KEY
 */
export function buildDefaultAgents(env: Record<string, string | undefined> = {}): MorningAgentConfig[] {
  const agents: MorningAgentConfig[] = [];

  if (env.GEMINI_API_KEY?.trim()) {
    agents.push({
      id: 'a1',
      role: 'Quant Proposer',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite'
    });
  }

  if (env.GROQ_API_KEY?.trim()) {
    agents.push({
      id: 'a2',
      role: 'Market Proposer',
      provider: 'groq',
      model: 'openai/gpt-oss-120b'
    });
  }

  if (env.OPENROUTER_API_KEY?.trim()) {
    agents.push({
      id: 'critic',
      role: 'Risk Critic',
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free'
    });
  }

  if (env.GROQ_API_KEY?.trim()) {
    agents.push({
      id: 'manager',
      role: 'GodView Compiler',
      provider: 'groq',
      model: 'openai/gpt-oss-120b'
    });
  }

  return agents;
}

export interface MorningSlateOptions {
  dateInput?: string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  executeWorkflowFn?: typeof executeSwarmWorkflow;
}

/**
 * Executes the complete morning slate pipeline:
 * 1. Build default agents from env keys; fail fast if none exist
 * 2. Fetch ESPN slate across NFL, NBA, MLB, NHL, WNBA, NCAAF, NCAAB
 * 3. Query Supabase game_judgments (skip swarm, replace direct/null)
 * 4. Run swarm analyze path with buildJudgePrompt and settings.agents (no direct fallback)
 * 5. Upsert game_judgments with judge_source: "swarm" and real workflow_id
 * 6. Write line_snapshots (market: "all", is_baseline: true, omit game_id, skip identical)
 * 7. Record feedback for completed games to drive calibration
 * 8. Return structured batch summary
 */
export async function runMorningSlate(options: MorningSlateOptions = {}): Promise<MorningBatchResult> {
  const {
    dateInput,
    env = typeof process !== 'undefined' ? process.env : {},
    fetchFn = fetch,
    executeWorkflowFn = executeSwarmWorkflow
  } = options;

  const { gameDate } = sanitizeDateStrings(dateInput);

  // Build default agents from available provider keys
  const agents = buildDefaultAgents(env);
  if (agents.length === 0) {
    return {
      ok: false,
      gameDate,
      judged: 0,
      replaced: 0,
      skipped: 0,
      snapshots: 0,
      errors: [{
        eventId: 'slate',
        error: 'No active LLM provider keys found (GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY). Unable to judge slate.'
      }],
      settled: 0
    };
  }

  const errors: Array<{ eventId: string; error: string }> = [];

  // 1. Fetch ESPN slate
  const slate = await fetchDaySlate(dateInput, fetchFn);

  if (!slate.games || slate.games.length === 0) {
    return {
      ok: true,
      gameDate,
      judged: 0,
      replaced: 0,
      skipped: 0,
      snapshots: 0,
      errors: []
    };
  }

  // 2. Query Supabase and partition slate games
  const cfg: SupabaseConfig | null = getSupabaseConfig(env);
  const {
    gamesToJudge,
    gamesToReplace,
    skippedCount
  } = await partitionSlateGames(cfg, slate.games, gameDate, fetchFn);

  const gamesToProcess: Array<{ game: SlateGame; isReplace: boolean }> = [
    ...gamesToReplace.map((g) => ({ game: g, isReplace: true })),
    ...gamesToJudge.map((g) => ({ game: g, isReplace: false }))
  ];

  let judgedCount = 0;
  let replacedCount = 0;

  // 3. Run Swarm analyze for each game (no direct fallback)
  for (const item of gamesToProcess) {
    const { game, isReplace } = item;
    try {
      const task = buildJudgePrompt(game, '', '', '');
      const data = formatGameToColumnar(game);

      const workflowResult: any = await executeWorkflowFn({
        task,
        data,
        originApp: 'duelodds',
        callerAppId: 'duelodds',
        settings: {
          domain: 'sports-betting',
          agents,
          geminiApiKey: env.GEMINI_API_KEY,
          groqApiKey: env.GROQ_API_KEY,
          openRouterApiKey: env.OPENROUTER_API_KEY,
          mistralApiKey: env.MISTRAL_API_KEY,
          githubToken: env.GITHUB_TOKEN,
          qdrantUrl: env.QDRANT_URL,
          qdrantApiKey: env.QDRANT_API_KEY
        }
      });

      const rawText = typeof workflowResult?.finalAnalysis === 'string'
        ? workflowResult.finalAnalysis
        : JSON.stringify(workflowResult?.finalAnalysis || {});

      const parsed = parseAndValidateJudgeOutput(
        rawText,
        game.homeTeam,
        game.awayTeam,
        game.sport,
        workflowResult?.workflowId
      );

      if (!parsed) {
        throw new Error(`Failed to parse Swarm Judge JSON for ${game.eventId}`);
      }

      const modelSnapshot = computeModelSnapshot(game, parsed.winProbHome);

      // 4. Upsert game_judgment row
      if (cfg) {
        await upsertGameJudgment(cfg, game, parsed, modelSnapshot, fetchFn);
      }

      if (isReplace) {
        replacedCount++;
      } else {
        judgedCount++;
      }
    } catch (err: any) {
      // Rule: Do not add a direct-judge fallback. If a game fails, leave it and retry it on the next run.
      console.error(`[Morning Swarm] Error judging ${game.eventId}:`, err?.message || err);
      errors.push({
        eventId: game.eventId,
        error: err?.message || String(err)
      });
    }
  }

  // 5. Write line_snapshots (first seen lines)
  let snapshotsCount = 0;
  if (cfg) {
    try {
      snapshotsCount = await insertBaselineLineSnapshots(cfg, slate.games, fetchFn);
    } catch (snapshotErr: any) {
      console.warn('[Morning Swarm] Line snapshots insertion failed:', snapshotErr);
    }
  }

  // 6. Learn from finished games
  let settledCount = 0;
  try {
    const settled = await gradeAndRecordFinalGames(cfg, slate.games, gameDate, fetchFn);
    settledCount = settled.length;
  } catch (feedbackErr: any) {
    console.warn('[Morning Swarm] Final game grading feedback failed:', feedbackErr);
  }

  return {
    ok: errors.length === 0,
    gameDate,
    judged: judgedCount,
    replaced: replacedCount,
    skipped: skippedCount,
    snapshots: snapshotsCount,
    errors,
    settled: settledCount
  };
}
