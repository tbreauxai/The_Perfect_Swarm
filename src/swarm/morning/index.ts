import { fetchDaySlate, sanitizeDateStrings } from './espnSlate.ts';
import {
  buildJudgePrompt,
  buildProposerPrompt,
  formatGameToColumnar,
  parseAndValidateJudgeOutput,
  computeModelSnapshot,
  JUDGE_MANAGER_INSTRUCTION,
  buildProposerPromptV2,
  parseAndValidateJudgeOutputV2,
  computeModelSnapshotV2,
  JUDGE_MANAGER_INSTRUCTION_V2
} from './judgePrompt.ts';
import { isJudgmentSchemaV2 } from './judgment.ts';
import {
  getSupabaseConfig,
  partitionSlateGames,
  upsertGameJudgment,
  upsertGameJudgmentV2,
  recordRejectedJudgmentV2,
  insertBaselineLineSnapshots,
  fetchPregameLearningContext,
  hydrateCalibrationFromSupabase,
  type SupabaseConfig
} from './supabase.ts';
import { gradeAndRecordFinalGames } from './feedback.ts';
import type { MorningBatchResult, SlateGame } from './types.ts';
import { morningClaimKey, type MorningClaimStore } from "./singleFlight.ts";
import { executeSwarmWorkflow } from '../engine/index.ts';

export * from "./types.ts";
export * from "./espnSlate.ts";
export * from "./judgePrompt.ts";
export * from "./judgment.ts";
export * from "./supabase.ts";
export * from "./feedback.ts";
export * from "./singleFlight.ts";

export interface MorningAgentConfig {
  id: string;
  role: string;
  provider: 'gemini' | 'groq' | 'openrouter' | 'mistral';
  model: string;
}

/**
 * Builds the default 4-agent DuelOdds pregame topology based on available API keys:
 * - a1: Quant Proposer (gemini-3.1-flash-lite) if GEMINI_API_KEY
 * - a2: Market Proposer (openai/gpt-oss-120b) if GROQ_API_KEY
 * - critic: Risk Critic (nvidia/nemotron-3-ultra-550b-a55b:free) if OPENROUTER_API_KEY
 * - manager: GodView Compiler (mistral-small-latest) if MISTRAL_API_KEY
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

  if (env.MISTRAL_API_KEY?.trim()) {
    agents.push({
      id: 'manager',
      role: 'GodView Compiler',
      provider: 'mistral',
      model: 'mistral-small-latest'
    });
  }

  return agents;
}

export interface MorningSlateOptions {
  dateInput?: string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  executeWorkflowFn?: typeof executeSwarmWorkflow;
  /** R3-S1: skip games claimed by another run in the last 20 minutes, and claim the rest. The route passes morningClaims. */
  claims?: MorningClaimStore;
  /** Clock for claims (tests). */
  now?: () => number;
}

/**
 * Executes the complete morning slate pipeline:
 * 1. Build default agents from env keys; fail fast if none exist
 * 2. Fetch ESPN slate across NFL, NBA, MLB, NHL, WNBA, NCAAF, NCAAB
 * 3. Query Supabase game_judgments (skip swarm, replace direct/null)
 * 4. Run swarm analyze path with buildJudgePrompt and settings.agents (no direct fallback)
 * 5. Upsert game_judgments with judge_source: "swarm" and real workflow_id
 * 6. Write line_snapshots (market: "all", is_baseline only on the first row per game_date + event_id, omit game_id, skip identical)
 * 7. Record feedback for completed games to drive calibration
 * 8. Return structured batch summary
 */
export async function runMorningSlate(options: MorningSlateOptions = {}): Promise<MorningBatchResult> {
  const {
    dateInput,
    env = typeof process !== 'undefined' ? process.env : {},
    fetchFn = fetch,
    executeWorkflowFn = executeSwarmWorkflow,
    claims,
    now = Date.now
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
        error: 'No active LLM provider keys found (GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY). Unable to judge slate.'
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
  // JUDGMENT_SCHEMA_V2 (default off): off = v1 prompts, parse, columns and selects exactly as before.
  // Do not set it until the DuelOdds game_judgments v2 migration and backfill are applied.
  const v2 = isJudgmentSchemaV2(env);
  if (cfg) {
    await hydrateCalibrationFromSupabase(cfg, fetchFn, v2).catch(() => 0);
  }
  const {
    gamesToJudge,
    gamesToReplace,
    skippedCount,
    existingJudgments
  } = await partitionSlateGames(cfg, slate.games, gameDate, fetchFn, v2);

  const gamesToProcess: Array<{ game: SlateGame; isReplace: boolean }> = [
    ...gamesToReplace.map((g) => ({ game: g, isReplace: true })),
    ...gamesToJudge.map((g) => ({ game: g, isReplace: false }))
  ];

  // R3-S1: judge only unclaimed games. A game claimed in the last 20 minutes is skipped; every other game is
  // claimed now, before any LLM call, so an overlapping run can't pick it up.
  let skippedClaimed = 0;
  const unclaimedGames = claims
    ? gamesToProcess.filter(({ game }) => {
        const key = morningClaimKey(gameDate, game.eventId);
        if (claims.isClaimed(key, now())) {
          skippedClaimed++;
          return false;
        }
        claims.claim(key, now());
        return true;
      })
    : gamesToProcess;

  let judgedCount = 0;
  let replacedCount = 0;

  // 3. Run Swarm analyze for each game (no direct fallback)
  // Strict constraint: only one Groq seat allowed to prevent exhausting the 8,000 TPM bucket
  let groqSeatCount = 0;
  const singleGroqSeatAgents = agents.filter(a => {
    if (a.provider === 'groq' || a.model.includes('gpt-oss')) {
      groqSeatCount++;
      return groqSeatCount === 1;
    }
    return true;
  });

  const participatingSeatRoles = singleGroqSeatAgents.map(a => a.role);

  for (const item of unclaimedGames) {
    const { game, isReplace } = item;
    try {
      // Fetch live line-movement steam delta and team-specific calibration history from Supabase when configured
      const pregameContext = cfg
        ? await fetchPregameLearningContext(cfg, game, fetchFn, v2).catch(() => ({ lineMovement: null, teamHistory: null, formattedBlock: '' }))
        : { lineMovement: null, teamHistory: null, formattedBlock: '' };

      // Proposers receive lean board, baseline, and live Supabase steam/calibration context; manager receives JSON contract via JUDGE_MANAGER_INSTRUCTION
      const baseTask = v2 ? buildProposerPromptV2(game) : buildProposerPrompt(game);
      const managerInstruction = v2 ? JUDGE_MANAGER_INSTRUCTION_V2 : JUDGE_MANAGER_INSTRUCTION;
      const task = pregameContext.formattedBlock ? `${baseTask}\n\n${pregameContext.formattedBlock}` : baseTask;
      const baseData = formatGameToColumnar(game);
      const data = pregameContext.formattedBlock ? `${baseData}\n\n${pregameContext.formattedBlock}` : baseData;

      const workflowResult: any = await executeWorkflowFn({
        task,
        data,
        originApp: 'duelodds',
        callerAppId: 'duelodds',
        // Every game is judged fresh: no semantic/payload cache hit can copy another game's verdict.
        bypassCache: true,
        settings: {
          domain: 'sports-betting',
          responseSchema: 'morning_judge',
          managerInstruction,
          systemPrompts: {
            manager: managerInstruction,
            'GodView Compiler': managerInstruction
          },
          agents: singleGroqSeatAgents,
          geminiApiKey: env.GEMINI_API_KEY,
          groqApiKey: env.GROQ_API_KEY,
          openRouterApiKey: env.OPENROUTER_API_KEY,
          mistralApiKey: env.MISTRAL_API_KEY,
          githubToken: env.GITHUB_TOKEN,
          qdrantUrl: env.QDRANT_URL,
          qdrantApiKey: env.QDRANT_API_KEY
        }
      });

      if (v2) {
        const v2Result = parseAndValidateJudgeOutputV2(workflowResult?.finalAnalysis ?? workflowResult, game);
        if (v2Result.ok === false) {
          // No in-run retry and no extra call. Failure 1: rejudge_count 1, re-judged next run.
          // Failure 2: stored as 'pass' with validation_flag 'validation_failed' and never re-judged.
          const prior = Number(existingJudgments?.get(game.eventId)?.rejudge_count ?? 0);
          const count = cfg ? await recordRejectedJudgmentV2(cfg, game, prior, fetchFn) : prior + 1;
          const f = v2Result as { reason: string };
          errors.push({
            eventId: game.eventId,
            error: `judge v2 output rejected (${f.reason}); failure ${count} of 2 (see [MorningJudge] warning)`
          });
          continue;
        }
        const j = (v2Result as { judgment: any }).judgment;
        if (cfg) {
          await upsertGameJudgmentV2(cfg, game, j, computeModelSnapshotV2(j, participatingSeatRoles), workflowResult?.workflowId, fetchFn);
        }
        if (isReplace) {
          replacedCount++;
        } else {
          judgedCount++;
        }
        continue;
      }

      const parsed = parseAndValidateJudgeOutput(
        workflowResult?.finalAnalysis ?? workflowResult,
        game.homeTeam,
        game.awayTeam,
        game.sport,
        workflowResult?.workflowId,
        // ESPN's spread is home perspective like fairSpread; used for the |fair - market| caps (livetest bug 1)
        { spread: game.oddsSnapshot?.spread ?? null, total: game.oddsSnapshot?.overUnder ?? null }
      );

      if (!parsed) {
        // Nothing is written for this game (the upsert below is skipped). No retry or fallback judge in this run:
        // the game stays claimed for MORNING_CLAIM_TTL_MS and the next run judges it again.
        errors.push({
          eventId: game.eventId,
          error: "judge output missing, malformed or inconsistent (see [MorningJudge] warning)"
        });
        continue;
      }

      const modelSnapshot = computeModelSnapshot(game, parsed.winProbHome, parsed, participatingSeatRoles);

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
    const settled = await gradeAndRecordFinalGames(cfg, slate.games, gameDate, fetchFn, v2 ? { v2 } : undefined);
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
    skippedClaimed,
    snapshots: snapshotsCount,
    errors,
    settled: settledCount
  };
}
