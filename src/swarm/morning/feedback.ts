import {
  recordProbabilityObservation,
  outcomeToScore
} from '../feedback/probabilityCalibration.ts';
import { globalFeedbackEngine, analystLedger } from '../feedback.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import type { MemoryCortex } from '../memory.ts';
import { querySupabase, type SupabaseConfig } from './supabase.ts';
import type { SlateGame } from './types.ts';

export interface FinalGameOutcome {
  eventId: string;
  workflowId: string;
  outcome: 'win' | 'loss' | 'push';
  winProbHome: number;
  sportKey: string;
  homeScore: number;
  awayScore: number;
  brier?: number | null;
  attributedSeats?: string[];
}

export const DEFAULT_MORNING_SWARM_SEATS = [
  'Quant Proposer',
  'Market Proposer',
  'Risk Critic',
  'GodView Compiler'
] as const;

/**
 * Checks judged games against ESPN final results, settles completed games,
 * and passes the learning signal to the continuous calibration engine,
 * per-seat analyst ledger, and UCB1 specialist capability profiler.
 */
export async function gradeAndRecordFinalGames(
  cfg: SupabaseConfig | null,
  games: SlateGame[],
  gameDate: string,
  fetchFn: typeof fetch = fetch,
  /** v2: JUDGMENT_SCHEMA_V2 grades on win_prob_home_code and skips rows without math_version. */
  options?: { cortex?: MemoryCortex; v2?: boolean }
): Promise<FinalGameOutcome[]> {
  const settledOutcomes: FinalGameOutcome[] = [];

  // Match completed games from the current slate
  const completedGamesMap = new Map<string, { homeScore: number; awayScore: number }>();
  for (const g of games) {
    if (g.rawEvent?.completed && g.rawEvent?.homeScore != null && g.rawEvent?.awayScore != null) {
      completedGamesMap.set(g.eventId, {
        homeScore: g.rawEvent.homeScore,
        awayScore: g.rawEvent.awayScore
      });
    }
  }

  if (completedGamesMap.size === 0 && !cfg) {
    return settledOutcomes;
  }

  let unfinalizedJudgments: any[] = [];
  if (cfg) {
    try {
      // Query judgments that are not yet marked as 'final'
      const data = await querySupabase(
        cfg,
        `game_judgments?game_date=eq.${encodeURIComponent(gameDate)}&status=neq.final&select=${options?.v2 ? 'event_id,workflow_id,win_prob_home_code,math_version,sport,home_team,away_team&math_version=not.is.null' : 'event_id,workflow_id,win_prob_home,sport,home_team,away_team'}`,
        { method: 'GET', headers: { Prefer: 'return=representation' } },
        fetchFn
      );
      unfinalizedJudgments = Array.isArray(data) ? data : [];
    } catch (err) {
      unfinalizedJudgments = [];
    }
  }

  for (const judgment of unfinalizedJudgments) {
    const scoreData = completedGamesMap.get(judgment.event_id);
    if (!scoreData) continue;
    if (options?.v2 && (judgment.math_version == null || judgment.win_prob_home_code == null)) continue;

    const { homeScore, awayScore } = scoreData;
    const outcome: 'win' | 'loss' | 'push' = homeScore > awayScore ? 'win' : homeScore < awayScore ? 'loss' : 'push';
    const score = outcomeToScore(outcome);
    const winProbHome = Number((options?.v2 ? judgment.win_prob_home_code : judgment.win_prob_home) ?? 0.5);
    const workflowId = judgment.workflow_id;
    const sportKey = judgment.sport || 'unknown';

    // Determine participating seats from model_snapshot if present, plus default 4-seat Morning topology
    const snapshotSeats: string[] = Array.isArray(judgment.model_snapshot?.participating_seats)
      ? judgment.model_snapshot.participating_seats
      : [...DEFAULT_MORNING_SWARM_SEATS];
    const attributedSeats = Array.from(new Set([
      ...snapshotSeats,
      'Manager Node',
      'Quant Specialist'
    ]));

    // 1. Record in probability calibration engine (moves calibration after 8 samples)
    if (workflowId && !workflowId.startsWith('wf-judgment-')) {
      if (score != null && Number.isFinite(winProbHome) && winProbHome > 0 && winProbHome < 1) {
        recordProbabilityObservation({
          workflowId,
          appId: 'duelodds',
          predictedProbability: winProbHome,
          outcome: score,
          sportKey,
          gradedAt: new Date().toISOString()
        });
      }

      // 2. Feed into analyst ledger & UCB1 specialist capability profiler for all participating seats
      for (const seat of attributedSeats) {
        analystLedger.recordOutcome('duelodds', seat, outcome);
        globalSpecialistProfiler.recordAccuracy(seat, outcome);
      }

      const isPush = outcome === 'push' || homeScore === awayScore;
      const homeWin = homeScore > awayScore;
      const brier = Number.isFinite(winProbHome)
        ? Math.round(Math.pow(winProbHome - (isPush ? 0.5 : (homeWin ? 1 : 0)), 2) * 1000) / 1000
        : null;

      // 3. Persist outcome in continuous feedback knowledge repository
      try {
        globalFeedbackEngine.getKnowledgeRepository().persistOutcome({
          workflowId,
          appId: 'duelodds',
          task: `Morning Judgment: ${judgment.away_team} @ ${judgment.home_team}`,
          outcome,
          predictedProbability: Number.isFinite(winProbHome) ? winProbHome : undefined,
          sportKey,
          agentRoles: attributedSeats,
          feedbackProcessed: true,
          metrics: {
            accuracyScore: outcome === 'win' ? 1.0 : outcome === 'loss' ? 0.0 : 0.5,
            durationMs: 0,
            tokensConsumed: 0,
            tokenSavings: 0,
            errorCount: 0,
            hardErrorCount: 0,
            failoverCount: 0,
            timestamp: Date.now()
          },
          gradedAt: Date.now()
        } as any);
      } catch (err) {
        // Non-fatal logging for knowledge repo persistence
      }

      // 3b. Grade corresponding episodic memory in MemoryCortex when provided
      if (options?.cortex) {
        try {
          await options.cortex.gradeMemoryByWorkflowId({
            workflowId,
            originApp: 'duelodds',
            outcome,
            brierScore: brier ?? undefined,
            margin: homeScore - awayScore,
            predictedProbability: Number.isFinite(winProbHome) ? winProbHome : undefined,
            settledSummary: `${judgment.away_team} ${awayScore} @ ${judgment.home_team} ${homeScore} (${outcome.toUpperCase()})`
          });
        } catch {
          // Non-fatal
        }
      }

      // 4. Mark row status = 'final' in Supabase
      // Same shape and Brier formula as the DuelOdds Worker grader (cloudflare/src/morningJudgments.ts), which
      // DuelOdds learningLedgers reads (result.home_win, result.margin, brier). A push counts as home_win false.
      if (cfg) {
        try {
          await querySupabase(
            cfg,
            `game_judgments?game_date=eq.${encodeURIComponent(gameDate)}&event_id=eq.${encodeURIComponent(judgment.event_id)}`,
            {
              method: 'PATCH',
              // The live column is `result` jsonb; there is no final_result column (that PATCH failed with PGRST204).
              body: JSON.stringify({
                status: 'final',
                result: {
                  home_score: homeScore,
                  away_score: awayScore,
                  home_win: homeWin,
                  margin: homeScore - awayScore,
                  total: homeScore + awayScore,
                  outcome,
                  settled_at: new Date().toISOString(),
                },
                brier,
              })
            },
            fetchFn
          );
        } catch (patchErr) {
          console.warn(`[Morning Feedback] Failed to patch game_judgments status for ${judgment.event_id}:`, patchErr);
        }
      }

      settledOutcomes.push({
        eventId: judgment.event_id,
        workflowId,
        outcome,
        winProbHome,
        sportKey,
        homeScore,
        awayScore,
        brier,
        attributedSeats
      });
    }
  }

  return settledOutcomes;
}

