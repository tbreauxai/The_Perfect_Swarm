import type { SlateGame, MorningJudgeOutput, LineSnapshotInsert } from './types.ts';
import type { JudgmentV2 } from './judgment.ts';
import {
  recordProbabilityObservation,
  outcomeToScore
} from '../feedback/probabilityCalibration.ts';

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseServiceKey: string;
}

export interface PregameLearningContext {
  lineMovement: {
    snapshotsCount: number;
    openingSpread: number | null;
    currentSpread: number | null;
    spreadDelta: number | null;
    openingTotal: number | null;
    currentTotal: number | null;
    totalDelta: number | null;
    openingMlHome: number | null;
    currentMlHome: number | null;
    steamDirection: 'home_steam' | 'away_steam' | 'neutral';
  } | null;
  teamHistory: {
    sampleCount: number;
    wins: number;
    losses: number;
    avgBrier: number | null;
    meanSpreadErrorHomePerspective: number | null;
    recentNotes: string[];
  } | null;
  formattedBlock: string;
}

export function getSupabaseConfig(env: Record<string, string | undefined> = process.env): SupabaseConfig | null {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SERVICE_KEY?.trim();

  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }
  return { supabaseUrl, supabaseServiceKey };
}

/**
 * Raw PostgREST query helper using fetch.
 */
export async function querySupabase(
  cfg: SupabaseConfig,
  path: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch
): Promise<any> {
  const res = await fetchFn(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.supabaseServiceKey,
      Authorization: `Bearer ${cfg.supabaseServiceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(init.headers || {})
    }
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Supabase request failed [${res.status}]: ${errorText}`);
  }

  if (res.status === 201 || res.status === 204) {
    return null;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Reads existing game_judgments for the date and partitions slate games into:
 * - gamesToJudge: newly encountered games
 * - gamesToReplace: games with direct/null judge_source, or a swarm awaiting_lines row whose lines have now arrived
 * - skippedCount: games already judged by swarm today (R3-S1: including awaiting_lines rows while there are still no lines)
 */
export async function partitionSlateGames(
  cfg: SupabaseConfig | null,
  games: SlateGame[],
  gameDate: string,
  fetchFn: typeof fetch = fetch,
  /** JUDGMENT_SCHEMA_V2: also read the v2 bookkeeping columns. Off = the select is exactly as before. */
  v2: boolean = false
): Promise<{
  gamesToJudge: SlateGame[];
  gamesToReplace: SlateGame[];
  skippedCount: number;
  existingJudgments: Map<string, any>;
}> {
  if (!cfg) {
    // If Supabase is not configured, judge all games without persistence
    return {
      gamesToJudge: games,
      gamesToReplace: [],
      skippedCount: 0,
      existingJudgments: new Map()
    };
  }

  let rows: any[] = [];
  try {
    const data = await querySupabase(
      cfg,
      `game_judgments?game_date=eq.${encodeURIComponent(gameDate)}&select=event_id,judge_source,workflow_id,status,win_prob_home,likely_winner,home_team,away_team${v2 ? ',schema_version,side,rejudge_count,validation_flag' : ''}`,
      { method: 'GET', headers: { Prefer: 'return=representation' } },
      fetchFn
    );
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    rows = [];
  }

  const rowMap = new Map<string, any>();
  for (const r of rows) {
    if (r.event_id) {
      rowMap.set(r.event_id, r);
    }
  }

  const gamesToJudge: SlateGame[] = [];
  const gamesToReplace: SlateGame[] = [];
  let skippedCount = 0;

  for (const game of games) {
    const existing = rowMap.get(game.eventId);
    if (!existing) {
      gamesToJudge.push(game);
    } else if (v2 && existing.validation_flag === 'validation_failed') {
      // v2: failed validation on 2 runs; stored as 'pass', never re-judged.
      skippedCount++;
    } else if (v2 && Number(existing.schema_version) === 2 && existing.side == null) {
      // v2: a rejected judgment left only rejudge_count; judge it again on this run.
      gamesToReplace.push(game);
    } else if (existing.judge_source === 'swarm' && (existing.status !== 'awaiting_lines' || !game.oddsSnapshot)) {
      // R3-S1: a swarm judgment today is never redone. The one exception is an awaiting_lines row once the
      // scoreboard has lines (re-judged once; the new row is 'judged'). Before, awaiting_lines games were re-judged every run.
      skippedCount++;
    } else {
      gamesToReplace.push(game);
    }
  }

  return {
    gamesToJudge,
    gamesToReplace,
    skippedCount,
    existingJudgments: rowMap
  };
}

/**
 * Upserts a game_judgment row with judge_source: "swarm" and real workflow_id.
 */
export async function upsertGameJudgment(
  cfg: SupabaseConfig,
  game: SlateGame,
  judgment: MorningJudgeOutput,
  modelSnapshot: Record<string, any>,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  if (judgment.winProbHome === 0.5 && judgment.fairSpread === 0 && !judgment.isExplicit) {
    throw new Error(`Refusing to write default 50%/0 judgment for ${game.eventId}: not explicitly returned by judge`);
  }

  const inputs = ['swarm_intelligence'];
  if (game.oddsSnapshot) inputs.push('odds');
  if (game.weatherSnapshot) inputs.push('weather');

  const row: Record<string, any> = {
    game_date: game.gameDate,
    sport: game.sport,
    event_id: game.eventId,
    workflow_id: judgment.workflowId || null,
    judge_source: 'swarm',
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    commence_time: game.commenceTime,
    likely_winner: judgment.likelyWinner,
    win_prob_home: judgment.winProbHome,
    win_prob_away: judgment.winProbAway,
    fair_spread: judgment.fairSpread,
    fair_total: judgment.fairTotal,
    total_lean: judgment.totalLean,
    arguments: judgment.arguments,
    invalidation_conditions: judgment.invalidationConditions,
    weather_snapshot: game.weatherSnapshot ?? { isIndoor: true },
    odds_snapshot: game.oddsSnapshot,
    status: game.oddsSnapshot ? 'judged' : 'awaiting_lines',
    judged_at: new Date().toISOString(),
    data_as_of: judgment.dataAsOf,
    inputs_present: inputs,
    model_snapshot: modelSnapshot
  };

  await querySupabase(
    cfg,
    'game_judgments?on_conflict=game_date,event_id',
    {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(row)
    },
    fetchFn
  );
}

/** v2 failures allowed (one per run) before a game is stored as 'pass' with validation_flag 'validation_failed'. */
export const JUDGMENT_V2_MAX_FAILURES = 2;

function v2BaseRow(game: SlateGame): Record<string, any> {
  const inputs = ['swarm_intelligence'];
  if (game.oddsSnapshot) inputs.push('odds');
  if (game.weatherSnapshot) inputs.push('weather');
  return {
    game_date: game.gameDate,
    sport: game.sport,
    event_id: game.eventId,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    commence_time: game.commenceTime,
    weather_snapshot: game.weatherSnapshot ?? { isIndoor: true },
    odds_snapshot: game.oddsSnapshot,
    status: game.oddsSnapshot ? 'judged' : 'awaiting_lines',
    inputs_present: inputs,
    schema_version: 2
  };
}

async function postJudgmentRow(cfg: SupabaseConfig, row: Record<string, any>, fetchFn: typeof fetch): Promise<void> {
  await querySupabase(
    cfg,
    'game_judgments?on_conflict=game_date,event_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row)
    },
    fetchFn
  );
}

/**
 * JUDGMENT_SCHEMA_V2 upsert: the judge's projections only. Writes no win_prob_* / fair_* (DuelOdds code derives
 * win_prob_home_code, fair_*_code, devig_home and ev_* and stamps math_version). rejudge_count is left as is.
 */
export async function upsertGameJudgmentV2(
  cfg: SupabaseConfig,
  game: SlateGame,
  judgment: JudgmentV2,
  modelSnapshot: Record<string, any>,
  workflowId: string | null | undefined,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const likelyWinner = judgment.side === 'home' ? game.homeTeam : judgment.side === 'away' ? game.awayTeam : null;
  await postJudgmentRow(cfg, {
    ...v2BaseRow(game),
    workflow_id: workflowId || null,
    judge_source: 'swarm',
    likely_winner: likelyWinner,
    total_lean: judgment.totalLean === 'pass' ? 'none' : judgment.totalLean,
    arguments: judgment.reasons.map(claim => ({ claim, advocate: 'judge', weight: 'medium' })),
    invalidation_conditions: [],
    judged_at: new Date().toISOString(),
    data_as_of: new Date().toISOString(),
    model_snapshot: modelSnapshot,
    proj_margin: judgment.projMargin,
    proj_total: judgment.projTotal,
    side: judgment.side,
    confidence: judgment.confidence,
    reasons: judgment.reasons,
    validation_flag: null
  }, fetchFn);
}

/**
 * JUDGMENT_SCHEMA_V2 rejection bookkeeping (no in-run retry). Failure 1: the row gets rejudge_count 1 and no side,
 * so the next run judges it again. Failure 2: side 'pass' + validation_flag 'validation_failed', never re-judged.
 * Returns the new rejudge_count.
 */
export async function recordRejectedJudgmentV2(
  cfg: SupabaseConfig,
  game: SlateGame,
  priorRejudgeCount: number,
  fetchFn: typeof fetch = fetch
): Promise<number> {
  const count = (Number.isFinite(priorRejudgeCount) && priorRejudgeCount > 0 ? Math.floor(priorRejudgeCount) : 0) + 1;
  const row: Record<string, any> = { ...v2BaseRow(game), rejudge_count: count };
  if (count >= JUDGMENT_V2_MAX_FAILURES) {
    row.judge_source = 'swarm';
    row.side = 'pass';
    row.validation_flag = 'validation_failed';
    row.judged_at = new Date().toISOString();
  }
  await postJudgmentRow(cfg, row, fetchFn);
  return count;
}

/**
 * Writes one line_snapshots row per game with scoreboard odds.
 * Fields: event_id, game_date, sport, book, market: "all", spread, total, ml_home, ml_away, snapshot_at, is_baseline.
 * is_baseline is true only for the first row of a (game_date, event_id); a moved line is inserted with is_baseline: false.
 * (The live partial unique index line_snapshots_one_baseline allows one baseline per game_date + event_id.)
 * Does not send game_id. Skips if an identical line already exists (null-safe, numeric compare).
 */
export async function insertBaselineLineSnapshots(
  cfg: SupabaseConfig,
  games: SlateGame[],
  fetchFn: typeof fetch = fetch
): Promise<number> {
  let inserted = 0;

  for (const game of games) {
    if (!game.oddsSnapshot) continue;

    const spread = game.oddsSnapshot.spread ?? null;
    const total = game.oddsSnapshot.overUnder ?? null;
    const ml_home = game.oddsSnapshot.homeMoneyLine ?? null;
    const ml_away = game.oddsSnapshot.awayMoneyLine ?? null;

    if (spread === null && total === null && ml_home === null && ml_away === null) {
      continue;
    }

    try {
      // Check if identical line already exists
      const existing = await querySupabase(
        cfg,
        `line_snapshots?event_id=eq.${encodeURIComponent(game.eventId)}&order=snapshot_at.desc&limit=1&select=spread,total,ml_home,ml_away`,
        { method: 'GET', headers: { Prefer: 'return=representation' } },
        fetchFn
      );

      if (Array.isArray(existing) && existing.length > 0) {
        const prev = existing[0];
        // Null-safe numeric compare: null == null, and "-1.5" (numeric returned as text) == -1.5.
        const same = (a: unknown, b: unknown) =>
          (a == null && b == null) ||
          (a != null && b != null && Number(a) === Number(b));
        if (
          same(prev.spread, spread) &&
          same(prev.total, total) &&
          same(prev.ml_home, ml_home) &&
          same(prev.ml_away, ml_away)
        ) {
          // Identical line already recorded; skip
          continue;
        }
      }

      // Only the first snapshot of a (game_date, event_id) is the baseline. A second is_baseline row violates the
      // partial unique index line_snapshots_one_baseline (409/23505), which is what happened when NBA lines moved.
      const baseline = await querySupabase(
        cfg,
        `line_snapshots?game_date=eq.${encodeURIComponent(game.gameDate)}&event_id=eq.${encodeURIComponent(game.eventId)}&is_baseline=eq.true&select=id&limit=1`,
        { method: "GET", headers: { Prefer: "return=representation" } },
        fetchFn,
      );
      const hasBaseline = Array.isArray(baseline) && baseline.length > 0;

      const snapshotRow: LineSnapshotInsert = {
        event_id: game.eventId,
        game_date: game.gameDate,
        sport: game.sport,
        book: game.oddsSnapshot.provider || 'ESPN/DraftKings',
        market: 'all',
        spread,
        total,
        ml_home,
        ml_away,
        snapshot_at: new Date().toISOString(),
        is_baseline: !hasBaseline
      };

      await querySupabase(
        cfg,
        'line_snapshots',
        {
          method: 'POST',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify(snapshotRow)
        },
        fetchFn
      );

      inserted++;
    } catch (err) {
      // Non-fatal logging for line snapshot insert
      console.warn(`[Morning Line Snapshot] Failed to insert for ${game.eventId}:`, err);
    }
  }

  return inserted;
}

/**
 * Hydrates in-memory probability calibration from settled Supabase `game_judgments` rows
 * so cold restarts immediately recover empirical logit bias and Brier telemetry.
 */
export async function hydrateCalibrationFromSupabase(
  cfg: SupabaseConfig | null,
  fetchFn: typeof fetch = fetch
): Promise<number> {
  if (!cfg) return 0;
  try {
    const rows = await querySupabase(
      cfg,
      'game_judgments?status=eq.final&brier=not.is.null&order=judged_at.desc&limit=200&select=event_id,workflow_id,win_prob_home,sport,result,judged_at',
      { method: 'GET', headers: { Prefer: 'return=representation' } },
      fetchFn
    );
    if (!Array.isArray(rows)) return 0;

    let count = 0;
    for (const r of rows) {
      const wfId = r.workflow_id || `supabase-${r.event_id}`;
      const prob = Number(r.win_prob_home);
      const outcomeStr = r.result?.outcome || (r.result?.home_win === true ? 'win' : r.result?.home_win === false ? 'loss' : '');
      const score = outcomeToScore(String(outcomeStr));
      if (!Number.isFinite(prob) || prob <= 0 || prob >= 1 || score == null) continue;
      recordProbabilityObservation({
        workflowId: String(wfId),
        appId: 'duelodds',
        predictedProbability: prob,
        outcome: score,
        sportKey: typeof r.sport === 'string' ? r.sport : undefined,
        gradedAt: String(r.judged_at || r.result?.settled_at || new Date().toISOString())
      });
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Queries Supabase `line_snapshots` and settled `game_judgments` for a matchup prior to judging:
 * 1. Computes opening-to-current spread/total/ML steam movement for `game.eventId`.
 * 2. Computes historical model spread error and Brier accuracy for `game.homeTeam` and `game.awayTeam`.
 */
export async function fetchPregameLearningContext(
  cfg: SupabaseConfig | null,
  game: SlateGame,
  fetchFn: typeof fetch = fetch
): Promise<PregameLearningContext> {
  const empty: PregameLearningContext = {
    lineMovement: null,
    teamHistory: null,
    formattedBlock: ''
  };
  if (!cfg) return empty;

  let lineMovement: PregameLearningContext['lineMovement'] = null;
  let teamHistory: PregameLearningContext['teamHistory'] = null;

  // 1. Line movement lookup from line_snapshots
  try {
    const snaps = await querySupabase(
      cfg,
      `line_snapshots?event_id=eq.${encodeURIComponent(game.eventId)}&order=snapshot_at.asc&select=spread,total,ml_home,ml_away,snapshot_at,is_baseline`,
      { method: 'GET', headers: { Prefer: 'return=representation' } },
      fetchFn
    );

    if (Array.isArray(snaps) && snaps.length > 0) {
      const baselineRow = snaps.find((s: any) => s.is_baseline) || snaps[0];
      const latestRow = snaps[snaps.length - 1];

      const openSpread = baselineRow.spread != null ? Number(baselineRow.spread) : null;
      const currSpread = (game.oddsSnapshot?.spread ?? latestRow.spread) != null
        ? Number(game.oddsSnapshot?.spread ?? latestRow.spread)
        : null;
      const spreadDelta = openSpread != null && currSpread != null && Number.isFinite(openSpread) && Number.isFinite(currSpread)
        ? Math.round((currSpread - openSpread) * 100) / 100
        : null;

      const openTotal = baselineRow.total != null ? Number(baselineRow.total) : null;
      const currTotal = (game.oddsSnapshot?.overUnder ?? latestRow.total) != null
        ? Number(game.oddsSnapshot?.overUnder ?? latestRow.total)
        : null;
      const totalDelta = openTotal != null && currTotal != null && Number.isFinite(openTotal) && Number.isFinite(currTotal)
        ? Math.round((currTotal - openTotal) * 100) / 100
        : null;

      const openMlHome = baselineRow.ml_home != null ? Number(baselineRow.ml_home) : null;
      const currMlHome = (game.oddsSnapshot?.homeMoneyLine ?? latestRow.ml_home) != null
        ? Number(game.oddsSnapshot?.homeMoneyLine ?? latestRow.ml_home)
        : null;

      let steamDirection: 'home_steam' | 'away_steam' | 'neutral' = 'neutral';
      if (spreadDelta != null) {
        // Home spread becoming more negative (e.g. -2.5 -> -4.0, delta = -1.5) means money steaming toward Home
        if (spreadDelta <= -0.5) steamDirection = 'home_steam';
        else if (spreadDelta >= 0.5) steamDirection = 'away_steam';
      } else if (openMlHome != null && currMlHome != null) {
        if (currMlHome - openMlHome <= -15) steamDirection = 'home_steam';
        else if (currMlHome - openMlHome >= 15) steamDirection = 'away_steam';
      }

      lineMovement = {
        snapshotsCount: snaps.length,
        openingSpread: openSpread,
        currentSpread: currSpread,
        spreadDelta,
        openingTotal: openTotal,
        currentTotal: currTotal,
        totalDelta,
        openingMlHome: openMlHome,
        currentMlHome: currMlHome,
        steamDirection
      };
    }
  } catch {
    // Non-fatal
  }

  // 2. Historical team calibration lookup from settled game_judgments
  try {
    const settledRows = await querySupabase(
      cfg,
      `game_judgments?status=eq.final&sport=eq.${encodeURIComponent(game.sport)}&order=game_date.desc&limit=40&select=home_team,away_team,win_prob_home,fair_spread,result,brier`,
      { method: 'GET', headers: { Prefer: 'return=representation' } },
      fetchFn
    );

    if (Array.isArray(settledRows) && settledRows.length > 0) {
      const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const targetHome = norm(game.homeTeam);
      const targetAway = norm(game.awayTeam);

      const matching = settledRows.filter((r: any) => {
        const rh = norm(r.home_team || '');
        const ra = norm(r.away_team || '');
        return (
          (targetHome && (rh.includes(targetHome) || targetHome.includes(rh) || ra.includes(targetHome) || targetHome.includes(ra))) ||
          (targetAway && (rh.includes(targetAway) || targetAway.includes(rh) || ra.includes(targetAway) || targetAway.includes(ra)))
        );
      });

      if (matching.length > 0) {
        let wins = 0;
        let losses = 0;
        let brierSum = 0;
        let brierCount = 0;
        let spreadErrorSum = 0;
        let spreadErrorCount = 0;
        const recentNotes: string[] = [];

        for (const r of matching.slice(0, 8)) {
          const outcome = r.result?.outcome;
          if (outcome === 'win') wins++;
          else if (outcome === 'loss') losses++;

          if (typeof r.brier === 'number' && Number.isFinite(r.brier)) {
            brierSum += r.brier;
            brierCount++;
          }

          const fairSpread = Number(r.fair_spread);
          const actualMargin = Number(r.result?.margin);
          if (Number.isFinite(fairSpread) && Number.isFinite(actualMargin)) {
            // Projected home margin is -fairSpread; error = actualMargin - projectedMargin
            const projectedMargin = -fairSpread;
            spreadErrorSum += actualMargin - projectedMargin;
            spreadErrorCount++;
          }

          if (recentNotes.length < 3 && r.home_team && r.away_team) {
            const brierStr = typeof r.brier === 'number' ? `, Brier=${r.brier.toFixed(3)}` : '';
            const marginStr = r.result?.margin != null ? `, Margin=${r.result.margin > 0 ? '+' : ''}${r.result.margin}` : '';
            recentNotes.push(
              `${r.away_team} @ ${r.home_team}: P(Home)=${(Number(r.win_prob_home ?? 0.5) * 100).toFixed(0)}%, FairSpread=${r.fair_spread ?? 'N/A'} -> ${outcome || 'settled'}${marginStr}${brierStr}`
            );
          }
        }

        teamHistory = {
          sampleCount: matching.length,
          wins,
          losses,
          avgBrier: brierCount > 0 ? Math.round((brierSum / brierCount) * 1000) / 1000 : null,
          meanSpreadErrorHomePerspective: spreadErrorCount > 0 ? Math.round((spreadErrorSum / spreadErrorCount) * 100) / 100 : null,
          recentNotes
        };
      }
    }
  } catch {
    // Non-fatal
  }

  const lines: string[] = [];
  if (lineMovement) {
    const spreadDesc = lineMovement.openingSpread != null && lineMovement.currentSpread != null
      ? `Spread ${lineMovement.openingSpread} -> ${lineMovement.currentSpread} (Δ=${lineMovement.spreadDelta != null && lineMovement.spreadDelta > 0 ? '+' : ''}${lineMovement.spreadDelta ?? 0})`
      : 'Spread unchanged/unavailable';
    const totalDesc = lineMovement.openingTotal != null && lineMovement.currentTotal != null
      ? `Total ${lineMovement.openingTotal} -> ${lineMovement.currentTotal} (Δ=${lineMovement.totalDelta != null && lineMovement.totalDelta > 0 ? '+' : ''}${lineMovement.totalDelta ?? 0})`
      : 'Total unchanged/unavailable';
    lines.push(
      `Line Movement (${lineMovement.snapshotsCount} snapshots, Signal=${lineMovement.steamDirection}): ${spreadDesc} | ${totalDesc}`
    );
  }

  if (teamHistory && teamHistory.sampleCount > 0) {
    const brierPart = teamHistory.avgBrier != null ? `, AvgBrier=${teamHistory.avgBrier.toFixed(3)}` : '';
    const errPart = teamHistory.meanSpreadErrorHomePerspective != null
      ? `, MeanMarginError=${teamHistory.meanSpreadErrorHomePerspective > 0 ? '+' : ''}${teamHistory.meanSpreadErrorHomePerspective} pts`
      : '';
    lines.push(
      `Team Calibration History (${teamHistory.sampleCount} settled games: ${teamHistory.wins}W-${teamHistory.losses}L${brierPart}${errPart}):`
    );
    for (const note of teamHistory.recentNotes) {
      lines.push(`  • ${note}`);
    }
  }

  const formattedBlock = lines.length > 0
    ? `[SUPABASE LIVE MARKET STEAM & TEAM CALIBRATION HISTORY]\n${lines.join('\n')}`
    : '';

  return {
    lineMovement,
    teamHistory,
    formattedBlock
  };
}

