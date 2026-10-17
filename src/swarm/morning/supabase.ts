import type { SlateGame, MorningJudgeOutput, LineSnapshotInsert } from './types.ts';

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseServiceKey: string;
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
  fetchFn: typeof fetch = fetch
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
      `game_judgments?game_date=eq.${encodeURIComponent(gameDate)}&select=event_id,judge_source,workflow_id,status,win_prob_home,likely_winner,home_team,away_team`,
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
