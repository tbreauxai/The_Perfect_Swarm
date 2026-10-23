import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryCortex } from '../memory.ts';
import { SwarmContext } from '../context.ts';
import { ToolRegistry } from '../tools/index.ts';
import { resolveMemoryGrounding } from '../engine/memoryGrounding.ts';
import { formatLearnedVerdictContent } from '../engine/learningPipeline.ts';
import {
  fetchPregameLearningContext,
  hydrateCalibrationFromSupabase,
  type SupabaseConfig
} from './supabase.ts';
import { gradeAndRecordFinalGames, DEFAULT_MORNING_SWARM_SEATS } from './feedback.ts';
import { computeModelSnapshot } from './judgePrompt.ts';
import { analystLedger } from '../feedback.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { fitCalibration, observationsForApp } from '../feedback/probabilityCalibration.ts';
import type { SlateGame } from './types.ts';

describe('Closed-Loop Learning & Calibration Upgrades (Qdrant + Supabase)', () => {
  const cfg: SupabaseConfig = {
    supabaseUrl: 'https://test.supabase.co',
    supabaseServiceKey: 'test-service-key'
  };

  const sampleGame: SlateGame = {
    eventId: 'nba-401999001',
    sport: 'basketball_nba',
    league: 'nba',
    homeTeam: 'Boston Celtics',
    awayTeam: 'New York Knicks',
    commenceTime: '2026-10-24T23:30:00Z',
    gameDate: '2026-10-24',
    weatherSnapshot: { isIndoor: true },
    oddsSnapshot: {
      provider: 'DraftKings',
      spread: -6.5,
      overUnder: 224.5,
      homeMoneyLine: -250,
      awayMoneyLine: 205
    },
    rawEvent: {
      completed: true,
      homeScore: 114,
      awayScore: 102
    }
  };

  beforeEach(() => {
    analystLedger.clear();
    globalSpecialistProfiler.reset();
  });

  it('enriches Qdrant stored verdicts with full structured DuelOdds judgments and arguments instead of bare ui_title', () => {
    const verdict = {
      ui_title: 'Analysis complete',
      likelyWinner: 'Boston Celtics',
      winProbHome: 0.68,
      winProbAway: 0.32,
      fairSpread: -5.5,
      fairTotal: 222.0,
      totalLean: 'under',
      arguments: [
        {
          claim: 'Celtics half-court offensive rating +6.4 over Knicks perimeter defense',
          advocate: 'quant',
          weight: 'high',
          supportingData: 'ORTG 119.2 vs 112.8'
        }
      ],
      invalidationConditions: ['Jayson Tatum late scratch']
    };

    const content = formatLearnedVerdictContent(
      'EVENT: New York Knicks @ Boston Celtics',
      verdict,
      'Verified by Risk Critic'
    );

    expect(content).toContain('LikelyWinner=Boston Celtics');
    expect(content).toContain('WinProbHome=68.0%');
    expect(content).toContain('FairSpread=-5.5');
    expect(content).toContain('ORTG 119.2 vs 112.8');
    expect(content).toContain('Jayson Tatum late scratch');
  });

  it('retrieves both validated wins and graded loss post-mortems even when bypassCache is true', async () => {
    const cortex = new MemoryCortex({
      collectionName: 'test_contrastive_cortex',
      defaultAppId: 'duelodds',
      isolatedStore: true,
      autoSave: false
    });

    await cortex.store(
      'Task: Knicks @ Celtics\nVerdict: LikelyWinner=Boston Celtics | WinProbHome=70.0% | FairSpread=-6.5',
      {
        workflowId: 'wf-win-1',
        originApp: 'duelodds',
        domain: 'sports-betting',
        entityIds: ['celtics', 'knicks']
      },
      false
    );
    await cortex.gradeMemoryByWorkflowId({
      workflowId: 'wf-win-1',
      originApp: 'duelodds',
      outcome: 'win',
      brierScore: 0.09,
      margin: 12,
      predictedProbability: 0.7
    });

    await cortex.store(
      'Task: Knicks @ Celtics\nVerdict: LikelyWinner=Boston Celtics | WinProbHome=78.0% | FairSpread=-9.5 (overrated home bench)',
      {
        workflowId: 'wf-loss-1',
        originApp: 'duelodds',
        domain: 'sports-betting',
        entityIds: ['celtics', 'knicks']
      },
      false
    );
    await cortex.gradeMemoryByWorkflowId({
      workflowId: 'wf-loss-1',
      originApp: 'duelodds',
      outcome: 'loss',
      brierScore: 0.608,
      margin: -7,
      predictedProbability: 0.78,
      settledSummary: 'Knicks 109 @ Celtics 102 (LOSS)'
    });

    const ctx = new SwarmContext();
    const grounding = await resolveMemoryGrounding({
      memoryCortex: cortex,
      task: 'EVENT: New York Knicks @ Boston Celtics',
      targetAppId: 'duelodds',
      includeShared: true,
      bypassCache: true, // Should skip action plan cache, NOT episodic/contrastive retrieval
      toolRegistry: new ToolRegistry(),
      context: ctx
    });

    expect(grounding.actionPlanBypassedQdrant).toBe(false);
    expect(grounding.historicalContext).toContain('[Contrastive Episodic Memory: Validated Wins vs. Past Pitfalls]');
    expect(grounding.historicalContext).toContain('VALIDATED WINNING PATTERNS:');
    expect(grounding.historicalContext).toContain('GRADED LOSS POST-MORTEMS (AVOID REPEATING THESE BIASES):');
    expect(grounding.historicalContext).toContain('Brier=0.608');
    expect(grounding.historicalContext).toContain('Knicks 109 @ Celtics 102 (LOSS)');
  });

  it('computes live line-movement steam delta and team-specific historical calibration from Supabase', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('line_snapshots?event_id=')) {
        return new Response(
          JSON.stringify([
            {
              spread: -4.5,
              total: 221.5,
              ml_home: -190,
              ml_away: 160,
              snapshot_at: '2026-10-24T12:00:00Z',
              is_baseline: true
            },
            {
              spread: -6.5,
              total: 224.5,
              ml_home: -250,
              ml_away: 205,
              snapshot_at: '2026-10-24T18:00:00Z',
              is_baseline: false
            }
          ]),
          { status: 200 }
        );
      }
      if (u.includes('game_judgments?status=eq.final')) {
        return new Response(
          JSON.stringify([
            {
              home_team: 'Boston Celtics',
              away_team: 'Miami Heat',
              win_prob_home: 0.65,
              fair_spread: -5.0,
              result: { outcome: 'win', margin: 9, home_win: true },
              brier: 0.122
            },
            {
              home_team: 'New York Knicks',
              away_team: 'Boston Celtics',
              win_prob_home: 0.58,
              fair_spread: -2.5,
              result: { outcome: 'loss', margin: -6, home_win: false },
              brier: 0.336
            }
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    });

    const pregame = await fetchPregameLearningContext(cfg, sampleGame, fetchMock as unknown as typeof fetch);

    expect(pregame.lineMovement).not.toBeNull();
    expect(pregame.lineMovement?.openingSpread).toBe(-4.5);
    expect(pregame.lineMovement?.currentSpread).toBe(-6.5);
    expect(pregame.lineMovement?.spreadDelta).toBe(-2);
    expect(pregame.lineMovement?.steamDirection).toBe('home_steam');
    expect(pregame.teamHistory?.sampleCount).toBe(2);
    expect(pregame.teamHistory?.wins).toBe(1);
    expect(pregame.teamHistory?.losses).toBe(1);
    expect(pregame.formattedBlock).toContain('[SUPABASE LIVE MARKET STEAM & TEAM CALIBRATION HISTORY]');
    expect(pregame.formattedBlock).toContain('Signal=home_steam');
  });

  it('hydrates probability calibration from settled Supabase game_judgments rows and attributes settled games to all 4 Morning Swarm seats', async () => {
    const settledRows = Array.from({ length: 10 }, (_, idx) => ({
      event_id: `nba-hist-${idx}`,
      workflow_id: `wf-hist-${idx}`,
      win_prob_home: 0.72,
      sport: 'basketball_nba',
      result: { outcome: idx < 8 ? 'win' : 'loss', home_win: idx < 8 },
      judged_at: '2026-10-20T12:00:00Z'
    }));

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('game_judgments?status=eq.final&brier=not.is.null')) {
        return new Response(JSON.stringify(settledRows), { status: 200 });
      }
      if (u.includes('game_judgments?game_date=') && init?.method === 'GET') {
        return new Response(
          JSON.stringify([
            {
              event_id: sampleGame.eventId,
              workflow_id: 'wf-live-celtics-1',
              win_prob_home: 0.68,
              sport: 'basketball_nba',
              home_team: 'Boston Celtics',
              away_team: 'New York Knicks'
            }
          ]),
          { status: 200 }
        );
      }
      return new Response(null, { status: 204 });
    });

    const hydratedCount = await hydrateCalibrationFromSupabase(cfg, fetchMock as unknown as typeof fetch);
    expect(hydratedCount).toBe(10);

    const fit = fitCalibration(observationsForApp('duelodds'));
    expect(fit.sampleSize).toBeGreaterThanOrEqual(10);
    expect(fit.brier).toBeGreaterThan(0);

    const snap = computeModelSnapshot(sampleGame, 0.68, null, [...DEFAULT_MORNING_SWARM_SEATS]);
    expect(snap.participating_seats).toEqual([...DEFAULT_MORNING_SWARM_SEATS]);

    const settled = await gradeAndRecordFinalGames(
      cfg,
      [sampleGame],
      sampleGame.gameDate,
      fetchMock as unknown as typeof fetch
    );

    expect(settled).toHaveLength(1);
    for (const seat of DEFAULT_MORNING_SWARM_SEATS) {
      const rec = analystLedger.getRecord('duelodds', seat);
      expect(rec?.wins).toBe(1);
      const prof = globalSpecialistProfiler.getProfile(seat);
      expect(prof?.accuracyWins).toBe(1);
    }
  });
});
