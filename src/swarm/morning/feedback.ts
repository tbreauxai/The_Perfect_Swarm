import {
  recordProbabilityObservation,
  outcomeToScore
} from '../feedback/probabilityCalibration.ts';
import { globalFeedbackEngine, analystLedger } from '../feedback.ts';
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
}

/**
 * Checks judged games against ESPN final results, settles completed games,
 * and passes the learning signal to the continuous calibration engine.
 */
export async function gradeAndRecordFinalGames(
  cfg: SupabaseConfig | null,
  games: SlateGame[],
  gameDate: string,
  fetchFn: typeof fetch = fetch
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
        `game_judgments?game_date=eq.${encodeURIComponent(gameDate)}&status=neq.final&select=event_id,workflow_id,win_prob_home,sport,home_team,away_team`,
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

    const { homeScore, awayScore } = scoreData;
    const outcome: 'win' | 'loss' | 'push' = homeScore > awayScore ? 'win' : homeScore < awayScore ? 'loss' : 'push';
    const score = outcomeToScore(outcome);
    const winProbHome = Number(judgment.win_prob_home ?? 0.5);
    const workflowId = judgment.workflow_id;
    const sportKey = judgment.sport || 'unknown';

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

      // 2. Feed into analyst ledger
      analystLedger.recordOutcome('duelodds', 'Manager Node', outcome);
      analystLedger.recordOutcome('duelodds', 'Quant Specialist', outcome);

      // 3. Persist outcome in continuous feedback knowledge repository
      try {
        globalFeedbackEngine.getKnowledgeRepository().persistOutcome({
          workflowId,
          appId: 'duelodds',
          task: `Morning Judgment: ${judgment.away_team} @ ${judgment.home_team}`,
          outcome,
          agentRoles: ['Manager Node', 'Quant Specialist'],
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

      // 4. Mark row status = 'final' in Supabase
      // Same shape and Brier formula as the DuelOdds Worker grader (cloudflare/src/morningJudgments.ts), which
      // DuelOdds learningLedgers reads (result.home_win, result.margin, brier). A push counts as home_win false.
      const homeWin = homeScore > awayScore;
      const brier = Number.isFinite(winProbHome)
        ? Math.round(Math.pow(winProbHome - (homeWin ? 1 : 0), 2) * 1000) / 1000
        : null;
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
        awayScore
      });
    }
  }

  return settledOutcomes;
}
