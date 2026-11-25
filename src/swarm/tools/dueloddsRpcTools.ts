/**
 * Deterministic DuelOdds Database RPC & Historical Lessons Swarm Tools.
 * Conforms to SwarmTool contract with strict input validation,
 * deterministic execution, dome short-circuiting, and token-dense formatting (<= 250 tokens).
 */

import type { SwarmTool } from './types.ts';
import { QdrantClient } from '@qdrant/js-client-rest';
import { resolveInjuryTeam, matchTeamByLabel } from './injuryAttribution.ts';

export interface SupabaseRpcConfig {
  supabaseUrl: string;
  key: string;
}

/**
 * Resolves Supabase credentials from environment (publishable anon key only).
 */
export function resolveSupabaseRpcConfig(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): SupabaseRpcConfig | null {
  const url = env.SUPABASE_URL?.trim();
  const publishableKey = (
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    env.SUPABASE_READ_ONLY_KEY ||
    env.PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();
  const serviceRoleKey = (
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_KEY ||
    ''
  ).trim();

  if (!url || !url.startsWith('http') || !publishableKey) {
    return null;
  }
  if (
    (serviceRoleKey && publishableKey === serviceRoleKey) ||
    publishableKey.includes('service_role')
  ) {
    return null;
  }
  return { supabaseUrl: url, key: publishableKey };
}

export function isCanonicalOrHexId(id: string): boolean {
  return /^[a-z]+(?:-[a-z]+)*-\d+$/i.test(id) || /^[a-f0-9]{32}$/i.test(id);
}

export function isOptionCitationId(id: string): boolean {
  return /^R\d+$/i.test(id);
}

export function isRpcEmptyResult(d: unknown): boolean {
  if (d === null || d === undefined) return true;
  if (Array.isArray(d)) return d.length === 0;
  if (typeof d === 'object') {
    const obj = d as Record<string, unknown>;
    if (obj.source === 'empty' || obj.status === 'no_rows' || obj.empty === true) return true;
    return Object.keys(obj).length === 0;
  }
  return false;
}

export type SupabaseRpcCallResult<T = any> =
  | { ok: true; data: T; error?: undefined; message?: undefined }
  | { ok: false; error: string; message: string; data?: undefined };

/**
 * Executes a Supabase RPC function via PostgREST POST /rest/v1/rpc/<rpcName>.
 */
export async function callSupabaseRpc<T = any>(
  rpcName: string,
  params: Record<string, unknown>,
  options: {
    fetchFn?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<SupabaseRpcCallResult<T>> {
  const env = options.env || (typeof process !== 'undefined' ? process.env : {});
  const fetchFn = options.fetchFn || globalThis.fetch;
  const cfg = resolveSupabaseRpcConfig(env);

  if (!cfg) {
    return {
      ok: false,
      error: 'supabase_not_configured',
      message: 'Supabase credentials (SUPABASE_URL and key) are not configured in environment.'
    };
  }

  const startMs = Date.now();
  try {
    const res = await fetchFn(`${cfg.supabaseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(params)
    });

    const ms = Date.now() - startMs;
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.log(`[RPC] fn=${rpcName} status=${res.status} empty=true ms=${ms}`);
      return {
        ok: false,
        error: `rpc_failed_${res.status}`,
        message: `Supabase RPC ${rpcName} failed [${res.status}]: ${errText}`
      };
    }

    const data = (await res.json().catch(() => null)) as T;
    const empty = isRpcEmptyResult(data);
    console.log(`[RPC] fn=${rpcName} status=${res.status} empty=${empty} ms=${ms}`);
    return { ok: true, data };
  } catch (err: any) {
    const ms = Date.now() - startMs;
    console.log(`[RPC] fn=${rpcName} status=network empty=true ms=${ms}`);
    return {
      ok: false,
      error: 'rpc_network_error',
      message: `Supabase RPC ${rpcName} network error: ${err?.message || err}`
    };
  }
}

type ShortSportKey = 'nba' | 'nfl' | 'nhl' | 'mlb' | 'wnba' | 'ncaaf' | 'ncaab';

const SPORT_SCOPED_TEAM_ABBR_ALIASES: Readonly<Record<ShortSportKey, Readonly<Record<string, string>>>> = {
  nba: {
    NO: 'NOP',
    NOP: 'NOP',
    NY: 'NYK',
    NYK: 'NYK',
    GS: 'GSW',
    GSW: 'GSW',
    SA: 'SAS',
    SAS: 'SAS',
    UTAH: 'UTA',
    UTH: 'UTA',
    UTA: 'UTA',
    WSH: 'WAS',
    WAS: 'WAS',
    PHO: 'PHX',
    PHX: 'PHX',
    BK: 'BKN',
    BRK: 'BKN',
    BKN: 'BKN',
    CHO: 'CHA',
    CHA: 'CHA',
  },
  nfl: {
    NO: 'NO',
    NOR: 'NO',
    NOP: 'NO',
    TB: 'TB',
    TAM: 'TB',
    TBL: 'TB',
    SF: 'SF',
    SFO: 'SF',
    KC: 'KC',
    KAN: 'KC',
    GB: 'GB',
    GNB: 'GB',
    NE: 'NE',
    NWE: 'NE',
    LV: 'LV',
    LVR: 'LV',
    JAC: 'JAX',
    JAX: 'JAX',
    WSH: 'WAS',
    WAS: 'WAS',
    LA: 'LAR',
    LAK: 'LA',
  },
  nhl: {
    TB: 'TBL',
    TBL: 'TBL',
    SJ: 'SJS',
    SJS: 'SJS',
    LA: 'LAK',
    LAK: 'LAK',
    NJ: 'NJD',
    NJD: 'NJD',
    MON: 'MTL',
    MTL: 'MTL',
    UTAH: 'UTA',
    UTH: 'UTA',
    UTA: 'UTA',
    WSH: 'WSH',
    WAS: 'WSH',
  },
  mlb: {
    CWS: 'CHW',
    CHW: 'CHW',
    AZ: 'ARI',
    ARI: 'ARI',
    KC: 'KCR',
    KCR: 'KCR',
    SD: 'SDP',
    SDP: 'SDP',
    SF: 'SFG',
    SFG: 'SFG',
    TB: 'TBR',
    TBR: 'TBR',
  },
  wnba: {},
  ncaaf: {},
  ncaab: {},
};

const FALLBACK_TEAM_ABBR_ALIASES: Readonly<Record<string, string>> = {
  GS: 'GSW',
  SA: 'SAS',
  UTAH: 'UTA',
  UTH: 'UTA',
  GNB: 'GB',
  KAN: 'KC',
  NWE: 'NE',
  SFO: 'SF',
  JAC: 'JAX',
  LVR: 'LV',
  BK: 'BKN',
  BRK: 'BKN',
  CHO: 'CHA',
  PHO: 'PHX',
};

function inferShortSportFromHint(sportOrGameId?: string): ShortSportKey | null {
  const raw = String(sportOrGameId || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'nba' || raw === 'basketball_nba' || raw.startsWith('nba-')) return 'nba';
  if (raw === 'nfl' || raw === 'americanfootball_nfl' || raw.startsWith('nfl-')) return 'nfl';
  if (raw === 'nhl' || raw === 'icehockey_nhl' || raw.startsWith('nhl-')) return 'nhl';
  if (raw === 'mlb' || raw === 'baseball_mlb' || raw.startsWith('mlb-')) return 'mlb';
  if (raw === 'wnba' || raw === 'basketball_wnba' || raw.startsWith('wnba-')) return 'wnba';
  if (raw.includes('ncaaf') || raw.includes('college-football')) return 'ncaaf';
  if (raw.includes('ncaab') || raw.includes('college-basketball')) return 'ncaab';
  return null;
}

/**
 * Normalizes team abbreviations strictly within their sport context so cross-sport
 * collisions (e.g. NFL New Orleans 'NO' vs NBA 'NOP', NFL 'TB' vs NHL 'TBL') never leak.
 */
export function normalizeSportTeamAbbr(rawAbbr: string, sportOrGameId?: string): string {
  const trimmed = String(rawAbbr || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;
  if (trimmed === 'Home' || trimmed === 'Away' || trimmed === 'Unknown' || trimmed === 'N/A') {
    return trimmed;
  }
  const upper = trimmed.toUpperCase();
  const sport = inferShortSportFromHint(sportOrGameId);
  const map = sport ? SPORT_SCOPED_TEAM_ABBR_ALIASES[sport] : FALLBACK_TEAM_ABBR_ALIASES;
  if (map && map[upper]) return map[upper];
  return upper;
}

/**
 * Tool 1: get_matchup_fundamentals
 * Parameters: game_id: string, window?: 'L5' | 'L10' | 'season'
 */
export const getMatchupFundamentalsTool: SwarmTool = {
  name: 'get_matchup_fundamentals',
  description: 'Pulls pace, net margins, ATS splits for a game.',
  parameters: {
    game_id: {
      type: 'string',
      description: 'Game ID',
      required: true
    },
    window: {
      type: 'string',
      description: "Window: 'L5', 'L10', or 'season'",
      enum: ['L5', 'L10', 'season']
    }
  },
  execute: async (args: Record<string, any>, context?: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> }) => {
    if (!args || typeof args.game_id !== 'string' || !args.game_id.trim()) {
      return {
        success: false,
        error: 'invalid_game_id',
        message: 'Missing or empty game_id parameter.',
        summary: 'Error: Missing or empty game_id parameter.'
      };
    }
    const gameId = args.game_id.trim();

    if (isOptionCitationId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' is an option citation ID, not a canonical event ID.`,
        summary: `Error: Game ID '${gameId}' is an option citation ID, not a canonical event ID.`
      };
    }

    let windowVal: string | undefined = undefined;
    if (args.window !== undefined) {
      const norm = String(args.window).trim();
      const match = ['l5', 'l10', 'season'].find(w => w === norm.toLowerCase());
      if (!match) {
        return {
          success: false,
          error: 'invalid_window',
          message: "Parameter 'window' must be one of 'L5', 'L10', or 'season'.",
          summary: "Error: Invalid window parameter (must be 'L5', 'L10', or 'season')."
        };
      }
      windowVal = match === 'l5' ? 'L5' : match === 'l10' ? 'L10' : 'season';
    }

    const rpcRes = await callSupabaseRpc(
      'get_matchup_fundamentals_v1',
      { p_game_id: gameId, ...(windowVal !== undefined ? { p_window: windowVal } : {}) },
      { fetchFn: context?.fetchFn, env: context?.env }
    );

    if (!rpcRes.ok) {
      return {
        success: false,
        error: rpcRes.error,
        message: rpcRes.message,
        summary: `Error fetching matchup fundamentals for ${gameId}: ${rpcRes.message}`
      };
    }

    const d = rpcRes.data || {};
    const displayWindow = windowVal || 'season';

    if (isRpcEmptyResult(d)) {
      if (!isCanonicalOrHexId(gameId)) {
        return {
          success: false,
          error: 'unresolved_game_id',
          message: `Game ID '${gameId}' could not be resolved to a canonical event.`,
          summary: `Error: Game ID '${gameId}' could not be resolved to canonical event.`
        };
      }
      return {
        success: true,
        empty: true,
        game_id: gameId,
        window: displayWindow,
        data: d,
        summary: `[MATCHUP FUNDAMENTALS: ${gameId} (${displayWindow})] no canonical game for ${gameId}`
      };
    }

    const homeObj = typeof d.home === 'object' && d.home !== null ? d.home : (typeof d.home_team_stats === 'object' && d.home_team_stats !== null ? d.home_team_stats : {});
    const awayObj = typeof d.away === 'object' && d.away !== null ? d.away : (typeof d.away_team_stats === 'object' && d.away_team_stats !== null ? d.away_team_stats : {});

    const sportHint = String(d.sport || gameId || '');

    const formatH2h = (h2h: any, sportOrGame: string = sportHint): string => {
      if (!Array.isArray(h2h) || h2h.length === 0) return '';
      const deduped = new Map<string, { formatted: string; isWin: boolean }>();
      for (const g of h2h) {
        if (!g || typeof g !== 'object') continue;
        const dateVal = String(g.game_date || '').trim();
        const datePrefix = dateVal ? `${dateVal}: ` : '';
        const t1 = g.team_abbr ? normalizeSportTeamAbbr(String(g.team_abbr), sportOrGame) : '';
        const t2 = g.opponent_abbr ? normalizeSportTeamAbbr(String(g.opponent_abbr), sportOrGame) : '';
        const hasScores = g.team_score !== undefined && g.opponent_score !== undefined;
        const score = hasScores ? ` ${g.team_score}-${g.opponent_score}` : '';
        const res = g.result ? ` (${g.result})` : '';
        const match = t1 && t2 ? `${t1} vs ${t2}` : '';
        const formatted = `${datePrefix}${match}${score}${res}`.trim();
        if (!formatted) continue;

        if (dateVal && hasScores) {
          const scorePair = [Number(g.team_score), Number(g.opponent_score)]
            .sort((a, b) => a - b)
            .join('-');
          const key = `${dateVal}|${scorePair}`;
          const isWin = String(g.result || '').trim().toUpperCase() === 'W';
          const prev = deduped.get(key);
          if (!prev || (isWin && !prev.isWin)) {
            deduped.set(key, { formatted, isWin });
          }
        } else if (t1 && t2) {
          const teamPair = [t1.toUpperCase(), t2.toUpperCase()].sort().join('_');
          const scorePair = hasScores
            ? [Number(g.team_score), Number(g.opponent_score)]
                .sort((a, b) => a - b)
                .join('-')
            : '';
          const key = `${dateVal}|${teamPair}|${scorePair}`;
          const isWin = String(g.result || '').trim().toUpperCase() === 'W';
          const prev = deduped.get(key);
          if (!prev || (isWin && !prev.isWin)) {
            deduped.set(key, { formatted, isWin });
          }
        } else {
          deduped.set(`raw|${deduped.size}|${formatted}`, { formatted, isWin: false });
        }
      }
      return Array.from(deduped.values())
        .slice(0, 5)
        .map((entry) => entry.formatted)
        .join('; ');
    };

function matchesSnapshotTeamKey(teamKey: string, label?: string, localSportHint?: string): boolean {
  const effectiveSport = localSportHint || sportHint;
  const a = String(teamKey || '').trim();
  const b = String(label || '').trim();
  if (!a || !b) return false;
  const ua = a.replace(/_/g, ' ').trim().toUpperCase();
  const ub = b.replace(/_/g, ' ').trim().toUpperCase();
  if (ua === ub) return true;

  const ca = normalizeSportTeamAbbr(ua, effectiveSport);
  const cb = normalizeSportTeamAbbr(ub, effectiveSport);
  if (ca === cb) return true;

  const entryA = matchTeamByLabel(a.replace(/_/g, ' '), effectiveSport);
  const entryB = matchTeamByLabel(b.replace(/_/g, ' '), effectiveSport);
  if (entryA && entryB) {
    if (entryA.sport === entryB.sport && entryA.id === entryB.id) return true;
    return false;
  }
  if (entryA) {
    const abbrA = normalizeSportTeamAbbr(entryA.abbr, entryA.sport || effectiveSport);
    if (abbrA === cb) return true;
  }
  if (entryB) {
    const abbrB = normalizeSportTeamAbbr(entryB.abbr, entryB.sport || effectiveSport);
    if (abbrB === ca) return true;
  }

  const checkShortAgainstLong = (shortCode: string, longName: string): boolean => {
    const cleanShort = shortCode.replace(/[^A-Z]/g, '');
    if (cleanShort.length < 2 || cleanShort.length > 6) return false;
    const words = longName
      .replace(/[^A-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return false;
    if (cleanShort.length >= 3 && words[0].startsWith(cleanShort)) return true;
    const initials = words.map(w => w[0]).join('');
    if (words.length >= 2 && cleanShort.slice(0, 2) === initials.slice(0, 2)) {
      if (initials.startsWith(cleanShort)) return true;
      if (cleanShort.endsWith('U') && initials.startsWith(cleanShort.slice(0, -1))) return true;
    }
    return false;
  };

  return checkShortAgainstLong(ua, ub) || checkShortAgainstLong(ub, ua);
}

    if (d.source === 'snapshot') {
      const idToLabel = new Map<string, string>();
      const homeId = d.home_team_id ?? homeObj.team_id ?? homeObj.id;
      const awayId = d.away_team_id ?? awayObj.team_id ?? awayObj.id;
      const homeLbl =
        d.home_team_abbr ??
        d.home_team ??
        homeObj.abbr ??
        homeObj.team ??
        (context as any)?.game?.home_team_abbr ??
        (context as any)?.game?.home_team;
      const awayLbl =
        d.away_team_abbr ??
        d.away_team ??
        awayObj.abbr ??
        awayObj.team ??
        (context as any)?.game?.away_team_abbr ??
        (context as any)?.game?.away_team;
      if (homeId !== undefined && homeId !== null && homeLbl) idToLabel.set(String(homeId), String(homeLbl));
      if (awayId !== undefined && awayId !== null && awayLbl) idToLabel.set(String(awayId), String(awayLbl));
      const mapFormValue = (val: any): any => {
        if (Array.isArray(val)) return val.map(mapFormValue);
        if (val && typeof val === 'object') {
          const out: Record<string, any> = {};
          for (const [k, v] of Object.entries(val)) {
            if (k === 'team_id' && (typeof v === 'string' || typeof v === 'number') && idToLabel.has(String(v))) {
              out.team = idToLabel.get(String(v));
            } else {
              const mappedKey = idToLabel.get(k) ?? k;
              out[mappedKey] = mapFormValue(v);
            }
          }
          return out;
        }
        return val;
      };
      const formatSideEnrichment = (obj: any, splitKey: 'home_record' | 'away_record', splitSuffix: 'Home' | 'Away'): string => {
        if (!obj || typeof obj !== 'object') return '';
        const sw = obj.season_wins ?? obj.wins;
        const sl = obj.season_losses ?? obj.losses;
        const splitRec = obj[splitKey];
        const diffRaw = obj.season_net_margin ?? obj.net_margin;
        const parts: string[] = [];
        if (sw !== undefined && sl !== undefined) parts.push(`${sw}-${sl}`);
        const sub: string[] = [];
        if (splitRec) sub.push(`${splitRec} ${splitSuffix}`);
        if (diffRaw !== undefined && diffRaw !== null && Number.isFinite(Number(diffRaw))) {
          const dn = Number(diffRaw);
          sub.push(`Diff ${dn > 0 ? `+${dn}` : dn}`);
        }
        return parts.length > 0 ? `${parts[0]}${sub.length > 0 ? ` (${sub.join(', ')})` : ''}` : '';
      };
      let formText: string;
      if (Array.isArray(d.form?.items) && d.form.items.length > 0) {
        const snapSportHint = String(d.sport || gameId || '');
        const mappedItems = mapFormValue(d.form.items) as any[];
        const byTeam = new Map<string, any[]>();
        for (const item of mappedItems) {
          const team = String(item?.team ?? item?.team_id ?? 'Unknown');
          const matchedExistingKey = Array.from(byTeam.keys()).find(k => matchesSnapshotTeamKey(k, team, snapSportHint));
          const bucketKey = matchedExistingKey ?? team;
          const list = byTeam.get(bucketKey);
          if (list) list.push(item);
          else byTeam.set(bucketKey, [item]);
        }
        const populatedTeamCount = Array.from(byTeam.values()).filter(list => list.length > 0).length;
        if (populatedTeamCount < 2 && homeLbl) {
          const homeMatched = Array.from(byTeam.keys()).find(k => matchesSnapshotTeamKey(k, String(homeLbl), snapSportHint));
          if (!homeMatched) byTeam.set(String(homeLbl), []);
        }
        if (populatedTeamCount < 2 && awayLbl) {
          const awayMatched = Array.from(byTeam.keys()).find(k => matchesSnapshotTeamKey(k, String(awayLbl), snapSportHint));
          if (!awayMatched) byTeam.set(String(awayLbl), []);
        }
        const parts: string[] = [];
        for (const [team, items] of byTeam.entries()) {
          if (items.length === 0 && populatedTeamCount >= 2) continue;
          const sorted = [...items].sort((a, b) =>
            String(b?.game_date ?? '').localeCompare(String(a?.game_date ?? ''))
          );
          const results = sorted
            .map((it) => (typeof it?.result === 'string' ? it.result.trim().toUpperCase() : ''))
            .filter(Boolean);
          const wins = results.filter((r) => r === 'W').length;
          const losses = results.filter((r) => r === 'L').length;
          const isHomeSide = Boolean(homeLbl && matchesSnapshotTeamKey(team, String(homeLbl), snapSportHint));
          const isAwaySide = !isHomeSide && Boolean(awayLbl && matchesSnapshotTeamKey(team, String(awayLbl), snapSportHint));
          const meta = isHomeSide
            ? formatSideEnrichment(homeObj, 'home_record', 'Home')
            : isAwaySide
              ? formatSideEnrichment(awayObj, 'away_record', 'Away')
              : '';
          const formPart = results.length > 0 ? `L${results.length}: ${wins}-${losses} ${results.join('')}` : '0-0 last0';
          parts.push(meta ? `${team} ${meta} | ${formPart}` : `${team} ${wins}-${losses} last${results.length} ${results.join('')}`.trim());
        }
        formText = parts.join('; ');
      } else {
        formText = d.form
          ? (typeof d.form === 'object' ? JSON.stringify(mapFormValue(d.form)) : String(d.form))
          : `Home: ${d.home_form ?? homeObj.form ?? 'N/A'} | Away: ${d.away_form ?? awayObj.form ?? 'N/A'}`;
      }
      const h2hText = formatH2h(d.h2h, sportHint);
      const summary = [
        `[MATCHUP FUNDAMENTALS: ${gameId} (${displayWindow}) | source: snapshot]`,
        `Form: ${formText}`,
        h2hText ? `H2H: ${h2hText}` : 'H2H: None'
      ].join('\n');
      return {
        success: true,
        game_id: gameId,
        window: displayWindow,
        data: d,
        summary
      };
    }

    const homeTeamRaw = String(homeObj.team || d.home_team || (context as any)?.game?.home_team || 'Home');
    const awayTeamRaw = String(awayObj.team || d.away_team || (context as any)?.game?.away_team || 'Away');
    const homeTeam = normalizeSportTeamAbbr(homeTeamRaw, sportHint);
    const awayTeam = normalizeSportTeamAbbr(awayTeamRaw, sportHint);
    const homeHasL5 = Array.isArray(homeObj.last5_results) && homeObj.last5_results.length > 0;
    const awayHasL5 = Array.isArray(awayObj.last5_results) && awayObj.last5_results.length > 0;
    const homeWl = (homeObj.wins !== undefined && homeObj.losses !== undefined) ? `${homeObj.wins}-${homeObj.losses}` : 'N/A';
    const awayWl = (awayObj.wins !== undefined && awayObj.losses !== undefined) ? `${awayObj.wins}-${awayObj.losses}` : 'N/A';
    const homePfPa = (homeObj.points_for_avg !== undefined || homeObj.points_against_avg !== undefined)
      ? `${homeObj.points_for_avg ?? 'N/A'} / ${homeObj.points_against_avg ?? 'N/A'}`
      : 'N/A';
    const awayPfPa = (awayObj.points_for_avg !== undefined || awayObj.points_against_avg !== undefined)
      ? `${awayObj.points_for_avg ?? 'N/A'} / ${awayObj.points_against_avg ?? 'N/A'}`
      : 'N/A';
    const homeNet = homeObj.net_margin !== undefined && homeObj.net_margin !== null ? String(homeObj.net_margin) : 'N/A';
    const awayNet = awayObj.net_margin !== undefined && awayObj.net_margin !== null ? String(awayObj.net_margin) : 'N/A';
    const homeRecent = Array.isArray(homeObj.recent_results)
      ? homeObj.recent_results.join(',')
      : (homeObj.recent_results ?? 'N/A');
    const awayRecent = Array.isArray(awayObj.recent_results)
      ? awayObj.recent_results.join(',')
      : (awayObj.recent_results ?? 'N/A');

    const formatExtraTeamContext = (obj: any, splitKey: 'home_record' | 'away_record', splitSuffix: 'Home' | 'Away'): string => {
      const parts: string[] = [];
      const hasSeason = obj.season_wins !== undefined && obj.season_losses !== undefined;
      if (hasSeason) {
        const sub: string[] = [];
        if (obj[splitKey]) sub.push(`${obj[splitKey]} ${splitSuffix}`);
        if (obj.season_net_margin !== undefined && obj.season_net_margin !== null && Number.isFinite(Number(obj.season_net_margin))) {
          const dn = Number(obj.season_net_margin);
          sub.push(`Diff ${dn > 0 ? `+${dn}` : dn}`);
        }
        parts.push(`Season ${obj.season_wins}-${obj.season_losses}${sub.length > 0 ? ` (${sub.join(', ')})` : ''}`);
      } else if (obj[splitKey]) {
        parts.push(`${obj[splitKey]} ${splitSuffix}`);
      }
      if (Array.isArray(obj.last5_results) && obj.last5_results.length > 0) {
        const l5Res = obj.last5_results.map((r: unknown) => String(r || '').trim().toUpperCase()).filter(Boolean);
        const l5W = obj.last5_wins ?? l5Res.filter((r: string) => r === 'W').length;
        const l5L = obj.last5_losses ?? l5Res.filter((r: string) => r === 'L').length;
        parts.push(`L5: ${l5W}-${l5L} ${l5Res.join('')}`);
      }
      return parts.length > 0 ? ` | ${parts.join(' | ')}` : '';
    };

    const homeExtra = formatExtraTeamContext(homeObj, 'home_record', 'Home');
    const awayExtra = formatExtraTeamContext(awayObj, 'away_record', 'Away');

    const h2hText = formatH2h(d.h2h, sportHint);
    const summaryLines = [
      `[MATCHUP FUNDAMENTALS: ${gameId} (${displayWindow})]`,
      `Home (${homeTeam}): W-L ${homeWl} | PF/PA ${homePfPa} | Net Margin ${homeNet}${homeHasL5 ? '' : ` | Recent ${homeRecent}`}${homeExtra}`,
      `Away (${awayTeam}): W-L ${awayWl} | PF/PA ${awayPfPa} | Net Margin ${awayNet}${awayHasL5 ? '' : ` | Recent ${awayRecent}`}${awayExtra}`
    ];
    if (h2hText) {
      summaryLines.push(`H2H: ${h2hText}`);
    }
    const summary = summaryLines.join('\n');

    return {
      success: true,
      game_id: gameId,
      window: displayWindow,
      data: d,
      summary
    };
  }
};

export type HealthBalanceClassification =
  | 'home_advantage'
  | 'away_advantage'
  | 'conditional_home_advantage'
  | 'conditional_away_advantage'
  | 'uncertain_questionable'
  | 'symmetric';

export interface InjuryHealthSummaryResult {
  balance: HealthBalanceClassification;
  label: string;
  homeTeam: string;
  awayTeam: string;
  homeOut: number;
  homeQ: number;
  awayOut: number;
  awayQ: number;
  homeOutImpact?: number;
  awayOutImpact?: number;
  homeQImpact?: number;
  awayQImpact?: number;
  tier1QuestionablePlayers?: string[];
  line: string;
}

export interface PlayerGameLogRow {
  player_id?: string | number | null;
  player_name?: string | null;
  name?: string | null;
  team_abbr?: string | null;
  team?: string | null;
  team_name?: string | null;
  team_id?: string | number | null;
  position?: string | null;
  pos?: string | null;
  sport?: string | null;
  league?: string | null;
  minutes?: number | string | null;
  min?: number | string | null;
  mpg?: number | string | null;
  avg_minutes?: number | string | null;
  points?: number | string | null;
  pts?: number | string | null;
  ppg?: number | string | null;
  avg_points?: number | string | null;
  toi?: number | string | null;
  time_on_ice?: number | string | null;
  toi_minutes?: number | string | null;
  avg_toi?: number | string | null;
  goals?: number | string | null;
  assists?: number | string | null;
  pass_attempts?: number | string | null;
  passing_attempts?: number | string | null;
  pass_att?: number | string | null;
  attempts?: number | string | null;
  rush_attempts?: number | string | null;
  rushing_attempts?: number | string | null;
  targets?: number | string | null;
  receptions?: number | string | null;
  games_started?: number | string | null;
  goalie_starts?: number | string | null;
  starts?: number | string | null;
  started?: boolean | number | null;
  snap_pct?: number | string | null;
  snaps?: number | string | null;
  is_starter?: boolean | null;
  starter?: boolean | null;
  source?: string | null;
  depth_rank?: number | string | null;
  depth_chart_order?: number | string | null;
  impact_tier?: number | null;
  impact_weight?: number | null;
  stats?: Record<string, any> | string | null;
}

type NormalizedInjurySport = 'nba' | 'nhl' | 'nfl' | 'ncaaf' | 'other';

function normalizeInjurySport(sportHint?: string, gameId?: string): NormalizedInjurySport {
  const scope = `${sportHint || ''} ${gameId || ''}`.toLowerCase();
  if (/\b(?:nba|basketball_nba)\b|^nba-/.test(scope)) return 'nba';
  if (/\b(?:nhl|icehockey_nhl)\b|^nhl-/.test(scope)) return 'nhl';
  if (/\b(?:ncaaf|college-football|americanfootball_ncaaf)\b|^(?:ncaaf|college-football)-/.test(scope)) return 'ncaaf';
  if (/\b(?:nfl|americanfootball_nfl)\b|^nfl-/.test(scope)) return 'nfl';
  return 'other';
}

function parseNumericStat(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Handle MM:SS time-on-ice / minutes strings (e.g. "19:30" -> 19.5)
    const mmss = trimmed.match(/^(\d+):(\d{2})$/);
    if (mmss) {
      return Number(mmss[1]) + Number(mmss[2]) / 60;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizePlayerNameKey(raw: unknown): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface AggregatedPlayerLogStats {
  playerKey: string;
  playerId?: string;
  playerName: string;
  teamKeys: Set<string>;
  position: string;
  games: number;
  mpg: number | null;
  ppg: number | null;
  pra: number | null;
  toi: number | null;
  avgTargets: number | null;
  avgRushAttempts: number | null;
  totalPoints: number;
  totalPassAttempts: number;
  totalTouches: number;
  starts: number;
  snapPct: number | null;
  isStarter: boolean;
  depthChartOrder: number | null;
  hasSeasonStats?: boolean;
  hasDepthChart?: boolean;
  zeroUsageOnly?: boolean;
}

interface TeamLogIndex {
  hasLogs: boolean;
  distinctGameDates: Set<string>;
  hasDepthChart: boolean;
  hasSeasonStats: boolean;
  hasDatedLogs: boolean;
  loggedPlayerCount: number;
  hasSufficientCoverage: boolean;
  canProveUnloggedDepth: boolean;
  playersByName: Map<string, AggregatedPlayerLogStats>;
  playersById: Map<string, AggregatedPlayerLogStats>;
  topPasserKey?: string;
  topGoalieKey?: string;
  top4ScorerKeys: Set<string>;
  top3RotationKeys: Set<string>;
}

function isSeasonStatsSource(sourceRaw: unknown): boolean {
  const src = String(sourceRaw || '').trim().toLowerCase();
  return src === 'nhl_club_stats' || src === 'espn_season_stats' || src === 'season_stats';
}

function isDepthChartSource(sourceRaw: unknown): boolean {
  const src = String(sourceRaw || '').trim().toLowerCase();
  return src === 'espn_depthchart' || src === 'depth_chart' || src === 'depthchart';
}

function normalizeLogGameDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoMatch ? isoMatch[1] : trimmed;
}

const MODULE_PLAYER_LOGS_CACHE = new Map<string, { expiresAt: number; promise: Promise<PlayerGameLogRow[]> }>();
const PLAYER_LOGS_CACHE_TTL_MS = 60_000;

async function fetchBatchedPlayerGameLogs(
  envInput?: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
  runCache?: Map<string, Promise<PlayerGameLogRow[]>>
): Promise<PlayerGameLogRow[]> {
  const procEnv = typeof process !== 'undefined' ? process.env : {};
  const env = envInput || procEnv;
  const supabaseUrl = (env.SUPABASE_URL || (!fetchFn ? procEnv.SUPABASE_URL : '') || '').trim().replace(/\/+$/, '');
  const explicitServiceKey = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  const runtimeFallbackKey = !fetchFn
    ? (
        procEnv.SUPABASE_SERVICE_ROLE_KEY ||
        procEnv.SUPABASE_SERVICE_KEY ||
        env.SUPABASE_ANON_KEY ||
        env.SUPABASE_PUBLISHABLE_KEY ||
        procEnv.SUPABASE_ANON_KEY ||
        ''
      ).trim()
    : '';
  const apiKey = explicitServiceKey || runtimeFallbackKey;
  if (!supabaseUrl || !apiKey) return [];

  const cacheKey = `${supabaseUrl}::player_game_logs`;
  if (runCache?.has(cacheKey)) {
    return runCache.get(cacheKey)!;
  }

  const useModuleCache = !fetchFn;
  if (useModuleCache) {
    const cached = MODULE_PLAYER_LOGS_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }
  }

  const execFetch = fetchFn || globalThis.fetch;
  if (typeof execFetch !== 'function') return [];

  const loader = (async (): Promise<PlayerGameLogRow[]> => {
    const headers = {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    };
    const urls = [
      `${supabaseUrl}/rest/v1/player_game_logs?order=game_date.desc&limit=2500`,
      `${supabaseUrl}/rest/v1/player_game_logs?order=created_at.desc&limit=2500`,
      `${supabaseUrl}/rest/v1/player_game_logs?limit=2500`
    ];
    for (const url of urls) {
      try {
        const res = await execFetch(url, { method: 'GET', headers });
        if (!res.ok) continue;
        const json = await res.json();
        if (Array.isArray(json)) return json as PlayerGameLogRow[];
        return [];
      } catch {
        // Fall back gracefully when logs table is unavailable or unreachable
      }
    }
    return [];
  })();

  if (runCache) {
    runCache.set(cacheKey, loader);
  }
  if (useModuleCache) {
    MODULE_PLAYER_LOGS_CACHE.set(cacheKey, { expiresAt: Date.now() + PLAYER_LOGS_CACHE_TTL_MS, promise: loader });
  }
  return loader;
}

function extractPlayerIdKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const s = String(raw).trim().toLowerCase();
  if (!s) return [];
  const keys = new Set<string>([s]);
  // Normalize raw ESPN numeric player_id (e.g. "espn-4065648" -> "4065648")
  const numMatch = s.match(/(?:^|[^0-9])(\d{4,12})$/);
  if (numMatch?.[1]) keys.add(numMatch[1]);
  return Array.from(keys);
}

function parseStatsObject(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, any>;
    } catch {
      // ignore malformed JSON
    }
  }
  return {};
}

function buildTeamLogIndex(
  logs: PlayerGameLogRow[],
  targetTeamLabels: string[],
  sportHint: string,
  targetPlayerIds?: string[]
): TeamLogIndex {
  const targetSport = normalizeInjurySport(sportHint);
  const targetTokens = new Set<string>();
  for (const lbl of targetTeamLabels) {
    const clean = String(lbl || '').trim().toLowerCase();
    if (!clean) continue;
    targetTokens.add(clean);
    const matched = matchTeamByLabel(lbl, sportHint);
    if (matched) {
      targetTokens.add(matched.abbr.toLowerCase());
      targetTokens.add(matched.name.toLowerCase());
    }
  }

  const targetPidSet = new Set<string>();
  for (const pid of targetPlayerIds || []) {
    for (const k of extractPlayerIdKeys(pid)) targetPidSet.add(k);
  }

  const acc = new Map<
    string,
    {
      playerId?: string;
      playerName: string;
      teamKeys: Set<string>;
      position: string;
      games: number;
      minSum: number;
      minCnt: number;
      ptsSum: number;
      ptsCnt: number;
      praSum: number;
      praCnt: number;
      toiSum: number;
      toiCnt: number;
      targetsSum: number;
      targetsCnt: number;
      rushAttSum: number;
      rushAttCnt: number;
      totalPoints: number;
      totalPassAttempts: number;
      totalTouches: number;
      starts: number;
      snapMax: number | null;
      isStarter: boolean;
      depthChartOrder: number | null;
      hasSeasonStats: boolean;
      hasDepthChart: boolean;
      zeroUsageRows: number;
    }
  >();

  let matchedAnyRow = false;
  let matchedRowCount = 0;
  const distinctGameDates = new Set<string>();
  let teamHasDepthChart = false;
  let teamHasSeasonStats = false;

  for (const row of logs) {
    if (!row || typeof row !== 'object') continue;
    const rowSportRaw = row.sport || row.league;
    if (rowSportRaw && targetSport !== 'other') {
      const rowSport = normalizeInjurySport(String(rowSportRaw));
      if (rowSport !== 'other' && rowSport !== targetSport) continue;
    }

    const pidRaw = row.player_id !== undefined && row.player_id !== null ? String(row.player_id).trim() : '';
    const pidKeys = extractPlayerIdKeys(pidRaw);
    const pidMatchesTarget = targetPidSet.size > 0 && pidKeys.some((k) => targetPidSet.has(k));

    const rawTeamVals = [row.team_abbr, row.team, row.team_name, row.team_id !== undefined && row.team_id !== null ? String(row.team_id) : '']
      .map((v) => String(v || '').trim())
      .filter(Boolean);
    if (!pidMatchesTarget && targetTokens.size > 0 && rawTeamVals.length > 0) {
      const teamMatches = rawTeamVals.some((tv) => {
        const lower = tv.toLowerCase();
        if (targetTokens.has(lower)) return true;
        const m = matchTeamByLabel(tv, sportHint);
        return Boolean(m && (targetTokens.has(m.abbr.toLowerCase()) || targetTokens.has(m.name.toLowerCase())));
      });
      if (!teamMatches) continue;
    }

    const stObj = parseStatsObject(row.stats);
    const nameRaw = String(row.player_name || row.name || stObj.player_name || '').trim();
    const key = normalizePlayerNameKey(nameRaw) || pidRaw.toLowerCase();
    if (!key) continue;

    matchedAnyRow = true;
    matchedRowCount += 1;

    const rowSource = (row as any).source ?? stObj.source;
    const rowIsSeasonStats = isSeasonStatsSource(rowSource);
    const rowIsDepthChart = isDepthChartSource(rowSource);
    if (rowIsSeasonStats) teamHasSeasonStats = true;
    if (rowIsDepthChart) teamHasDepthChart = true;

    const rawDate = (row as any).game_date ?? (row as any).date ?? stObj.game_date;
    const normDate = normalizeLogGameDate(rawDate);
    if (normDate && !rowIsSeasonStats && !rowIsDepthChart) {
      distinctGameDates.add(normDate);
    }

    const rowPos = String(row.position || row.pos || stObj.position || stObj.pos || '').trim().toUpperCase();
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        ...(pidRaw ? { playerId: pidRaw } : {}),
        playerName: nameRaw || pidRaw,
        teamKeys: new Set<string>(),
        position: rowPos,
        games: 0,
        minSum: 0,
        minCnt: 0,
        ptsSum: 0,
        ptsCnt: 0,
        praSum: 0,
        praCnt: 0,
        toiSum: 0,
        toiCnt: 0,
        targetsSum: 0,
        targetsCnt: 0,
        rushAttSum: 0,
        rushAttCnt: 0,
        totalPoints: 0,
        totalPassAttempts: 0,
        totalTouches: 0,
        starts: 0,
        snapMax: null,
        isStarter: false,
        depthChartOrder: null,
        hasSeasonStats: false,
        hasDepthChart: false,
        zeroUsageRows: 0
      };
      acc.set(key, entry);
    }
    if (rowIsSeasonStats) entry.hasSeasonStats = true;
    if (rowIsDepthChart) entry.hasDepthChart = true;
    for (const tv of rawTeamVals) entry.teamKeys.add(tv.toLowerCase());
    if (!entry.position && rowPos) {
      entry.position = rowPos;
    }
    const gamesPlayedVal = parseNumericStat((row as any).games_played ?? (row as any).gp ?? stObj.games_played ?? stObj.gp);
    entry.games += rowIsSeasonStats && gamesPlayedVal !== null && gamesPlayedVal > 1 ? gamesPlayedVal : 1;

    const minVal = parseNumericStat(row.mpg ?? row.avg_minutes ?? row.minutes ?? row.min ?? stObj.mpg ?? stObj.avg_minutes ?? stObj.minutes ?? stObj.min);
    if (minVal !== null && minVal > 0) {
      entry.minSum += minVal;
      entry.minCnt += 1;
    }
    const ptsVal = parseNumericStat(row.ppg ?? row.avg_points ?? (row as any).points_per_game ?? row.points ?? row.pts ?? stObj.ppg ?? stObj.avg_points ?? stObj.points_per_game ?? stObj.points ?? stObj.pts);
    const rebVal = parseNumericStat((row as any).rpg ?? (row as any).avg_rebounds ?? (row as any).rebounds ?? (row as any).reb ?? stObj.rpg ?? stObj.avg_rebounds ?? stObj.rebounds ?? stObj.reb);
    const explicitPra = parseNumericStat((row as any).avg_pra ?? (row as any).pra ?? stObj.avg_pra ?? stObj.pra);
    const goalsVal = parseNumericStat(row.goals ?? stObj.goals ?? stObj.g);
    const assistsVal = parseNumericStat(row.assists ?? (row as any).apg ?? (row as any).avg_assists ?? (row as any).ast ?? stObj.assists ?? stObj.apg ?? stObj.avg_assists ?? stObj.ast ?? stObj.a);
    if (ptsVal !== null) {
      if (rowIsSeasonStats && targetSport === 'nhl' && gamesPlayedVal !== null && gamesPlayedVal >= 5 && ptsVal > 5) {
        // NHL season totals (e.g. 95 points in 70 GP) -> compute per-game average while keeping totalPoints
        entry.ptsSum += ptsVal / gamesPlayedVal;
        entry.ptsCnt += 1;
        entry.totalPoints += ptsVal;
      } else {
        entry.ptsSum += ptsVal;
        entry.ptsCnt += 1;
        entry.totalPoints += ptsVal;
      }
    } else if (goalsVal !== null || assistsVal !== null) {
      const comb = (goalsVal ?? 0) + (assistsVal ?? 0);
      if (rowIsSeasonStats && gamesPlayedVal !== null && gamesPlayedVal >= 5 && comb > 5) {
        entry.ptsSum += comb / gamesPlayedVal;
        entry.ptsCnt += 1;
      } else {
        entry.ptsSum += comb;
        entry.ptsCnt += 1;
      }
      entry.totalPoints += comb;
    }
    if (explicitPra !== null) {
      entry.praSum += explicitPra;
      entry.praCnt += 1;
    } else if (ptsVal !== null && (rebVal !== null || (targetSport === 'nba' && assistsVal !== null))) {
      entry.praSum += ptsVal + (rebVal ?? 0) + (assistsVal ?? 0);
      entry.praCnt += 1;
    }

    const rawToiSec = parseNumericStat((row as any).toi_seconds ?? stObj.toi_seconds);
    const toiVal =
      parseNumericStat(
        row.avg_toi ??
        (row as any).avg_toi_minutes ??
        (row as any).toi_per_game ??
        (row as any).time_on_ice_per_game ??
        row.toi_minutes ??
        row.toi ??
        row.time_on_ice ??
        stObj.avg_toi ??
        stObj.toi_per_game ??
        stObj.toi ??
        stObj.time_on_ice ??
        stObj.toi_minutes
      ) ?? (rawToiSec !== null ? rawToiSec / 60 : null);
    if (toiVal !== null && toiVal > 0) {
      entry.toiSum += toiVal;
      entry.toiCnt += 1;
    }

    const passAtt = parseNumericStat(row.pass_attempts ?? row.passing_attempts ?? row.pass_att ?? row.attempts ?? stObj.pass_attempts ?? stObj.pass_att);
    if (passAtt !== null) entry.totalPassAttempts += passAtt;

    const rawRushAtt = parseNumericStat(row.rush_attempts ?? row.rushing_attempts ?? stObj.rush_attempts ?? stObj.rush_att);
    const rawTargets = parseNumericStat(row.targets ?? stObj.targets);
    const rushAtt = rawRushAtt ?? 0;
    const targets = rawTargets ?? 0;
    const rec = parseNumericStat(row.receptions ?? stObj.receptions ?? stObj.rec) ?? 0;
    entry.totalTouches += rushAtt + Math.max(targets, rec);
    if (rawTargets !== null) {
      entry.targetsSum += rowIsSeasonStats && gamesPlayedVal !== null && gamesPlayedVal >= 5 && rawTargets > 20 ? rawTargets / gamesPlayedVal : rawTargets;
      entry.targetsCnt += 1;
    }
    if (rawRushAtt !== null) {
      entry.rushAttSum += rowIsSeasonStats && gamesPlayedVal !== null && gamesPlayedVal >= 5 && rawRushAtt > 25 ? rawRushAtt / gamesPlayedVal : rawRushAtt;
      entry.rushAttCnt += 1;
    }

    const startsNum = parseNumericStat(
      row.goalie_starts ??
      row.games_started ??
      row.starts ??
      stObj.goalie_starts ??
      stObj.games_started ??
      stObj.starts
    );
    if (startsNum !== null) entry.starts += startsNum;
    else if (row.started === true || row.started === 1 || stObj.started === true || stObj.started === 1) entry.starts += 1;

    const snapPct = parseNumericStat(row.snap_pct ?? stObj.snap_pct);
    if (snapPct !== null) {
      entry.snapMax = entry.snapMax === null ? snapPct : Math.max(entry.snapMax, snapPct);
    }
    const depthOrd = parseNumericStat(row.depth_chart_order ?? row.depth_rank ?? stObj.depth_chart_order ?? stObj.depth_rank);
    if (row.is_starter === true || row.starter === true || stObj.is_starter === true || stObj.starter === true || depthOrd === 1) {
      entry.isStarter = true;
    }
    if (depthOrd !== null) {
      entry.depthChartOrder = entry.depthChartOrder === null ? depthOrd : Math.min(entry.depthChartOrder, depthOrd);
      teamHasDepthChart = true;
    }
    const isZeroUsageRow =
      !rowIsDepthChart &&
      !rowIsSeasonStats &&
      ((minVal === 0 && (toiVal === null || toiVal === 0)) || (toiVal === 0 && (minVal === null || minVal === 0))) &&
      (ptsVal === null || ptsVal === 0) &&
      rushAtt === 0 &&
      targets === 0 &&
      (passAtt === null || passAtt === 0) &&
      (startsNum === null || startsNum === 0) &&
      (snapPct === null || snapPct === 0);
    if (isZeroUsageRow) {
      entry.zeroUsageRows += 1;
    }
  }

  const playersByName = new Map<string, AggregatedPlayerLogStats>();
  const playersById = new Map<string, AggregatedPlayerLogStats>();
  const allStats: AggregatedPlayerLogStats[] = [];

  for (const [key, e] of acc.entries()) {
    const zeroUsageOnly =
      e.zeroUsageRows > 0 &&
      e.minCnt === 0 &&
      e.toiCnt === 0 &&
      e.totalPoints === 0 &&
      e.ptsSum === 0 &&
      e.praSum === 0 &&
      e.totalTouches === 0 &&
      e.totalPassAttempts === 0 &&
      e.starts === 0 &&
      (e.snapMax === null || e.snapMax === 0) &&
      !e.hasDepthChart &&
      !e.hasSeasonStats;
    const agg: AggregatedPlayerLogStats = {
      playerKey: key,
      ...(e.playerId ? { playerId: e.playerId } : {}),
      playerName: e.playerName,
      teamKeys: e.teamKeys,
      position: e.position,
      games: e.games,
      mpg: e.minCnt > 0 ? e.minSum / e.minCnt : null,
      ppg: e.ptsCnt > 0 ? e.ptsSum / e.ptsCnt : null,
      pra: e.praCnt > 0 ? e.praSum / e.praCnt : null,
      toi: e.toiCnt > 0 ? e.toiSum / e.toiCnt : null,
      avgTargets: e.targetsCnt > 0 ? e.targetsSum / e.targetsCnt : null,
      avgRushAttempts: e.rushAttCnt > 0 ? e.rushAttSum / e.rushAttCnt : null,
      totalPoints: e.totalPoints,
      totalPassAttempts: e.totalPassAttempts,
      totalTouches: e.totalTouches,
      starts: e.starts,
      snapPct: e.snapMax,
      isStarter: e.isStarter,
      depthChartOrder: e.depthChartOrder,
      ...(e.hasSeasonStats ? { hasSeasonStats: true } : {}),
      ...(e.hasDepthChart ? { hasDepthChart: true } : {}),
      ...(zeroUsageOnly ? { zeroUsageOnly: true } : {})
    };
    playersByName.set(key, agg);
    if (agg.playerId) {
      for (const idKey of extractPlayerIdKeys(agg.playerId)) {
        playersById.set(idKey, agg);
      }
    }
    allStats.push(agg);
  }

  let topPasserKey: string | undefined;
  let maxPass = 0;
  for (const s of allStats) {
    if (s.totalPassAttempts > maxPass && (!s.position || s.position === 'QB')) {
      maxPass = s.totalPassAttempts;
      topPasserKey = s.playerKey;
    }
  }

  let topGoalieKey: string | undefined;
  let maxGoalieScore = 0;
  for (const s of allStats) {
    if (/^(?:G|GK|GOALIE|GOALTENDER)$/.test(s.position)) {
      const score = s.starts * 100 + (s.toi ?? 0) + s.games;
      if (score > maxGoalieScore) {
        maxGoalieScore = score;
        topGoalieKey = s.playerKey;
      }
    }
  }

  const top4ScorerKeys = new Set(
    allStats
      .filter((s) => !/^(?:G|GK|GOALIE|GOALTENDER)$/.test(s.position) && s.totalPoints > 0)
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, 4)
      .map((s) => s.playerKey)
  );

  const top3RotationKeys = new Set(
    allStats
      .filter((s) => (s.mpg ?? 0) >= 24)
      .sort((a, b) => (b.mpg ?? 0) - (a.mpg ?? 0))
      .slice(0, 3)
      .map((s) => s.playerKey)
  );

  const hasDatedLogs = distinctGameDates.size > 0;
  const loggedPlayerCount = allStats.length;
  // S2: Require >= 3 distinct game_dates OR depthchart/season_stats coverage (or undated multi-player fixture rows)
  // before treating a team's logs as sufficient for weighted Health Balance comparisons.
  const hasSufficientCoverage =
    distinctGameDates.size >= 3 ||
    teamHasDepthChart ||
    teamHasSeasonStats ||
    (!hasDatedLogs && matchedRowCount >= 2);
  // S2: Only prove an unlogged player is "depth" (0.5) when the team has >= 5 distinct logged game_dates
  // (or undated multi-player legacy fixture without source/date metadata).
  const canProveUnloggedDepth =
    distinctGameDates.size >= 5 ||
    (!hasDatedLogs && !teamHasSeasonStats && !teamHasDepthChart && loggedPlayerCount >= 2);

  return {
    hasLogs: matchedAnyRow,
    distinctGameDates,
    hasDepthChart: teamHasDepthChart,
    hasSeasonStats: teamHasSeasonStats,
    hasDatedLogs,
    loggedPlayerCount,
    hasSufficientCoverage,
    canProveUnloggedDepth,
    playersByName,
    playersById,
    topPasserKey,
    topGoalieKey,
    top4ScorerKeys,
    top3RotationKeys
  };
}

function classifyPlayerInjuryImpact(
  player: any,
  sport: NormalizedInjurySport,
  teamIndex: TeamLogIndex
): { tier: 1 | 2 | 3 | null; weight: number; usedWeightedScoring: boolean; roleLabel: 'star' | 'rotation' | 'depth' | 'unlogged' } {
  const pos = String(player?.position || player?.pos || '').trim().toUpperCase();
  const isQb = /^QB$/i.test(pos);
  const isGoalie = /^(?:G|GK|GOALIE|GOALTENDER)$/i.test(pos);

  // Explicit override fields on payload/fixture
  const explicitWeight = parseNumericStat(player?.impact_weight);
  if (explicitWeight !== null && explicitWeight > 0) {
    const tier: 1 | 2 | 3 = explicitWeight >= 3.0 ? 1 : (explicitWeight >= 1.5 ? 2 : 3);
    return { tier, weight: explicitWeight, usedWeightedScoring: true, roleLabel: tier === 1 ? 'star' : tier === 2 ? 'rotation' : 'depth' };
  }
  const explicitTier = parseNumericStat(player?.impact_tier ?? player?.tier);
  if (explicitTier === 1 || explicitTier === 2 || explicitTier === 3) {
    const w =
      explicitTier === 1
        ? (sport === 'nfl' && isQb ? 5.0 : sport === 'nhl' && isGoalie ? 4.0 : 3.0)
        : explicitTier === 2
          ? 1.5
          : 0.5;
    return { tier: explicitTier, weight: w, usedWeightedScoring: true, roleLabel: explicitTier === 1 ? 'star' : explicitTier === 2 ? 'rotation' : 'depth' };
  }

  const nameKey = normalizePlayerNameKey(player?.player_name || player?.name);
  const pidKeys = [
    ...extractPlayerIdKeys(player?.player_id),
    ...extractPlayerIdKeys(player?.espn_id),
    ...extractPlayerIdKeys(player?.athlete_id)
  ];
  let logStats: AggregatedPlayerLogStats | undefined;
  for (const pk of pidKeys) {
    logStats = teamIndex.playersById.get(pk);
    if (logStats) break;
  }
  if (!logStats && nameKey) {
    logStats = teamIndex.playersByName.get(nameKey);
  }

  // Merge inline stats on the injury item itself if present
  const inlineStats = player?.stats && typeof player.stats === 'object' ? player.stats : {};
  const inlineMpg = parseNumericStat(player?.mpg ?? player?.avg_minutes ?? player?.minutes ?? inlineStats.mpg ?? inlineStats.avg_minutes ?? inlineStats.minutes);
  const inlinePpg = parseNumericStat(player?.ppg ?? player?.avg_points ?? player?.points ?? inlineStats.ppg ?? inlineStats.avg_points ?? inlineStats.points);
  const inlineReb = parseNumericStat(player?.rpg ?? player?.avg_rebounds ?? player?.rebounds ?? player?.reb ?? inlineStats.rpg ?? inlineStats.avg_rebounds ?? inlineStats.rebounds ?? inlineStats.reb);
  const inlineAst = parseNumericStat(player?.apg ?? player?.avg_assists ?? player?.assists ?? player?.ast ?? inlineStats.apg ?? inlineStats.avg_assists ?? inlineStats.assists ?? inlineStats.ast);
  const inlineExplicitPra = parseNumericStat(player?.avg_pra ?? player?.pra ?? inlineStats.avg_pra ?? inlineStats.pra);
  const inlinePra = inlineExplicitPra !== null
    ? inlineExplicitPra
    : (inlinePpg !== null && (inlineReb !== null || (sport === 'nba' && inlineAst !== null))
      ? inlinePpg + (inlineReb ?? 0) + (inlineAst ?? 0)
      : null);
  const inlineToi = parseNumericStat(player?.avg_toi ?? player?.toi_minutes ?? player?.toi ?? player?.time_on_ice ?? inlineStats.avg_toi ?? inlineStats.toi ?? inlineStats.toi_minutes);
  const inlinePassAtt = parseNumericStat(player?.pass_attempts ?? player?.passing_attempts ?? player?.pass_att ?? inlineStats.pass_attempts ?? inlineStats.pass_att);
  const inlineTargets = parseNumericStat(player?.targets ?? inlineStats.targets);
  const inlineRushAtt = parseNumericStat(player?.rush_attempts ?? player?.rushing_attempts ?? inlineStats.rush_attempts ?? inlineStats.rush_att);
  const inlineStarts = parseNumericStat(player?.goalie_starts ?? player?.games_started ?? player?.starts ?? inlineStats.goalie_starts ?? inlineStats.games_started ?? inlineStats.starts);
  const inlineSnapPct = parseNumericStat(player?.snap_pct ?? inlineStats.snap_pct);
  const inlineDepth = parseNumericStat(player?.depth_chart_order ?? player?.depth_rank ?? inlineStats.depth_chart_order ?? inlineStats.depth_rank);
  const inlineStarter =
    player?.is_starter === true ||
    player?.starter === true ||
    inlineStats.is_starter === true ||
    inlineStats.starter === true ||
    inlineDepth === 1;

  const inlineTierNum = parseNumericStat(player?.impact_tier);
  const hasExplicitTier = inlineTierNum === 1 || inlineTierNum === 2 || inlineTierNum === 3;
  const hasInlinePositiveStat =
    (inlineMpg !== null && inlineMpg > 0) ||
    (inlinePpg !== null && inlinePpg > 0) ||
    (inlinePra !== null && inlinePra > 0) ||
    (inlineToi !== null && inlineToi > 0) ||
    (inlinePassAtt !== null && inlinePassAtt > 0) ||
    (inlineTargets !== null && inlineTargets > 0) ||
    (inlineRushAtt !== null && inlineRushAtt > 0) ||
    (inlineStarts !== null && inlineStarts > 0) ||
    (inlineSnapPct !== null && inlineSnapPct > 0) ||
    inlineDepth !== null ||
    inlineStarter;
  const hasInlineStat =
    inlineMpg !== null ||
    inlinePpg !== null ||
    inlinePra !== null ||
    inlineToi !== null ||
    inlinePassAtt !== null ||
    inlineTargets !== null ||
    inlineRushAtt !== null ||
    inlineStarts !== null ||
    inlineSnapPct !== null ||
    inlineDepth !== null ||
    inlineStarter;

  // If upstream payload already classified an explicit impact_tier (1/2/3) without game logs,
  // apply proper tier weights (QB1 5.0, Starting G 4.0, Tier 1 3.0, Tier 2 1.5, Tier 3 0.5) instead of flat 1.0.
  if (!teamIndex.hasLogs && !hasInlineStat && hasExplicitTier) {
    const t = inlineTierNum as 1 | 2 | 3;
    if (t === 1) {
      if (sport === 'nfl' && /^QB$/i.test(pos)) return { tier: 1, weight: 5.0, usedWeightedScoring: true, roleLabel: 'star' };
      if (sport === 'nhl' && /^(?:G|GK|GOALIE|GOALTENDER)$/i.test(pos)) return { tier: 1, weight: 4.0, usedWeightedScoring: true, roleLabel: 'star' };
      return { tier: 1, weight: 3.0, usedWeightedScoring: true, roleLabel: 'star' };
    }
    if (t === 2) return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
    return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
  }

  // S2: Honest unweighted fallback when player_game_logs has 0 rows AND no inline stats/starter/tier metadata.
  if (!teamIndex.hasLogs && !hasInlineStat) {
    return { tier: null, weight: 1.0, usedWeightedScoring: false, roleLabel: 'unlogged' };
  }

  // S2: Stop labeling unlogged or 0-min/0-TOI DNP boxscore rows as "depth" (0.5) when < 5 distinct game dates exist.
  const isZeroMinOrToiOnly = Boolean(
    (logStats?.zeroUsageOnly && !hasInlinePositiveStat) ||
    (!logStats &&
      !hasExplicitTier &&
      !hasInlinePositiveStat &&
      ((inlineMpg === 0 && (inlineToi === null || inlineToi === 0)) ||
        (inlineToi === 0 && (inlineMpg === null || inlineMpg === 0))))
  );
  if (isZeroMinOrToiOnly || (!logStats && !hasInlineStat)) {
    if (teamIndex.canProveUnloggedDepth) {
      return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
    }
    return { tier: null, weight: 1.0, usedWeightedScoring: false, roleLabel: 'unlogged' };
  }

  const effPos = pos || logStats?.position || '';
  const effIsQb = /^QB$/i.test(effPos);
  const effIsGoalie = /^(?:G|GK|GOALIE|GOALTENDER)$/i.test(effPos);
  const mpg = (inlineMpg !== null && inlineMpg > 0 ? inlineMpg : null) ?? logStats?.mpg ?? null;
  const ppg = (inlinePpg !== null && inlinePpg > 0 ? inlinePpg : null) ?? logStats?.ppg ?? null;
  const pra = (inlinePra !== null && inlinePra > 0 ? inlinePra : null) ?? logStats?.pra ?? null;
  const toi = (inlineToi !== null && inlineToi > 0 ? inlineToi : null) ?? logStats?.toi ?? null;
  const passAtt = inlinePassAtt ?? logStats?.totalPassAttempts ?? 0;
  const avgTargets = inlineTargets ?? logStats?.avgTargets ?? 0;
  const avgRushAtt = inlineRushAtt ?? logStats?.avgRushAttempts ?? 0;
  const starts = inlineStarts ?? logStats?.starts ?? 0;
  const snapPct = inlineSnapPct ?? logStats?.snapPct ?? null;
  const depthRank = inlineDepth ?? logStats?.depthChartOrder ?? null;
  const isStarter = inlineStarter || Boolean(logStats?.isStarter) || depthRank === 1;
  const touchesPerGame = logStats && logStats.games > 0 ? logStats.totalTouches / logStats.games : 0;

  if (sport === 'nfl') {
    if (effIsQb) {
      const isQb1 =
        (logStats && teamIndex.topPasserKey === logStats.playerKey) ||
        isStarter ||
        passAtt >= 15 ||
        starts >= 1;
      if (isQb1) return { tier: 1, weight: 5.0, usedWeightedScoring: true, roleLabel: 'star' };
      if ((logStats && logStats.games > 0) || depthRank === 2) return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
      return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
    }
    if (/^(?:LT|OT)$/.test(effPos) && isStarter) {
      return { tier: 1, weight: 4.0, usedWeightedScoring: true, roleLabel: 'star' };
    }
    if (/^(?:EDGE|DE)$/.test(effPos) && isStarter) {
      return { tier: 1, weight: 3.0, usedWeightedScoring: true, roleLabel: 'star' };
    }
    if (avgTargets >= 7 || avgRushAtt >= 12 || (snapPct !== null && snapPct >= 75 && touchesPerGame >= 10)) {
      return { tier: 1, weight: 3.0, usedWeightedScoring: true, roleLabel: 'star' };
    }
    if (isStarter || depthRank === 2 || (snapPct !== null && snapPct >= 30) || touchesPerGame >= 2.5 || (logStats && logStats.games >= 2)) {
      return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
    }
    return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
  }

  if (sport === 'nhl') {
    if (effIsGoalie) {
      const isStartingG =
        (logStats && teamIndex.topGoalieKey === logStats.playerKey) ||
        isStarter ||
        starts >= 1 ||
        (toi !== null && toi >= 45);
      if (isStartingG) return { tier: 1, weight: 4.0, usedWeightedScoring: true, roleLabel: 'star' };
      if ((logStats && logStats.games > 0) || depthRank === 2) return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
      return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
    }
    const isDefenseman = /^(?:D|LD|RD|DEF|DEFENSE|DEFENSEMAN)$/.test(effPos);
    const isTopLineSkater = toi !== null && toi >= 19.5 && ppg !== null && ppg >= 0.70;
    const isTopPairDefenseman = isDefenseman && toi !== null && toi >= 21.5;
    if (isTopLineSkater || isTopPairDefenseman) {
      return { tier: 1, weight: 3.0, usedWeightedScoring: true, roleLabel: 'star' };
    }
    if (isStarter || depthRank === 2 || (toi !== null && toi >= 13) || (ppg !== null && ppg >= 0.35)) {
      return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
    }
    return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
  }

  if (sport === 'nba') {
    const isHighUsageStar =
      (mpg !== null && mpg >= 28 && ((ppg !== null && ppg >= 18) || (pra !== null && pra >= 28))) ||
      (mpg !== null && mpg >= 31);
    if (isHighUsageStar) {
      return { tier: 1, weight: 3.0, usedWeightedScoring: true, roleLabel: 'star' };
    }
    if (isStarter || depthRank === 2 || (mpg !== null && mpg >= 15) || (ppg !== null && ppg >= 10)) {
      return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
    }
    return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
  }

  // NCAAF / other sports when logs or inline starter tags exist
  if (isStarter) return { tier: 1, weight: 3.0, usedWeightedScoring: true, roleLabel: 'star' };
  if (depthRank === 2 || (logStats && logStats.games > 0)) return { tier: 2, weight: 1.5, usedWeightedScoring: true, roleLabel: 'rotation' };
  return { tier: 3, weight: 0.5, usedWeightedScoring: true, roleLabel: 'depth' };
}

function formatImpactDetailSegment(
  outCount: number,
  outImpact: number,
  namedOutPlayers: string[],
  depthOutCount: number,
  weightedMode: boolean,
  unloggedOutCount: number = 0,
  tier1OutCount: number = 0,
  tier2OutCount: number = 0
): string {
  if (!weightedMode) return `${outCount} OUT`;
  const parts: string[] = [];
  if (unloggedOutCount > 0) {
    // S3: Partial-coverage transparent tier labeling (e.g. "[impact 5.0: 1 Tier-1, 2 unlogged]" or "[impact 3.0: 3 unlogged]")
    // without ever labeling unlogged players as "depth".
    if (tier1OutCount > 0) parts.push(`${tier1OutCount} Tier-1`);
    if (tier2OutCount > 0) parts.push(`${tier2OutCount} Tier-2`);
    if (tier1OutCount === 0 && tier2OutCount === 0 && namedOutPlayers.length > 0) {
      parts.push(namedOutPlayers.slice(0, 4).join(', '));
    }
    if (depthOutCount > 0) parts.push(`${depthOutCount} depth`);
    parts.push(`${unloggedOutCount} unlogged`);
    return `${outCount} OUT [impact ${outImpact.toFixed(1)}: ${parts.join(', ')}]`;
  }
  const names = namedOutPlayers.slice(0, 4);
  if (names.length > 0) parts.push(names.join(', '));
  if (depthOutCount > 0) {
    parts.push(parts.length > 0 ? `+ ${depthOutCount} depth` : `${depthOutCount} depth`);
  }
  const detailStr = parts.length > 0 ? `: ${parts.join(' ')}` : '';
  return `${outCount} OUT [impact ${outImpact.toFixed(1)}${detailStr}]`;
}

export function classifyInjuryHealthBalance(params: {
  homeTeam: string;
  awayTeam: string;
  homeOut: number;
  homeQ: number;
  awayOut: number;
  awayQ: number;
  sport?: string;
  gameId?: string;
  homeOutImpact?: number;
  awayOutImpact?: number;
  homeQImpact?: number;
  awayQImpact?: number;
  homeNamedOut?: string[];
  homeDepthOut?: number;
  homeUnloggedOut?: number;
  homeTier1OutCount?: number;
  homeTier2OutCount?: number;
  awayNamedOut?: string[];
  awayDepthOut?: number;
  awayUnloggedOut?: number;
  awayTier1OutCount?: number;
  awayTier2OutCount?: number;
  homeTier1Q?: string[];
  awayTier1Q?: string[];
  weightedMode?: boolean;
  unweightedFallback?: boolean;
}): InjuryHealthSummaryResult {
  const { homeTeam, awayTeam, homeOut, homeQ, awayOut, awayQ, sport, gameId } = params;
  const sportScope = `${sport || ''} ${gameId || ''}`;
  const isFootball = /^(?:\s*)(?:nfl|ncaaf|college-football)-|\b(?:nfl|ncaaf|americanfootball_nfl|americanfootball_ncaaf)\b/i.test(sportScope);
  const qCap = isFootball ? 3 : 2;

  const hasWeighted =
    typeof params.homeOutImpact === 'number' &&
    Number.isFinite(params.homeOutImpact) &&
    typeof params.awayOutImpact === 'number' &&
    Number.isFinite(params.awayOutImpact);

  if (hasWeighted) {
    const homeOutImpact = Math.round(params.homeOutImpact! * 10) / 10;
    const awayOutImpact = Math.round(params.awayOutImpact! * 10) / 10;
    const homeQImpact = Math.round((params.homeQImpact ?? 0) * 10) / 10;
    const awayQImpact = Math.round((params.awayQImpact ?? 0) * 10) / 10;
    const homeTier1Q = Array.isArray(params.homeTier1Q) ? params.homeTier1Q.filter(Boolean) : [];
    const awayTier1Q = Array.isArray(params.awayTier1Q) ? params.awayTier1Q.filter(Boolean) : [];
    const weightedMode = params.weightedMode !== false;

    const homeGap = Math.round((awayOutImpact - homeOutImpact) * 10) / 10;
    const awayGap = Math.round((homeOutImpact - awayOutImpact) * 10) / 10;

    let balance: HealthBalanceClassification;
    let label: string;

    if (homeTier1Q.length > 0 || awayTier1Q.length > 0) {
      balance = 'uncertain_questionable';
      const tier1Notes: string[] = [];
      if (homeTier1Q.length > 0) tier1Notes.push(`${homeTeam}: Tier-1 Q ${homeTier1Q.join(', ')}`);
      if (awayTier1Q.length > 0) tier1Notes.push(`${awayTeam}: Tier-1 Q ${awayTier1Q.join(', ')}`);
      label = `uncertain_questionable (${tier1Notes.join('; ')})`;
    } else if (homeGap >= 2.5) {
      if (homeQ >= qCap) {
        if (homeGap >= 6.0) {
          balance = 'conditional_home_advantage';
          label = weightedMode
            ? `conditional_home_advantage (${homeTeam}, +${homeGap.toFixed(1)} impact edge — watch ${homeQ} Q)`
            : `conditional_home_advantage (${homeTeam} — watch ${homeQ} Q)`;
        } else {
          balance = 'uncertain_questionable';
          label = `uncertain_questionable (${homeTeam}: ${homeQ} Q)`;
        }
      } else {
        balance = 'home_advantage';
        label = weightedMode
          ? `home_advantage (${homeTeam}, +${homeGap.toFixed(1)} impact edge)`
          : `home_advantage (${homeTeam})`;
      }
    } else if (awayGap >= 2.5) {
      if (awayQ >= qCap) {
        if (awayGap >= 6.0) {
          balance = 'conditional_away_advantage';
          label = weightedMode
            ? `conditional_away_advantage (${awayTeam}, +${awayGap.toFixed(1)} impact edge — watch ${awayQ} Q)`
            : `conditional_away_advantage (${awayTeam} — watch ${awayQ} Q)`;
        } else {
          balance = 'uncertain_questionable';
          label = `uncertain_questionable (${awayTeam}: ${awayQ} Q)`;
        }
      } else {
        balance = 'away_advantage';
        label = weightedMode
          ? `away_advantage (${awayTeam}, +${awayGap.toFixed(1)} impact edge)`
          : `away_advantage (${awayTeam})`;
      }
    } else if (homeQ >= qCap && awayQ >= qCap) {
      balance = 'uncertain_questionable';
      label = 'uncertain_questionable';
    } else {
      balance = 'symmetric';
      label = 'symmetric';
    }

    const homeSeg = formatImpactDetailSegment(
      homeOut,
      homeOutImpact,
      params.homeNamedOut || [],
      params.homeDepthOut || 0,
      weightedMode,
      params.homeUnloggedOut || 0,
      params.homeTier1OutCount || 0,
      params.homeTier2OutCount || 0
    );
    const awaySeg = formatImpactDetailSegment(
      awayOut,
      awayOutImpact,
      params.awayNamedOut || [],
      params.awayDepthOut || 0,
      weightedMode,
      params.awayUnloggedOut || 0,
      params.awayTier1OutCount || 0,
      params.awayTier2OutCount || 0
    );

    return {
      balance,
      label,
      homeTeam,
      awayTeam,
      homeOut,
      homeQ,
      awayOut,
      awayQ,
      homeOutImpact,
      awayOutImpact,
      homeQImpact,
      awayQImpact,
      tier1QuestionablePlayers: [...homeTier1Q, ...awayTier1Q],
      line: `Summary: ${homeTeam} (${homeSeg}, ${homeQ} Q) vs ${awayTeam} (${awaySeg}, ${awayQ} Q) | Health Balance: ${label}`
    };
  }

  // Legacy headcount-only path when caller invokes classifyInjuryHealthBalance directly without weighted impacts
  const homeTotal = homeOut + homeQ;
  const awayTotal = awayOut + awayQ;
  const homeNominalBetter = (awayOut - homeOut >= 2) || (awayTotal - homeTotal >= 2 && homeQ === 0);
  const awayNominalBetter = (homeOut - awayOut >= 2) || (homeTotal - awayTotal >= 2 && awayQ === 0);

  let balance: HealthBalanceClassification;
  let label: string;
  if (homeNominalBetter && !awayNominalBetter) {
    if (homeQ >= qCap) {
      if (awayOut - homeOut >= 6 && homeQ === qCap) {
        balance = 'conditional_home_advantage';
        label = `conditional_home_advantage (${homeTeam} — watch ${homeQ} Q)`;
      } else {
        balance = 'uncertain_questionable';
        label = `uncertain_questionable (${homeTeam}: ${homeQ} Q)`;
      }
    } else {
      balance = 'home_advantage';
      label = `home_advantage (${homeTeam})`;
    }
  } else if (awayNominalBetter && !homeNominalBetter) {
    if (awayQ >= qCap) {
      if (homeOut - awayOut >= 6 && awayQ === qCap) {
        balance = 'conditional_away_advantage';
        label = `conditional_away_advantage (${awayTeam} — watch ${awayQ} Q)`;
      } else {
        balance = 'uncertain_questionable';
        label = `uncertain_questionable (${awayTeam}: ${awayQ} Q)`;
      }
    } else {
      balance = 'away_advantage';
      label = `away_advantage (${awayTeam})`;
    }
  } else if (homeQ >= qCap && awayQ >= qCap) {
    balance = 'uncertain_questionable';
    label = 'uncertain_questionable';
  } else {
    balance = 'symmetric';
    label = 'symmetric';
  }

  const finalLabel = params.unweightedFallback ? `${label} [unweighted_fallback]` : label;

  return {
    balance,
    label: finalLabel,
    homeTeam,
    awayTeam,
    homeOut,
    homeQ,
    awayOut,
    awayQ,
    line: `Summary: ${homeTeam} (${homeOut} OUT, ${homeQ} Q) vs ${awayTeam} (${awayOut} OUT, ${awayQ} Q) | Health Balance: ${finalLabel}`
  };
}

export interface PlayerGameLogStarterRow {
  source?: string;
  game_date?: string;
  player_id?: string | number;
  player_name?: string;
  name?: string;
  team_id?: string | number;
  team_abbr?: string;
  team?: string;
  position?: string;
  pos?: string;
  starter?: boolean;
  depth_rank?: number;
  minutes?: number;
  min?: number;
  mpg?: number;
  avg_minutes?: number;
  points?: number;
  ppg?: number;
  avg_points?: number;
  points_per_game?: number;
  goals?: number;
  assists?: number;
  games_played?: number;
  gp?: number;
  toi?: number | string;
  avg_toi?: number | string;
  toi_minutes?: number | string;
  snaps?: number;
  snap_pct?: number;
  games_started?: number;
  stats?: {
    source?: string;
    starter?: boolean;
    position?: string;
    pos?: string;
    depth_rank?: number;
    minutes?: number;
    min?: number;
    mpg?: number;
    avg_minutes?: number;
    points?: number;
    ppg?: number;
    avg_points?: number;
    points_per_game?: number;
    goals?: number;
    assists?: number;
    games_played?: number;
    gp?: number;
    toi?: number | string;
    avg_toi?: number | string;
    toi_minutes?: number | string;
    snaps?: number;
    snap_pct?: number;
    games_started?: number;
    [key: string]: unknown;
  };
}

export interface InjuryStarterTierScore {
  tier: 1 | 2 | 3;
  weight: number;
  starter: boolean;
  position?: string;
  depthRank?: number;
  source: 'espn_depthchart' | 'season_stats' | 'boxscore';
}

function getTier1StarterWeight(positionRaw?: string, sportHint?: string): number {
  const pos = String(positionRaw || '').trim().toUpperCase();
  const sport = String(sportHint || '').trim().toLowerCase();
  if (pos === 'QB' || pos === 'QUARTERBACK') return 5.0;
  if (pos === 'LT' || pos === 'OT') return 4.0;
  if (
    pos === 'G' &&
    (sport.includes('nhl') || sport.includes('hockey'))
  ) {
    return 4.0;
  }
  if (pos === 'GOALIE' || pos === 'GOALTENDER' || pos === 'GK') return 4.0;
  return 3.0;
}

/**
 * Scores a `public.player_game_logs` row (supporting `source === "espn_depthchart"`,
 * `source === "espn_season_stats" | "nhl_club_stats" | "season_stats"`, and regular boxscore rows)
 * into a deterministic Tier 1-3 starter impact weight.
 */
export function scorePlayerGameLogStarterRow(
  row: PlayerGameLogStarterRow,
  sportHint?: string
): InjuryStarterTierScore | null {
  if (!row || typeof row !== 'object') return null;
  const stats = row.stats && typeof row.stats === 'object' ? row.stats : {};
  const src = String(row.source ?? stats.source ?? '').trim().toLowerCase();
  const rawPos = String(stats.position ?? stats.pos ?? row.position ?? row.pos ?? '').trim().toUpperCase();
  const position = rawPos || undefined;

  if (isDepthChartSource(src)) {
    const rawRank: unknown = stats.depth_rank ?? row.depth_rank;
    const depthRank = typeof rawRank === 'number' && Number.isFinite(rawRank)
      ? rawRank
      : (typeof rawRank === 'string' && /^\d+$/.test(rawRank.trim()) ? Number(rawRank.trim()) : undefined);
    const starterFlag = stats.starter === true || row.starter === true || depthRank === 1;
    const isTier1DepthPosition = Boolean(
      position &&
      (position === 'QB' ||
        position === 'QUARTERBACK' ||
        position === 'LT' ||
        position === 'OT' ||
        position === 'EDGE' ||
        position === 'DE' ||
        position === 'GOALIE' ||
        position === 'GOALTENDER' ||
        position === 'GK' ||
        (position === 'G' && (/nhl|hockey/i.test(String(sportHint || '')))))
    );
    if (starterFlag && isTier1DepthPosition) {
      return {
        tier: 1,
        weight: getTier1StarterWeight(position, sportHint),
        starter: true,
        ...(position ? { position } : {}),
        ...(depthRank !== undefined ? { depthRank } : {}),
        source: 'espn_depthchart'
      };
    }
    if (starterFlag || depthRank === 2) {
      return {
        tier: 2,
        weight: 1.5,
        starter: starterFlag,
        ...(position ? { position } : {}),
        ...(depthRank !== undefined ? { depthRank } : {}),
        source: 'espn_depthchart'
      };
    }
    return {
      tier: 3,
      weight: 0.5,
      starter: false,
      ...(position ? { position } : {}),
      ...(depthRank !== undefined ? { depthRank } : {}),
      source: 'espn_depthchart'
    };
  }

  const starterFlag = stats.starter === true || row.starter === true || Number(stats.games_started ?? row.games_started ?? 0) > 0;
  const minsVal = parseNumericStat(stats.mpg ?? stats.avg_minutes ?? stats.minutes ?? stats.min ?? row.mpg ?? row.avg_minutes ?? row.minutes ?? row.min);
  const ptsVal = parseNumericStat(stats.ppg ?? stats.avg_points ?? stats.points_per_game ?? stats.points ?? row.ppg ?? row.avg_points ?? row.points_per_game ?? row.points);
  const rebVal = parseNumericStat((stats as any).rpg ?? (stats as any).avg_rebounds ?? (stats as any).rebounds ?? (stats as any).reb ?? (row as any).rpg ?? (row as any).avg_rebounds ?? (row as any).rebounds ?? (row as any).reb);
  const explicitPraVal = parseNumericStat((stats as any).avg_pra ?? (stats as any).pra ?? (row as any).avg_pra ?? (row as any).pra);
  const goalsVal = parseNumericStat(stats.goals ?? row.goals);
  const assistsVal = parseNumericStat(stats.assists ?? (stats as any).apg ?? (stats as any).avg_assists ?? (stats as any).ast ?? row.assists ?? (row as any).apg ?? (row as any).avg_assists ?? (row as any).ast);
  const gpVal = parseNumericStat(stats.games_played ?? stats.gp ?? row.games_played ?? row.gp);
  const rawToiSec = parseNumericStat((stats as any).toi_seconds ?? (row as any).toi_seconds);
  const toiVal = parseNumericStat(stats.avg_toi ?? stats.toi_minutes ?? stats.toi ?? row.avg_toi ?? row.toi_minutes ?? row.toi) ?? (rawToiSec !== null ? rawToiSec / 60 : null);
  const snapPctVal = parseNumericStat(stats.snap_pct ?? row.snap_pct);
  const snapsVal = parseNumericStat(stats.snaps ?? row.snaps);
  const targetsVal = parseNumericStat((stats as any).targets ?? (row as any).targets);
  const rushAttVal = parseNumericStat((stats as any).rush_attempts ?? (stats as any).rushing_attempts ?? (row as any).rush_attempts ?? (row as any).rushing_attempts);

  const isSeasonStats = isSeasonStatsSource(src);
  const normSport = normalizeInjurySport(sportHint);
  const praVal = explicitPraVal !== null
    ? explicitPraVal
    : (ptsVal !== null && (rebVal !== null || (normSport === 'nba' && assistsVal !== null))
      ? ptsVal + (rebVal ?? 0) + (assistsVal ?? 0)
      : null);

  if (
    !isSeasonStats &&
    !starterFlag &&
    ((minsVal === 0 && (toiVal === null || toiVal === 0)) || (toiVal === 0 && (minsVal === null || minsVal === 0))) &&
    (ptsVal === null || ptsVal === 0) &&
    (snapsVal === null || snapsVal === 0) &&
    (targetsVal === null || targetsVal === 0) &&
    (rushAttVal === null || rushAttVal === 0)
  ) {
    return null;
  }

  const hasSignal =
    starterFlag ||
    minsVal !== null ||
    ptsVal !== null ||
    goalsVal !== null ||
    assistsVal !== null ||
    toiVal !== null ||
    snapPctVal !== null ||
    snapsVal !== null ||
    targetsVal !== null ||
    rushAttVal !== null;
  if (!hasSignal) return null;

  const scoreSource: 'season_stats' | 'boxscore' = isSeasonStats ? 'season_stats' : 'boxscore';

  if (isSeasonStats) {
    // NHL season stats (nhl_club_stats)
    const isHockey = normSport === 'nhl' || src === 'nhl_club_stats';
    if (isHockey) {
      const combPts = ptsVal ?? ((goalsVal ?? 0) + (assistsVal ?? 0));
      const ptsPerGame = gpVal !== null && gpVal >= 5 && combPts > 5 ? combPts / gpVal : combPts;
      const isGoaliePos = /^(?:G|GK|GOALIE|GOALTENDER)$/.test(rawPos);
      const isDefenseman = /^(?:D|LD|RD|DEF|DEFENSE|DEFENSEMAN)$/.test(rawPos);
      const isTier1Nhl = isGoaliePos
        ? (starterFlag || (toiVal !== null && toiVal >= 45))
        : ((toiVal !== null && toiVal >= 19.5 && ptsPerGame !== null && ptsPerGame >= 0.70) ||
           (isDefenseman && toiVal !== null && toiVal >= 21.5));
      if (isTier1Nhl) {
        return {
          tier: 1,
          weight: getTier1StarterWeight(position, sportHint || 'nhl'),
          starter: true,
          ...(position ? { position } : {}),
          source: 'season_stats'
        };
      }
      if (starterFlag || (toiVal !== null && toiVal >= 13) || (ptsPerGame !== null && ptsPerGame >= 0.35)) {
        return {
          tier: 2,
          weight: 1.5,
          starter: starterFlag,
          ...(position ? { position } : {}),
          source: 'season_stats'
        };
      }
      return {
        tier: 3,
        weight: 0.5,
        starter: false,
        ...(position ? { position } : {}),
        source: 'season_stats'
      };
    }

    // NBA / NFL / general season stats (espn_season_stats)
    const isTier1NbaSeason =
      (minsVal !== null && minsVal >= 28 && ((ptsVal !== null && ptsVal >= 18) || (praVal !== null && praVal >= 28))) ||
      (minsVal !== null && minsVal >= 31);
    const isTier1Season = normSport === 'nba'
      ? isTier1NbaSeason
      : (isTier1NbaSeason ||
        (/^(?:QB|QUARTERBACK|LT|OT|EDGE|DE)$/.test(rawPos) && starterFlag) ||
        (targetsVal !== null && targetsVal >= 7) ||
        (rushAttVal !== null && rushAttVal >= 12) ||
        (toiVal !== null && toiVal >= 19.5 && ptsVal !== null && ptsVal >= 0.70) ||
        (snapPctVal !== null && snapPctVal >= 75));
    if (isTier1Season) {
      return {
        tier: 1,
        weight: getTier1StarterWeight(position, sportHint),
        starter: true,
        ...(position ? { position } : {}),
        source: 'season_stats'
      };
    }
    const isTier2Season =
      starterFlag ||
      (minsVal !== null && minsVal >= 15) ||
      (ptsVal !== null && ptsVal >= 10) ||
      (toiVal !== null && toiVal >= 13) ||
      (snapPctVal !== null && snapPctVal >= 30) ||
      (snapsVal !== null && snapsVal >= 15);
    if (isTier2Season) {
      return {
        tier: 2,
        weight: 1.5,
        starter: starterFlag,
        ...(position ? { position } : {}),
        source: 'season_stats'
      };
    }
    return {
      tier: 3,
      weight: 0.5,
      starter: false,
      ...(position ? { position } : {}),
      source: 'season_stats'
    };
  }

  // Regular boxscore log fallback
  const isNhlBoxGoalie = normSport === 'nhl' && /^(?:G|GK|GOALIE|GOALTENDER)$/.test(rawPos);
  const isNhlBoxDef = normSport === 'nhl' && /^(?:D|LD|RD|DEF|DEFENSE|DEFENSEMAN)$/.test(rawPos);
  const isStarterByUsage = normSport === 'nba'
    ? ((minsVal !== null && minsVal >= 28 && ((ptsVal !== null && ptsVal >= 18) || (praVal !== null && praVal >= 28))) || (minsVal !== null && minsVal >= 31))
    : normSport === 'nhl'
      ? (isNhlBoxGoalie
          ? (starterFlag || (toiVal !== null && toiVal >= 45))
          : ((toiVal !== null && toiVal >= 19.5 && ptsVal !== null && ptsVal >= 0.70) || (isNhlBoxDef && toiVal !== null && toiVal >= 21.5)))
      : ((/^(?:QB|QUARTERBACK|LT|OT|EDGE|DE)$/.test(rawPos) && starterFlag) ||
         (targetsVal !== null && targetsVal >= 7) ||
         (rushAttVal !== null && rushAttVal >= 12) ||
         (snapPctVal !== null && snapPctVal >= 75 && snapsVal !== null && snapsVal >= 45));
  if (isStarterByUsage) {
    return {
      tier: 1,
      weight: getTier1StarterWeight(position, sportHint),
      starter: true,
      ...(position ? { position } : {}),
      source: scoreSource
    };
  }

  const isRotationByUsage =
    starterFlag ||
    (minsVal !== null && minsVal >= 15) ||
    (ptsVal !== null && ptsVal >= 10 && normSport === 'nba') ||
    (toiVal !== null && toiVal >= 13) ||
    (snapPctVal !== null && snapPctVal >= 30) ||
    (snapsVal !== null && snapsVal >= 15);
  if (isRotationByUsage) {
    return {
      tier: 2,
      weight: 1.5,
      starter: starterFlag,
      ...(position ? { position } : {}),
      source: scoreSource
    };
  }

  return {
    tier: 3,
    weight: 0.5,
    starter: false,
    ...(position ? { position } : {}),
    source: scoreSource
  };
}

/**
 * Matches an injury record against `public.player_game_logs` rows (including `espn_depthchart` rows)
 * and inline depth-chart fields, returning the highest-impact starter tier score.
 */
export function scoreInjuryStarterTier(
  injury: Record<string, any>,
  playerLogs: PlayerGameLogStarterRow[] = [],
  sportHint?: string
): InjuryStarterTierScore | null {
  if (!injury || typeof injury !== 'object') return null;

  const candidates: PlayerGameLogStarterRow[] = [];
  if (injury.source || injury.stats || injury.depth_rank !== undefined || injury.starter !== undefined) {
    candidates.push(injury as PlayerGameLogStarterRow);
  }
  if (Array.isArray(injury.player_game_logs)) {
    candidates.push(...injury.player_game_logs);
  }
  if (Array.isArray(injury.game_logs)) {
    candidates.push(...injury.game_logs);
  }

  const injId = injury.player_id !== undefined && injury.player_id !== null ? String(injury.player_id).trim() : '';
  const injName = String(injury.player_name || injury.name || '').trim().toLowerCase();

  for (const log of playerLogs) {
    if (!log || typeof log !== 'object') continue;
    const logId = log.player_id !== undefined && log.player_id !== null ? String(log.player_id).trim() : '';
    const logName = String(log.player_name || log.name || '').trim().toLowerCase();
    const idMatch = Boolean(injId && logId && injId === logId);
    const nameMatch = Boolean(injName && logName && (injName === logName || injName.includes(logName) || logName.includes(injName)));
    if (idMatch || nameMatch) {
      candidates.push(log);
    }
  }

  let best: InjuryStarterTierScore | null = null;
  for (const cand of candidates) {
    const scored = scorePlayerGameLogStarterRow(cand, sportHint);
    if (!scored) continue;
    if (
      !best ||
      scored.weight > best.weight ||
      (scored.weight === best.weight && scored.source === 'espn_depthchart' && best.source !== 'espn_depthchart')
    ) {
      best = scored;
    }
  }
  return best;
}

/**
 * Tool 2: get_injury_and_roster_delta
 * Parameters: game_id: string, position_group?: string
 */
export const getInjuryAndRosterDeltaTool: SwarmTool = {
  name: 'get_injury_and_roster_delta',
  description: 'Pulls injury status and minute/usage shifts for a game.',
  parameters: {
    game_id: {
      type: 'string',
      description: 'Game ID',
      required: true
    },
    position_group: {
      type: 'string',
      description: 'Optional position filter (e.g. QB, WR)'
    }
  },
  execute: async (args: Record<string, any>, context?: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> }) => {
    if (!args || typeof args.game_id !== 'string' || !args.game_id.trim()) {
      return {
        success: false,
        error: 'invalid_game_id',
        message: 'Missing or empty game_id parameter.',
        summary: 'Error: Missing or empty game_id parameter.'
      };
    }
    const gameId = args.game_id.trim();

    if (isOptionCitationId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' is an option citation ID, not a canonical event ID.`,
        summary: `Error: Game ID '${gameId}' is an option citation ID, not a canonical event ID.`
      };
    }

    const positionGroup = typeof args.position_group === 'string' && args.position_group.trim()
      ? args.position_group.trim()
      : undefined;

    const rpcRes = await callSupabaseRpc(
      'get_injury_and_roster_delta_v1',
      { p_game_id: gameId, ...(positionGroup ? { p_position_group: positionGroup } : {}) },
      { fetchFn: context?.fetchFn, env: context?.env }
    );

    if (!rpcRes.ok) {
      return {
        success: false,
        error: rpcRes.error,
        message: rpcRes.message,
        summary: `Error fetching injury/roster delta for ${gameId}: ${rpcRes.message}`
      };
    }

    const d = rpcRes.data || {};
    if (isRpcEmptyResult(d) && !isCanonicalOrHexId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' could not be resolved to a canonical event.`,
        summary: `Error: Game ID '${gameId}' could not be resolved to canonical event.`
      };
    }
    const injuries = Array.isArray(d.injuries)
      ? d.injuries
      : Array.isArray(d.players)
        ? d.players
        : Array.isArray(d)
          ? d
          : [];

    const teamLabelMap = new Map<string, string>();
    const addTeamMapping = (id: unknown, label: unknown) => {
      if (id !== undefined && id !== null && String(id).trim() && typeof label === 'string' && label.trim()) {
        teamLabelMap.set(String(id).trim(), label.trim());
      }
    };
    addTeamMapping(d.home_team_id ?? d.home?.team_id ?? d.home?.id, d.home_team_abbr ?? d.home_abbr ?? d.home_team ?? d.home?.abbr ?? d.home?.name);
    addTeamMapping(d.away_team_id ?? d.away?.team_id ?? d.away?.id, d.away_team_abbr ?? d.away_abbr ?? d.away_team ?? d.away?.abbr ?? d.away?.name);
    if (Array.isArray(d.teams)) {
      for (const t of d.teams) {
        addTeamMapping(t?.team_id ?? t?.id, t?.abbr ?? t?.team_abbr ?? t?.name ?? t?.team_name);
      }
    }
    const ctxAny = context as any;
    if (ctxAny?.teamMap && typeof ctxAny.teamMap === 'object') {
      for (const [k, v] of Object.entries(ctxAny.teamMap)) {
        addTeamMapping(k, v);
      }
    }
    if (ctxAny?.game) {
      addTeamMapping(ctxAny.game.home_team_id ?? d.home_team_id ?? d.home?.team_id ?? d.home?.id, ctxAny.game.home_team_abbr ?? ctxAny.game.home_team);
      addTeamMapping(ctxAny.game.away_team_id ?? d.away_team_id ?? d.away?.team_id ?? d.away?.id, ctxAny.game.away_team_abbr ?? ctxAny.game.away_team);
    }

    const statusRank = (statusRaw: unknown): number => {
      const s = String(statusRaw || '').toLowerCase().trim();
      if (s === 'out' || s === 'ir' || s === 'injured reserve' || s === 'suspended') return 0;
      if (s === 'doubtful') return 1;
      if (s === 'questionable') return 2;
      return 3;
    };

    const sportHint = String(
      [d.sport, ctxAny?.game?.sport, gameId].find(
        (s) => s && !/^unknown$/i.test(String(s).trim()) && Boolean(String(s).trim())
      ) || ''
    );
    const matchupTeams = [
      d.away_team,
      d.home_team,
      d.away?.name,
      d.home?.name,
      ctxAny?.game?.away_team,
      ctxAny?.game?.home_team
    ].filter((t): t is string => typeof t === 'string' && Boolean(t.trim()));

    const rawTotalInjuries =
      typeof d.total_injuries === 'number' && Number.isFinite(d.total_injuries)
        ? d.total_injuries
        : injuries.length;

    const playerLogs: PlayerGameLogStarterRow[] = [
      ...(Array.isArray(d.player_game_logs) ? d.player_game_logs : []),
      ...(Array.isArray(d.depth_chart) ? d.depth_chart : []),
      ...(Array.isArray(d.starter_logs) ? d.starter_logs : []),
      ...(Array.isArray(ctxAny?.playerGameLogs) ? ctxAny.playerGameLogs : [])
    ];

    const grouped = new Map<string, { label: string; items: any[] }>();
    const keptInjuries: any[] = [];
    for (const p of injuries) {
      if (!p || typeof p !== 'object') continue;
      let resolved = resolveInjuryTeam(p, { teamLabelMap, sportHint, matchupTeams });
      if (!resolved) {
        const playerName = String(p.player_name || p.name || '').trim();
        const statusStr = String(p.status || p.injury_status || '').trim();
        const rawTeamId = String(p.team_id || p.teamId || '').trim();
        const isCollegeGame = /ncaa|college/i.test(sportHint) || /ncaa|college/i.test(gameId);
        if (isCollegeGame && playerName && statusStr && rawTeamId) {
          const fallbackName =
            matchupTeams.length === 2
              ? `${matchupTeams[0]} / ${matchupTeams[1]}`
              : matchupTeams[0] || `Team ${rawTeamId}`;
          resolved = {
            abbr: `T${rawTeamId}`,
            name: fallbackName,
            label: `${fallbackName} (ID ${rawTeamId})`
          };
        } else {
          // Drop injury if the tool result does not clearly identify the team
          continue;
        }
      }
      const hadExplicitInputTier =
        parseNumericStat(p.impact_weight) !== null ||
        parseNumericStat(p.impact_tier ?? p.tier) !== null;
      const tierScore = scoreInjuryStarterTier(p, playerLogs, sportHint);
      const enriched = {
        ...p,
        team_abbr: p.team_abbr || resolved.abbr,
        team_name: p.team_name || resolved.name,
        ...(tierScore
          ? {
              position: p.position || p.pos || tierScore.position,
              ...(hadExplicitInputTier
                ? {}
                : {
                    ...(tierScore.depthRank !== undefined && p.depth_rank === undefined ? { depth_rank: tierScore.depthRank } : {})
                  }),
              starter: p.starter ?? tierScore.starter,
              tier_source: tierScore.source
            }
          : {})
      };
      keptInjuries.push(enriched);
      const groupKey = resolved.abbr || resolved.label;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, { label: resolved.label, items: [] });
      }
      grouped.get(groupKey)!.items.push(enriched);
    }

    const isOutTag = (statusRaw: unknown): boolean =>
      /^(?:out|ir|injured\s+reserve|suspended)$/i.test(String(statusRaw || '').trim());
    const isQTag = (statusRaw: unknown): boolean =>
      /^(?:questionable|doubtful|day[- ]to[- ]day|gtd|game[- ]time\s+decision)$/i.test(String(statusRaw || '').trim());

    const resolveFullTeamDisplay = (raw: unknown): string | undefined => {
      if (typeof raw !== 'string' || !raw.trim()) return undefined;
      const trimmed = raw.trim();
      const matched = matchTeamByLabel(trimmed, sportHint);
      return matched ? matched.name : trimmed;
    };

    let homeTeamDisplay =
      resolveFullTeamDisplay(d.home_team) ??
      resolveFullTeamDisplay(d.home?.name) ??
      resolveFullTeamDisplay(ctxAny?.game?.home_team) ??
      resolveFullTeamDisplay(d.home_team_abbr ?? d.home_abbr ?? d.home?.abbr ?? ctxAny?.game?.home_team_abbr);
    let awayTeamDisplay =
      resolveFullTeamDisplay(d.away_team) ??
      resolveFullTeamDisplay(d.away?.name) ??
      resolveFullTeamDisplay(ctxAny?.game?.away_team) ??
      resolveFullTeamDisplay(d.away_team_abbr ?? d.away_abbr ?? d.away?.abbr ?? ctxAny?.game?.away_team_abbr);

    const normalizedSport = normalizeInjurySport(sportHint || d.sport || ctxAny?.game?.sport, gameId);
    const suppliedPlayerLogs: PlayerGameLogRow[] = Array.isArray(ctxAny?.playerGameLogs)
      ? ctxAny.playerGameLogs
      : Array.isArray(d.player_game_logs)
        ? d.player_game_logs
        : Array.isArray(d.depth_chart)
          ? d.depth_chart
          : Array.isArray(d.starter_logs)
            ? d.starter_logs
            : keptInjuries.length > 0
              ? await fetchBatchedPlayerGameLogs(context?.env, context?.fetchFn, ctxAny?.playerLogsCache)
              : [];

    const groupStats: Array<{
      groupKey: string;
      label: string;
      name: string;
      abbr: string;
      outCount: number;
      qCount: number;
      outImpact: number;
      qImpact: number;
      namedOut: string[];
      depthOut: number;
      unloggedOut: number;
      tier1Q: string[];
      tier1OutCount: number;
      tier2OutCount: number;
      usedWeightedScoring: boolean;
      hasSufficientCoverage: boolean;
      items: any[];
    }> = [];
    const injuryLines: string[] = [];
    for (const [groupKey, { label, items }] of grouped.entries()) {
      const firstName = items[0]?.team_name || label.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const matchedEntry = matchTeamByLabel(firstName, sportHint) || matchTeamByLabel(groupKey, sportHint);
      const teamNameResolved = matchedEntry?.name || firstName;
      const teamAbbrResolved = matchedEntry?.abbr || items[0]?.team_abbr || groupKey;
      const teamPlayerIds = items
        .map((it: any) => it?.player_id ?? it?.espn_id ?? it?.athlete_id)
        .filter((v: any) => v !== undefined && v !== null && String(v).trim() !== '')
        .map((v: any) => String(v).trim());
      const teamLogIndex = buildTeamLogIndex(
        suppliedPlayerLogs,
        [teamNameResolved, teamAbbrResolved, groupKey, label],
        sportHint,
        teamPlayerIds
      );

      let outCount = 0;
      let qCount = 0;
      let outImpact = 0;
      let qImpact = 0;
      const namedOut: Array<{ name: string; weight: number }> = [];
      let depthOut = 0;
      let unloggedOut = 0;
      let tier1OutCount = 0;
      let tier2OutCount = 0;
      const tier1Q: string[] = [];
      let usedWeightedScoring = false;
      let allItemsIndividuallyWeighted = items.length > 0;

      for (const p of items) {
        const st = p.status || p.injury_status || 'OUT';
        const playerName = String(p.player_name || p.name || p.player_id || 'Unknown').trim();
        const impact = classifyPlayerInjuryImpact(p, normalizedSport, teamLogIndex);
        if (impact.usedWeightedScoring) {
          usedWeightedScoring = true;
        } else {
          allItemsIndividuallyWeighted = false;
        }
        p.impact_tier = impact.tier;
        p.impact_weight = impact.weight;
        p.impact_role = impact.roleLabel;

        if (isOutTag(st)) {
          outCount++;
          outImpact += impact.weight;
          if (impact.tier === 1) {
            tier1OutCount++;
            namedOut.push({ name: playerName, weight: impact.weight });
          } else if (impact.tier === 2) {
            tier2OutCount++;
            namedOut.push({ name: playerName, weight: impact.weight });
          } else if (impact.roleLabel === 'depth') {
            depthOut++;
          } else {
            unloggedOut++;
          }
        } else if (isQTag(st)) {
          qCount++;
          qImpact += impact.weight * 0.5;
          if (impact.tier === 1 && playerName) {
            tier1Q.push(playerName);
          }
        }
      }

      namedOut.sort((a, b) => b.weight - a.weight);

      const teamHasCoverageParity =
        teamLogIndex.hasSufficientCoverage || allItemsIndividuallyWeighted;

      groupStats.push({
        groupKey,
        label,
        name: teamNameResolved,
        abbr: teamAbbrResolved,
        outCount,
        qCount,
        outImpact: Math.round(outImpact * 10) / 10,
        qImpact: Math.round(qImpact * 10) / 10,
        namedOut: namedOut.map((n) => n.name),
        depthOut,
        unloggedOut,
        tier1OutCount,
        tier2OutCount,
        tier1Q,
        usedWeightedScoring,
        hasSufficientCoverage: teamHasCoverageParity,
        items
      });

      const sorted = items
        .map((p, idx) => ({
          p,
          idx,
          rank: statusRank(p.status || p.injury_status || 'OUT'),
          weight: typeof p.impact_weight === 'number' ? p.impact_weight : 1
        }))
        .sort((a, b) => a.rank - b.rank || b.weight - a.weight || a.idx - b.idx)
        .slice(0, 5)
        .map(({ p }) => {
          const name = p.player_name || p.name || p.player_id || 'Unknown';
          const pos = p.position || p.pos || '';
          const status = String(p.status || p.injury_status || 'OUT').toUpperCase();
          const tierTag = (p.tier_source === 'espn_depthchart' || p.tier_source === 'season_stats') && p.impact_tier === 1 && typeof p.impact_weight === 'number'
            ? ` [T1 ${p.impact_weight.toFixed(1)}]`
            : '';
          const shift = p.minute_shift ?? p.usage_shift ?? p.delta ?? '';
          const shiftStr = shift !== '' ? ` (shift: ${shift > 0 ? '+' : ''}${shift})` : '';
          return `${name}${pos ? ` (${pos})` : ''}: ${status}${tierTag}${shiftStr}`;
        });
      if (sorted.length > 0) {
        injuryLines.push(`- ${label}: ${sorted.join('; ')}`);
      }
    }

    if (!homeTeamDisplay && !awayTeamDisplay && groupStats.length >= 2) {
      homeTeamDisplay = groupStats[0].name;
      awayTeamDisplay = groupStats[1].name;
    }

    const matchesTeamDisplay = (stat: typeof groupStats[number], targetName?: string): boolean => {
      if (!targetName) return false;
      const tLower = targetName.toLowerCase();
      if (stat.name.toLowerCase() === tLower || stat.label.toLowerCase() === tLower) return true;
      const tEntry = matchTeamByLabel(targetName, sportHint);
      const sEntry = matchTeamByLabel(stat.name, sportHint) || matchTeamByLabel(stat.abbr, sportHint);
      if (tEntry && sEntry && tEntry.abbr === sEntry.abbr) return true;
      return stat.name.toLowerCase().includes(tLower) || tLower.includes(stat.name.toLowerCase());
    };

    let summaryHeaderLine: string | null = null;
    let healthSummaryObj: InjuryHealthSummaryResult | null = null;
    if (homeTeamDisplay && awayTeamDisplay) {
      let homeOut = 0;
      let homeQ = 0;
      let awayOut = 0;
      let awayQ = 0;
      let homeOutImpact = 0;
      let awayOutImpact = 0;
      let homeQImpact = 0;
      let awayQImpact = 0;
      const homeNamedOut: string[] = [];
      let homeDepthOut = 0;
      let homeUnloggedOut = 0;
      let homeTier1OutCount = 0;
      let homeTier2OutCount = 0;
      const awayNamedOut: string[] = [];
      let awayDepthOut = 0;
      let awayUnloggedOut = 0;
      let awayTier1OutCount = 0;
      let awayTier2OutCount = 0;
      const homeTier1Q: string[] = [];
      const awayTier1Q: string[] = [];
      let anyWeightedScoring = false;

      for (const st of groupStats) {
        if (st.usedWeightedScoring) anyWeightedScoring = true;
        if (matchesTeamDisplay(st, homeTeamDisplay)) {
          homeOut += st.outCount;
          homeQ += st.qCount;
          homeOutImpact += st.outImpact;
          homeQImpact += st.qImpact;
          homeNamedOut.push(...st.namedOut);
          homeDepthOut += st.depthOut;
          homeUnloggedOut += st.unloggedOut;
          homeTier1OutCount += st.tier1OutCount;
          homeTier2OutCount += st.tier2OutCount;
          homeTier1Q.push(...st.tier1Q);
        } else if (matchesTeamDisplay(st, awayTeamDisplay)) {
          awayOut += st.outCount;
          awayQ += st.qCount;
          awayOutImpact += st.outImpact;
          awayQImpact += st.qImpact;
          awayNamedOut.push(...st.namedOut);
          awayDepthOut += st.depthOut;
          awayUnloggedOut += st.unloggedOut;
          awayTier1OutCount += st.tier1OutCount;
          awayTier2OutCount += st.tier2OutCount;
          awayTier1Q.push(...st.tier1Q);
        }
      }

      // S3: Activate weighted [impact X.X] summary whenever >= 1 injured player in the game
      // has a real logged row (espn_boxscore, espn_depthchart, nhl_club_stats, or espn_season_stats).
      // Unlogged players on < 5-date teams stay at neutral 1.0 weight on BOTH sides (never 0.5 depth).
      const useWeightedParity = anyWeightedScoring;

      if (!useWeightedParity) {
        // Normalize unlogged items to neutral 1.0 weight when falling back to unweighted mode
        for (const st of groupStats) {
          for (const item of st.items) {
            if (item.impact_role === 'unlogged' || item.impact_tier === null) {
              item.impact_tier = null;
              item.impact_weight = 1.0;
            }
          }
        }
      }

      healthSummaryObj = classifyInjuryHealthBalance({
        homeTeam: homeTeamDisplay,
        awayTeam: awayTeamDisplay,
        homeOut,
        homeQ,
        awayOut,
        awayQ,
        sport: sportHint || d.sport || ctxAny?.game?.sport,
        gameId,
        ...(useWeightedParity
          ? {
              homeOutImpact,
              awayOutImpact,
              homeQImpact,
              awayQImpact,
              homeNamedOut,
              homeDepthOut,
              homeUnloggedOut,
              homeTier1OutCount,
              homeTier2OutCount,
              awayNamedOut,
              awayDepthOut,
              awayUnloggedOut,
              awayTier1OutCount,
              awayTier2OutCount,
              homeTier1Q,
              awayTier1Q,
              weightedMode: true
            }
          : { unweightedFallback: true })
      });
      summaryHeaderLine = healthSummaryObj.line;
    } else if (groupStats.length === 1) {
      const only = groupStats[0];
      const useWeightedSingle = only.usedWeightedScoring;
      const seg = formatImpactDetailSegment(
        only.outCount,
        only.outImpact,
        only.namedOut,
        only.depthOut,
        useWeightedSingle,
        only.unloggedOut,
        only.tier1OutCount,
        only.tier2OutCount
      );
      const fallbackSuffix = useWeightedSingle ? '' : ' [unweighted_fallback]';
      summaryHeaderLine = `Summary: ${only.name} (${seg}, ${only.qCount} Q) | Health Balance: single_team_only${fallbackSuffix}`;
    }

    const stripSourceRef = (val: any): any => {
      if (Array.isArray(val)) return val.map(stripSourceRef);
      if (val && typeof val === 'object') {
        const { source_ref: _sr, ...rest } = val;
        return rest;
      }
      return val;
    };
    const strippedKept = stripSourceRef(keptInjuries);
    const cleanedData = Array.isArray(d)
      ? strippedKept
      : {
          ...d,
          total_injuries: strippedKept.length,
          raw_total_injuries: rawTotalInjuries,
          ...(healthSummaryObj
            ? {
                health_balance: healthSummaryObj.label,
                injury_counts: {
                  home_team: healthSummaryObj.homeTeam,
                  home_out: healthSummaryObj.homeOut,
                  home_q: healthSummaryObj.homeQ,
                  away_team: healthSummaryObj.awayTeam,
                  away_out: healthSummaryObj.awayOut,
                  away_q: healthSummaryObj.awayQ,
                  ...(healthSummaryObj.homeOutImpact !== undefined ? { home_out_impact: healthSummaryObj.homeOutImpact } : {}),
                  ...(healthSummaryObj.awayOutImpact !== undefined ? { away_out_impact: healthSummaryObj.awayOutImpact } : {}),
                  ...(healthSummaryObj.homeQImpact !== undefined ? { home_q_impact: healthSummaryObj.homeQImpact } : {}),
                  ...(healthSummaryObj.awayQImpact !== undefined ? { away_q_impact: healthSummaryObj.awayQImpact } : {}),
                  ...(healthSummaryObj.tier1QuestionablePlayers && healthSummaryObj.tier1QuestionablePlayers.length > 0
                    ? { tier1_questionable: healthSummaryObj.tier1QuestionablePlayers }
                    : {})
                }
              }
            : {}),
          ...(Array.isArray(d.injuries) ? { injuries: strippedKept } : {}),
          ...(Array.isArray(d.players) ? { players: strippedKept } : {})
        };

    const summary = [
      `[INJURY & ROSTER DELTA: ${gameId}${positionGroup ? ` | ${positionGroup}` : ''}]`,
      ...(summaryHeaderLine ? [summaryHeaderLine] : []),
      injuryLines.length > 0 ? injuryLines.join('\n') : 'No significant roster deltas or injury tags reported.'
    ].join('\n');

    return {
      success: true,
      game_id: gameId,
      position_group: positionGroup,
      data: cleanedData,
      summary
    };
  }
};

/**
 * Tool 3: get_player_prop_splits
 * Parameters: player_id: string, stat_category: string, last_n?: number, line?: number
 */
export const getPlayerPropSplitsTool: SwarmTool = {
  name: 'get_player_prop_splits',
  description: 'Pulls player prop splits, hit rate vs line, median, and game logs.',
  parameters: {
    player_id: {
      type: 'string',
      description: 'Player ID',
      required: true
    },
    stat_category: {
      type: 'string',
      description: 'Stat category (e.g. pass_yds)',
      required: true
    },
    last_n: {
      type: 'number',
      description: 'Game sample size (e.g. 5, 10)'
    },
    line: {
      type: 'number',
      description: 'Target line (e.g. 265.5)'
    }
  },
  execute: async (args: Record<string, any>, context?: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> }) => {
    if (!args || typeof args.player_id !== 'string' || !args.player_id.trim()) {
      return {
        success: false,
        error: 'invalid_player_id',
        message: 'Missing or empty player_id parameter.',
        summary: 'Error: Missing or empty player_id parameter.'
      };
    }
    if (typeof args.stat_category !== 'string' || !args.stat_category.trim()) {
      return {
        success: false,
        error: 'invalid_stat_category',
        message: 'Missing or empty stat_category parameter.',
        summary: 'Error: Missing or empty stat_category parameter.'
      };
    }
    const playerId = args.player_id.trim();
    const statCategory = args.stat_category.trim();

    if (args.last_n !== undefined && (typeof args.last_n !== 'number' || isNaN(args.last_n) || args.last_n <= 0)) {
      return {
        success: false,
        error: 'invalid_last_n',
        message: "Parameter 'last_n' must be a positive number.",
        summary: "Error: Invalid last_n parameter (must be a positive number)."
      };
    }
    if (args.line !== undefined && (typeof args.line !== 'number' || isNaN(args.line))) {
      return {
        success: false,
        error: 'invalid_line',
        message: "Parameter 'line' must be a valid number.",
        summary: "Error: Invalid line parameter (must be a number)."
      };
    }

    const rpcRes = await callSupabaseRpc(
      'get_player_prop_splits_v1',
      {
        p_player_id: playerId,
        p_stat_category: statCategory,
        ...(args.last_n !== undefined ? { p_last_n: Math.trunc(args.last_n) } : {}),
        ...(args.line !== undefined ? { p_line: args.line } : {})
      },
      { fetchFn: context?.fetchFn, env: context?.env }
    );

    if (!rpcRes.ok) {
      return {
        success: false,
        error: rpcRes.error,
        message: rpcRes.message,
        summary: `Error fetching player prop splits for ${playerId}: ${rpcRes.message}`
      };
    }

    const d = rpcRes.data || {};
    const sampleSize = typeof d.sample_size === 'number' ? d.sample_size : Number(d.sample_size) || 0;
    if (!sampleSize || sampleSize === 0) {
      return {
        success: true,
        empty: true,
        player_id: playerId,
        stat_category: statCategory,
        data: d,
        summary: `[PLAYER PROP SPLITS: ${playerId} | ${statCategory}] No game logs available (sample 0); no splits.`
      };
    }

    const hitRate = d.hit_rate_pct !== undefined && d.hit_rate_pct !== null ? `${d.hit_rate_pct}%` : 'N/A';
    const homeHitRate = d.home_hit_rate_pct !== undefined && d.home_hit_rate_pct !== null ? `${d.home_hit_rate_pct}%` : 'N/A';
    const awayHitRate = d.away_hit_rate_pct !== undefined && d.away_hit_rate_pct !== null ? `${d.away_hit_rate_pct}%` : 'N/A';
    const mean = d.mean ?? 'N/A';
    const median = d.median ?? 'N/A';
    const iqr = d.iqr ?? 'N/A';
    const lineTarget = args.line ?? d.line ?? 'N/A';
    const recentLogs = Array.isArray(d.recent_logs)
      ? d.recent_logs
          .slice(0, 5)
          .map((l: any) => (typeof l === 'object' && l !== null ? (l.val ?? 'N/A') : l))
          .join(', ')
      : 'N/A';

    const summary = [
      `[PLAYER PROP SPLITS: ${playerId} | ${statCategory}]`,
      `Sample: ${sampleSize} | Mean: ${mean} | Median: ${median} | IQR: ${iqr}`,
      `Hit Rate: ${hitRate} (Home: ${homeHitRate} | Away: ${awayHitRate}) Over ${lineTarget}`,
      `Recent: [${recentLogs}]`
    ].join('\n');

    return {
      success: true,
      player_id: playerId,
      stat_category: statCategory,
      data: d,
      summary
    };
  }
};

/**
 * P1-2: Returns true for indoor leagues (NBA, NHL, NCAAB, WNBA) where weather is irrelevant
 * and get_environment_and_weather must never be called during Critic or verification loops.
 */
export function isIndoorLeagueGame(eventId?: string, sport?: string): boolean {
  const idNorm = String(eventId || '').trim().toLowerCase();
  if (/^(?:nba|nhl|ncaab|wnba|mens-college-basketball|womens-college-basketball|college-basketball)-/.test(idNorm)) {
    return true;
  }
  if (/^(?:nfl|ncaaf|mlb|soccer|epl|mls|cfb|college-football)-/.test(idNorm)) {
    return false;
  }
  const sportNorm = String(sport || '').trim().toLowerCase();
  if (
    sportNorm === 'nba' ||
    sportNorm === 'nhl' ||
    sportNorm === 'ncaab' ||
    sportNorm === 'wnba' ||
    sportNorm === 'basketball_nba' ||
    sportNorm === 'basketball_ncaab' ||
    sportNorm === 'basketball_wnba' ||
    sportNorm === 'icehockey_nhl'
  ) {
    return true;
  }
  return false;
}

/**
 * Tool 4: get_environment_and_weather
 * Parameters: game_id: string, is_dome?: boolean
 * Short-circuits when is_dome: true (either passed as argument or returned by RPC).
 */
export const getEnvironmentAndWeatherTool: SwarmTool = {
  name: 'get_environment_and_weather',
  description: 'Pulls dome status or wind/temp/precip for a game.',
  parameters: {
    game_id: {
      type: 'string',
      description: 'Game ID',
      required: true
    },
    is_dome: {
      type: 'boolean',
      description: 'Optional dome flag to short-circuit lookup'
    }
  },
  execute: async (args: Record<string, any>, context?: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> }) => {
    if (!args || typeof args.game_id !== 'string' || !args.game_id.trim()) {
      return {
        success: false,
        error: 'invalid_game_id',
        message: 'Missing or empty game_id parameter.',
        summary: 'Error: Missing or empty game_id parameter.'
      };
    }
    const gameId = args.game_id.trim();

    if (isOptionCitationId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' is an option citation ID, not a canonical event ID.`,
        summary: `Error: Game ID '${gameId}' is an option citation ID, not a canonical event ID.`
      };
    }

    // Short-circuit: if caller already provided is_dome === true, bypass RPC network call
    if (args.is_dome === true) {
      return {
        success: true,
        game_id: gameId,
        is_dome: true,
        short_circuited: true,
        data: { is_dome: true, venue_type: 'dome' },
        summary: `[ENVIRONMENT & WEATHER: ${gameId}]\nVenue: Indoor / Dome (climate-controlled). Weather factors not applicable.`
      };
    }

    const rpcRes = await callSupabaseRpc(
      'get_environment_and_weather_v1',
      { p_game_id: gameId },
      { fetchFn: context?.fetchFn, env: context?.env }
    );

    if (!rpcRes.ok) {
      return {
        success: false,
        error: rpcRes.error,
        message: rpcRes.message,
        summary: `Error fetching weather for ${gameId}: ${rpcRes.message}`
      };
    }

    const d = rpcRes.data || {};
    if (isRpcEmptyResult(d) && !isCanonicalOrHexId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' could not be resolved to a canonical event.`,
        summary: `Error: Game ID '${gameId}' could not be resolved to canonical event.`
      };
    }

    const w = (typeof d.weather === 'object' && d.weather !== null ? d.weather : d) || {};
    const isDome = Boolean(d.indoor || d.status === 'dome_short_circuit' || d.is_dome || d.dome_closed || w.indoor || w.is_dome);

    if (isDome) {
      return {
        success: true,
        game_id: gameId,
        is_dome: true,
        short_circuited: false,
        data: d,
        summary: `[ENVIRONMENT & WEATHER: ${gameId}]\nVenue: Indoor / Dome (climate-controlled). Weather factors not applicable.`
      };
    }

    const tempF = w.temp_f ?? (w.temp_c !== undefined && w.temp_c !== null ? Math.round((Number(w.temp_c) * 9) / 5 + 32) : 'N/A');
    const tempC = w.temp_c ?? (w.temp_f !== undefined && w.temp_f !== null ? Math.round(((Number(w.temp_f) - 32) * 5) / 9) : 'N/A');
    const windMph = w.wind_mph ?? (w.wind_kph !== undefined && w.wind_kph !== null ? Math.round(Number(w.wind_kph) * 0.621371) : 'N/A');
    const windDir = w.wind_dir || w.wind_direction || '';
    const precipProb = w.precip_prob !== undefined && w.precip_prob !== null
      ? `${Math.round(Number(w.precip_prob) <= 1 ? Number(w.precip_prob) * 100 : Number(w.precip_prob))}%`
      : 'N/A';
    const condition = w.condition || 'N/A';

    const tempStr = tempF !== 'N/A' && tempC !== 'N/A'
      ? `${tempF}°F (${tempC}°C)`
      : tempF !== 'N/A'
        ? `${tempF}°F`
        : tempC !== 'N/A'
          ? `${tempC}°C`
          : 'N/A';

    const windStr = windMph !== 'N/A'
      ? `${windMph} mph${windDir ? ` ${windDir}` : ''}`
      : 'N/A';

    const summary = [
      `[ENVIRONMENT & WEATHER: ${gameId}]`,
      `Conditions: ${condition} | Temp: ${tempStr}`,
      `Wind: ${windStr} | Precip: ${precipProb}`
    ].join('\n');

    return {
      success: true,
      game_id: gameId,
      is_dome: false,
      data: d,
      summary
    };
  }
};

/**
 * Tool 5: get_market_movement
 * Parameters: game_id: string, market_type: string
 */
export const getMarketMovementTool: SwarmTool = {
  name: 'get_market_movement',
  description: 'Pulls line movement, steam, and cross-book divergence.',
  parameters: {
    game_id: {
      type: 'string',
      description: 'Game ID',
      required: true
    },
    market_type: {
      type: 'string',
      description: 'Market (spread, total, ml)',
      required: true
    }
  },
  execute: async (args: Record<string, any>, context?: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> }) => {
    if (!args || typeof args.game_id !== 'string' || !args.game_id.trim()) {
      return {
        success: false,
        error: 'invalid_game_id',
        message: 'Missing or empty game_id parameter.',
        summary: 'Error: Missing or empty game_id parameter.'
      };
    }
    const gameId = args.game_id.trim();

    if (isOptionCitationId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' is an option citation ID, not a canonical event ID.`,
        summary: `Error: Game ID '${gameId}' is an option citation ID, not a canonical event ID.`
      };
    }

    if (typeof args.market_type !== 'string' || !args.market_type.trim()) {
      return {
        success: false,
        error: 'invalid_market_type',
        message: 'Missing or empty market_type parameter.',
        summary: 'Error: Missing or empty market_type parameter.'
      };
    }
    const marketType = args.market_type.trim();

    const rpcRes = await callSupabaseRpc(
      'get_market_movement_v1',
      { p_game_id: gameId, p_market_type: marketType },
      { fetchFn: context?.fetchFn, env: context?.env }
    );

    if (!rpcRes.ok) {
      return {
        success: false,
        error: rpcRes.error,
        message: rpcRes.message,
        summary: `Error fetching market movement for ${gameId} (${marketType}): ${rpcRes.message}`
      };
    }

    const d = rpcRes.data || {};
    if (isRpcEmptyResult(d) && !isCanonicalOrHexId(gameId)) {
      return {
        success: false,
        error: 'unresolved_game_id',
        message: `Game ID '${gameId}' could not be resolved to a canonical event.`,
        summary: `Error: Game ID '${gameId}' could not be resolved to canonical event.`
      };
    }
    const lineSnapshots = Array.isArray(d.line_snapshots) ? d.line_snapshots : [];
    const sortedSnapshots = lineSnapshots.length > 0
      ? [...lineSnapshots].sort((a: any, b: any) => {
          const ta = a?.snapshot_at ? Date.parse(String(a.snapshot_at)) : NaN;
          const tb = b?.snapshot_at ? Date.parse(String(b.snapshot_at)) : NaN;
          if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
          return 0;
        })
      : [];
    const firstSnap = sortedSnapshots[0] || {};
    const lastSnap = sortedSnapshots[sortedSnapshots.length - 1] || {};

    const opening = typeof d.opening === 'object' && d.opening !== null ? d.opening : {};
    const latest = typeof d.latest === 'object' && d.latest !== null ? d.latest : {};

    const hasVal = (v: unknown): boolean => v !== null && v !== undefined && v !== '';
    const pickFirst = (...vals: unknown[]) => vals.find(hasVal);

    const normMarket = marketType.toLowerCase();
    const isMlRequested = normMarket === 'ml' || normMarket === 'moneyline' || normMarket === 'h2h';
    const isTotalRequested = normMarket === 'total' || normMarket === 'totals';
    const isSpreadRequested = normMarket === 'spread' || normMarket === 'spreads';

    const explicitOpenSpreadHome = pickFirst(opening.spread_home, d.opening_spread_home);
    const explicitCurrSpreadHome = pickFirst(latest.spread_home, d.current_spread_home);
    const openSpreadAway = pickFirst(opening.spread_away, d.opening_spread_away, firstSnap.spread_away);
    const currSpreadAway = pickFirst(latest.spread_away, d.current_spread_away, lastSnap.spread_away);
    const bareOpenSpread = pickFirst(opening.spread, d.opening_spread, firstSnap.spread);
    const bareCurrSpread = pickFirst(latest.spread, d.current_spread, lastSnap.spread);
    const openSpreadHome = pickFirst(explicitOpenSpreadHome, firstSnap.spread_home, bareOpenSpread);
    const currSpreadHome = pickFirst(explicitCurrSpreadHome, lastSnap.spread_home, bareCurrSpread);

    const openTotal = pickFirst(opening.total, d.opening_total, firstSnap.total);
    const currTotal = pickFirst(latest.total, d.current_total, lastSnap.total);

    const openMlHome = pickFirst(
      opening.ml_home,
      d.opening_ml_home,
      firstSnap.ml_home,
      sortedSnapshots.find((s: any) => hasVal(s?.ml_home))?.ml_home,
      d.ml_home
    );
    const currMlHome = pickFirst(
      latest.ml_home,
      d.current_ml_home,
      lastSnap.ml_home,
      [...sortedSnapshots].reverse().find((s: any) => hasVal(s?.ml_home))?.ml_home,
      d.ml_home
    );
    const openMlAway = pickFirst(
      opening.ml_away,
      d.opening_ml_away,
      firstSnap.ml_away,
      sortedSnapshots.find((s: any) => hasVal(s?.ml_away))?.ml_away,
      d.ml_away
    );
    const currMlAway = pickFirst(
      latest.ml_away,
      d.current_ml_away,
      lastSnap.ml_away,
      [...sortedSnapshots].reverse().find((s: any) => hasVal(s?.ml_away))?.ml_away,
      d.ml_away
    );

    const hasAnyOddsData = hasVal(openSpreadHome) || hasVal(currSpreadHome) || hasVal(openSpreadAway) || hasVal(currSpreadAway)
      || hasVal(openTotal) || hasVal(currTotal)
      || hasVal(openMlHome) || hasVal(currMlHome) || hasVal(openMlAway) || hasVal(currMlAway)
      || hasVal(opening.line) || hasVal(latest.line) || hasVal(d.open_line) || hasVal(d.current_line);

    const rawTracked = typeof d.snapshots_tracked === 'number'
      ? d.snapshots_tracked
      : (d.snapshots_tracked !== undefined && d.snapshots_tracked !== null ? Number(d.snapshots_tracked) : NaN);
    const snapshotsTracked = Number.isFinite(rawTracked)
      ? (rawTracked > 0 ? rawTracked : (lineSnapshots.length > 0 ? lineSnapshots.length : 0))
      : (lineSnapshots.length || (hasAnyOddsData ? 1 : 0));

    if (!snapshotsTracked || snapshotsTracked === 0) {
      return {
        success: true,
        empty: true,
        game_id: gameId,
        market_type: marketType,
        markets_covered: [],
        data: d,
        summary: `[MARKET MOVEMENT: ${gameId} | ${marketType}] no FanDuel snapshots tracked (0 snapshots).`
      };
    }

    const marketsCovered: string[] = [];
    if (hasVal(openSpreadHome) || hasVal(currSpreadHome) || hasVal(openSpreadAway) || hasVal(currSpreadAway)) {
      marketsCovered.push('spread');
    }
    if (hasVal(openTotal) || hasVal(currTotal)) marketsCovered.push('total');
    if (hasVal(openMlHome) || hasVal(currMlHome) || hasVal(openMlAway) || hasVal(currMlAway)) marketsCovered.push('ml');

    const homeLabel = d.home_team ?? (context as any)?.game?.home_team ?? d.home_team_abbr ?? (context as any)?.game?.home_team_abbr ?? 'HOME';
    const awayLabel = d.away_team ?? (context as any)?.game?.away_team ?? d.away_team_abbr ?? (context as any)?.game?.away_team_abbr ?? 'AWAY';
    const fmtSigned = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
    const fmtOddsOrLine = (v: unknown): string => {
      if (!hasVal(v)) return 'N/A';
      if (typeof v === 'number' && Number.isFinite(v)) return fmtSigned(v);
      const parsed = Number(v);
      if (Number.isFinite(parsed) && String(v).trim() !== '') return fmtSigned(parsed);
      return String(v);
    };
    const formatMlPair = (homeVal: unknown, awayVal: unknown): string => {
      const parts: string[] = [];
      if (hasVal(homeVal)) parts.push(`ml_home ${homeLabel} ${fmtOddsOrLine(homeVal)}`);
      if (hasVal(awayVal)) parts.push(`ml_away ${awayLabel} ${fmtOddsOrLine(awayVal)}`);
      return parts.length > 0 ? parts.join(' / ') : 'N/A';
    };

    const steamDirHint = String(d.steam_direction || d.steam_dir || '').toLowerCase();

    // Infer whether a bare `spread` number belongs to Home or Away using slate rows, spread_team, or ML favorite/underdog
    const gameOptions: Array<{ id?: string; text?: string }> = Array.isArray((context as any)?.game?.options)
      ? (context as any).game.options
      : [];
    const awayCandidates = Array.from(
      new Set(
        [awayLabel, (context as any)?.game?.away_team, (context as any)?.game?.away_team_abbr]
          .filter((x): x is string => typeof x === 'string' && x.trim().length >= 2 && !/^away$/i.test(x.trim()))
          .map(s => s.trim())
      )
    );
    const homeCandidates = Array.from(
      new Set(
        [homeLabel, (context as any)?.game?.home_team, (context as any)?.game?.home_team_abbr]
          .filter((x): x is string => typeof x === 'string' && x.trim().length >= 2 && !/^home$/i.test(x.trim()))
          .map(s => s.trim())
      )
    );

    const inferSlateHomeSpread = (): number | null => {
      if (gameOptions.length === 0) return null;
      const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const gameSport = (context as any)?.game?.sport;
      const awayEntries = awayCandidates.map(c => matchTeamByLabel(c, gameSport)).filter((e): e is NonNullable<typeof e> => Boolean(e));
      const homeEntries = homeCandidates.map(c => matchTeamByLabel(c, gameSport)).filter((e): e is NonNullable<typeof e> => Boolean(e));
      const sharedCity = awayEntries.some(a => homeEntries.some(h => a.city && h.city && a.city.toLowerCase() === h.city.toLowerCase()));
      const stopAliases = new Set(['la', 'ny', 'sa', 'sd', 'sf', 'gb', 'kc', 'lv', 'ne', 'tb', 'no', 'as', 'in', 'or', 'at', 'by', 'to', 'on', 'of']);

      const collectTeamMatchers = (cands: string[], entries: typeof awayEntries): { words: string[]; abbrs: string[] } => {
        const words = new Set<string>();
        const abbrs = new Set<string>();
        for (const c of cands) {
          if (/^[A-Z]{2,4}$/.test(c.trim())) abbrs.add(c.trim());
          for (const w of c.toLowerCase().split(/\s+/)) {
            if (w.length >= 3) words.add(w);
          }
        }
        for (const e of entries) {
          words.add(e.name.toLowerCase());
          if (e.nickname) words.add(e.nickname.toLowerCase());
          if (e.abbr && e.abbr.length >= 2) abbrs.add(e.abbr.toUpperCase());
          if (e.city && !sharedCity) words.add(e.city.toLowerCase());
          for (const a of e.aliases || []) {
            const al = a.toLowerCase().trim();
            if (!al || al.length < 3 || stopAliases.has(al)) continue;
            if (sharedCity && e.city && al === e.city.toLowerCase()) continue;
            words.add(al);
          }
        }
        return { words: Array.from(words), abbrs: Array.from(abbrs) };
      };

      const awayMatchers = collectTeamMatchers(awayCandidates, awayEntries);
      const homeMatchers = collectTeamMatchers(homeCandidates, homeEntries);

      let rowHome: number | null = null;
      let rowAway: number | null = null;
      for (const opt of gameOptions) {
        const txt = String(opt?.text || '');
        if (!txt || /\b(?:ml|moneyline|over|under)\b/i.test(txt)) continue;
        const cleaned = txt.replace(/\([+-]\d{3,4}\)/g, ' ');
        const m = cleaned.match(/([+-]\d+(?:\.\d+)?)\b/);
        if (!m) continue;
        const val = parseFloat(m[1]);
        if (!Number.isFinite(val) || Math.abs(val) >= 100) continue;
        const lower = cleaned.toLowerCase();
        const matchesHome =
          homeMatchers.words.some(tok => new RegExp(`\\b${escapeRx(tok)}\\b`, 'i').test(lower)) ||
          homeMatchers.abbrs.some(ab => new RegExp(`\\b${escapeRx(ab)}\\b`).test(cleaned));
        const matchesAway =
          awayMatchers.words.some(tok => new RegExp(`\\b${escapeRx(tok)}\\b`, 'i').test(lower)) ||
          awayMatchers.abbrs.some(ab => new RegExp(`\\b${escapeRx(ab)}\\b`).test(cleaned));
        if (matchesHome && !matchesAway) rowHome = val;
        else if (matchesAway && !matchesHome) rowAway = val;
      }
      if (rowHome !== null) return rowHome;
      if (rowAway !== null) return rowAway === 0 ? 0 : -rowAway;
      return null;
    };
    const slateHomeSpread = inferSlateHomeSpread();

    const toNum = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const bareOpenNum = toNum(bareOpenSpread ?? opening.line ?? d.open_line);
    const bareCurrNum = toNum(bareCurrSpread ?? latest.line ?? d.current_line);
    const bareSpreadDelta = toNum(d.line_delta) ?? (
      bareOpenNum !== null && bareCurrNum !== null
        ? Number((bareCurrNum - bareOpenNum).toFixed(2))
        : null
    );

    const resolveSpreadPair = (
      explicitHome: unknown,
      explicitAway: unknown,
      bareSpread: unknown,
      mlHomeVal: unknown,
      mlAwayVal: unknown
    ): { home: number; away: number } | { raw: number } | null => {
      const eHome = toNum(explicitHome);
      const eAway = toNum(explicitAway);
      if (eHome !== null || eAway !== null) {
        const h = eHome !== null ? eHome : (eAway! === 0 ? 0 : -eAway!);
        const a = eAway !== null ? eAway : (h === 0 ? 0 : -h);
        return { home: h, away: a };
      }

      const bare = toNum(bareSpread);
      if (bare === null) return null;

      // 1. Check slate row options: if slate matches bare or -bare explicitly, honor slate sign
      if (slateHomeSpread !== null && bare !== 0) {
        if (Math.abs(slateHomeSpread - bare) <= 3 && Math.sign(slateHomeSpread) === Math.sign(bare)) {
          return { home: bare, away: -bare };
        }
        if (Math.abs(-slateHomeSpread - bare) <= 3 && Math.sign(-slateHomeSpread) === Math.sign(bare)) {
          return { home: -bare, away: bare };
        }
      }

      // 2. Check explicit spread_team hint
      const spreadTeamRaw = String(d.spread_team ?? latest.spread_team ?? opening.spread_team ?? '').toLowerCase().trim();
      if (spreadTeamRaw) {
        const matchesAway = awayCandidates.some(c => {
          const cl = c.toLowerCase();
          return spreadTeamRaw.includes(cl) || cl.includes(spreadTeamRaw);
        });
        const matchesHome = homeCandidates.some(c => {
          const cl = c.toLowerCase();
          return spreadTeamRaw.includes(cl) || cl.includes(spreadTeamRaw);
        });
        if (matchesAway && !matchesHome) {
          return { home: bare === 0 ? 0 : -bare, away: bare };
        }
        if (matchesHome && !matchesAway) {
          return { home: bare, away: bare === 0 ? 0 : -bare };
        }
      }

      // 3. Check moneyline favorite/underdog consistency BEFORE steam_direction:
      //    negative spread = favorite, positive spread = underdog
      const mlH = toNum(mlHomeVal);
      const mlA = toNum(mlAwayVal);
      if (bare !== 0) {
        if (mlH !== null && mlA !== null && mlH !== mlA) {
          const homeIsFav = mlH < mlA;
          const bareIsUnderdogLine = bare > 0;
          // Home favored & bare positive => bare belongs to away underdog; Home dog & bare negative => bare belongs to away fav
          if ((homeIsFav && bareIsUnderdogLine) || (!homeIsFav && !bareIsUnderdogLine)) {
            return { home: -bare, away: bare };
          }
          return { home: bare, away: -bare };
        }
        if (mlH !== null) {
          if (mlH <= -115) {
            return bare > 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
          }
          if (mlH >= 115) {
            return bare < 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
          }
        }
        if (mlA !== null) {
          if (mlA <= -115) {
            return bare < 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
          }
          if (mlA >= 115) {
            return bare > 0 ? { home: -bare, away: bare } : { home: bare, away: -bare };
          }
        }
      }

      // 4. Steam direction + movement sign fallback: infer column perspective only when movement delta confirms it
      if (bareSpreadDelta !== null && bareSpreadDelta !== 0 && (steamDirHint.includes('home') || steamDirHint.includes('away'))) {
        const isHomePerspective =
          (steamDirHint.includes('home') && bareSpreadDelta < 0) ||
          (steamDirHint.includes('away') && bareSpreadDelta > 0);
        if (isHomePerspective) {
          return { home: bare, away: bare === 0 ? 0 : -bare };
        }
        return { home: bare === 0 ? 0 : -bare, away: bare };
      }

      // 5. Unattributed bare spread with no explicit home/away row/ML signal: emit raw spread without flipping
      return { raw: bare };
    };

    let openLine: unknown;
    let currLine: unknown;
    let isSpreadPrimary = false;

    if (isMlRequested) {
      openLine = hasVal(openMlHome) || hasVal(openMlAway) ? formatMlPair(openMlHome, openMlAway) : (opening.line ?? d.open_line ?? 'N/A');
      currLine = hasVal(currMlHome) || hasVal(currMlAway) ? formatMlPair(currMlHome, currMlAway) : (latest.line ?? d.current_line ?? 'N/A');
    } else if (isTotalRequested) {
      openLine = openTotal ?? opening.line ?? d.open_line ?? 'N/A';
      currLine = currTotal ?? latest.line ?? d.current_line ?? 'N/A';
    } else if (isSpreadRequested || hasVal(openSpreadHome) || hasVal(currSpreadHome) || hasVal(openSpreadAway) || hasVal(currSpreadAway)) {
      isSpreadPrimary = isSpreadRequested || hasVal(openSpreadHome) || hasVal(currSpreadHome) || hasVal(openSpreadAway) || hasVal(currSpreadAway);
      openLine = openSpreadHome ?? opening.line ?? d.open_line ?? 'N/A';
      currLine = currSpreadHome ?? latest.line ?? d.current_line ?? 'N/A';
    } else if (hasVal(openTotal) || hasVal(currTotal)) {
      openLine = openTotal ?? 'N/A';
      currLine = currTotal ?? 'N/A';
    } else if (hasVal(openMlHome) || hasVal(currMlHome) || hasVal(openMlAway) || hasVal(currMlAway)) {
      openLine = formatMlPair(openMlHome, openMlAway);
      currLine = formatMlPair(currMlHome, currMlAway);
    } else {
      openLine = opening.line ?? d.open_line ?? 'N/A';
      currLine = latest.line ?? d.current_line ?? 'N/A';
    }

    const rawOpenPrice = isSpreadPrimary
      ? pickFirst(opening.price, d.open_price, d.opening_price, opening.spread_home_price, firstSnap.spread_home_price)
      : isTotalRequested
        ? pickFirst(opening.price, d.open_price, d.opening_price, opening.total_over_price, firstSnap.total_over_price)
        : pickFirst(opening.price, d.open_price, d.opening_price);
    const rawCurrPrice = isSpreadPrimary
      ? pickFirst(latest.price, d.current_price, latest.spread_home_price, lastSnap.spread_home_price)
      : isTotalRequested
        ? pickFirst(latest.price, d.current_price, latest.total_over_price, lastSnap.total_over_price)
        : pickFirst(latest.price, d.current_price);
    const openPrice = rawOpenPrice ?? 'N/A';
    const currPrice = rawCurrPrice ?? 'N/A';
    const formatPriceSuffix = (val: unknown): string => {
      if (!hasVal(val)) return '';
      const str = String(val).trim();
      if (/^n\/a$/i.test(str)) return '';
      return ` (${fmtOddsOrLine(val)})`;
    };
    const openPriceSuffix = formatPriceSuffix(rawOpenPrice);
    const currPriceSuffix = formatPriceSuffix(rawCurrPrice);

    const openResolved = isSpreadPrimary
      ? resolveSpreadPair(explicitOpenSpreadHome ?? firstSnap.spread_home, openSpreadAway, bareOpenSpread ?? opening.line ?? d.open_line, openMlHome ?? currMlHome, openMlAway ?? currMlAway)
      : null;
    const currResolved = isSpreadPrimary
      ? resolveSpreadPair(explicitCurrSpreadHome ?? lastSnap.spread_home, currSpreadAway, bareCurrSpread ?? latest.line ?? d.current_line, currMlHome ?? openMlHome, currMlAway ?? openMlAway)
      : null;

    const formatResolvedLine = (resolved: { home: number; away: number } | { raw: number } | null, fallbackVal: unknown): string => {
      if (isSpreadPrimary && resolved) {
        if ('raw' in resolved) {
          const teamPrefix = homeLabel !== 'HOME' && awayLabel !== 'AWAY'
            ? `${awayLabel} @ ${homeLabel} `
            : '';
          return `${teamPrefix}spread ${fmtSigned(resolved.raw)}`;
        }
        return `home ${homeLabel} ${fmtSigned(resolved.home)} / away ${awayLabel} ${fmtSigned(resolved.away)}`;
      }
      return String(fallbackVal);
    };

    const openDisplay = formatResolvedLine(openResolved, openLine);
    const currDisplay = formatResolvedLine(currResolved, currLine);

    // When requesting 'all' (or when multiple markets exist alongside spread/total), emit Total and ML explicitly
    const extraMarketParts: string[] = [];
    if (!isSpreadRequested && !isTotalRequested && !isMlRequested) {
      if (isSpreadPrimary && (hasVal(openTotal) || hasVal(currTotal))) {
        const totalStr = hasVal(openTotal) && hasVal(currTotal) && openTotal !== currTotal
          ? `${openTotal} -> ${currTotal}`
          : String(currTotal ?? openTotal);
        extraMarketParts.push(`Total: ${totalStr}`);
      }
      if ((hasVal(currMlHome) || hasVal(openMlHome) || hasVal(currMlAway) || hasVal(openMlAway)) && !(openDisplay.includes('ml_home') || currDisplay.includes('ml_home'))) {
        const currMlStr = formatMlPair(currMlHome ?? openMlHome, currMlAway ?? openMlAway);
        const openMlStr = (hasVal(openMlHome) || hasVal(openMlAway)) ? formatMlPair(openMlHome, openMlAway) : '';
        const mlStr = openMlStr && currMlStr !== openMlStr
          ? `${currMlStr} (open ${openMlStr})`
          : currMlStr;
        extraMarketParts.push(`ML: ${mlStr}`);
      }
    }

    if (snapshotsTracked === 1 || snapshotsTracked < 2) {
      const lineDisplay = currLine !== 'N/A' || currPrice !== 'N/A'
        ? `Current: ${currDisplay}${currPriceSuffix}`
        : `Line: ${openDisplay}${openPriceSuffix}`;
      const summaryLines = [
        `[MARKET MOVEMENT: ${gameId} | ${marketType}] 1 snapshot, no history.`,
        lineDisplay
      ];
      if (extraMarketParts.length > 0) {
        summaryLines.push(extraMarketParts.join(' | '));
      }

      return {
        success: true,
        game_id: gameId,
        market_type: marketType,
        markets_covered: marketsCovered,
        data: d,
        summary: summaryLines.join('\n')
      };
    }

    const delta = d.line_delta ?? (
      openResolved && currResolved && 'home' in openResolved && 'home' in currResolved
        ? Number((currResolved.home - openResolved.home).toFixed(2))
        : (typeof openLine === 'number' && typeof currLine === 'number'
            ? Number((currLine - openLine).toFixed(2))
            : 'N/A')
    );

    const inferSportKey = (): string => {
      const raw = String(d.sport ?? (context as any)?.game?.sport ?? gameId ?? '').toLowerCase();
      if (raw.includes('ncaaf') || raw.startsWith('college-football')) return 'americanfootball_ncaaf';
      if (raw.includes('ncaab') || raw.startsWith('mens-college-basketball') || raw.startsWith('college-basketball')) return 'basketball_ncaab';
      if (raw.includes('nfl') || raw.startsWith('nfl-')) return 'americanfootball_nfl';
      if (raw.includes('nba') || raw.startsWith('nba-')) return 'basketball_nba';
      if (raw.includes('nhl') || raw.startsWith('nhl-') || raw.includes('hockey')) return 'icehockey_nhl';
      if (raw.includes('mlb') || raw.startsWith('mlb-') || raw.includes('baseball')) return 'baseball_mlb';
      return 'unknown';
    };
    const sportKey = inferSportKey();
    // P0-3: NBA/NFL spread steam threshold is 1.0 pt (or >= 0.5 key-number move in NFL/NHL/MLB).
    const spreadThreshold = (
      sportKey === 'basketball_nba' ||
      sportKey === 'americanfootball_nfl' ||
      sportKey === 'icehockey_nhl' ||
      sportKey === 'baseball_mlb'
    )
      ? 1.0
      : 1.5;
    const totalThreshold = (sportKey === 'icehockey_nhl' || sportKey === 'baseball_mlb') ? 0.5 : 1.0;

    const americanToImpliedProb = (odds: number): number | null => {
      if (!Number.isFinite(odds) || odds === 0) return null;
      if (odds <= -100) return Math.abs(odds) / (Math.abs(odds) + 100);
      if (odds >= 100) return 100 / (odds + 100);
      return null;
    };
    const toCentScale = (ml: number): number => (ml < 0 ? ml + 100 : ml - 100);

    const spreadDeltaHome =
      openResolved && currResolved && 'home' in openResolved && 'home' in currResolved
        ? Number((currResolved.home - openResolved.home).toFixed(2))
        : (typeof delta === 'number' && isSpreadPrimary ? delta : null);

    const openTotalNum = toNum(openTotal);
    const currTotalNum = toNum(currTotal);
    const totalDeltaVal = openTotalNum !== null && currTotalNum !== null
      ? Number((currTotalNum - openTotalNum).toFixed(2))
      : null;

    const openMlHomeNum = toNum(openMlHome);
    const currMlHomeNum = toNum(currMlHome);
    const openMlAwayNum = toNum(openMlAway);
    const currMlAwayNum = toNum(currMlAway);

    const crossesNflKeyNumber = (): boolean => {
      if (sportKey !== 'americanfootball_nfl' || !openResolved || !currResolved || !('home' in openResolved) || !('home' in currResolved)) {
        return false;
      }
      const a = Math.abs(openResolved.home);
      const b = Math.abs(currResolved.home);
      if (Math.abs(a - b) < 0.5) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return (lo <= 3 && hi >= 3 && (a === 3 || b === 3 || (lo < 3 && hi > 3))) ||
        (lo <= 7 && hi >= 7 && (a === 7 || b === 7 || (lo < 7 && hi > 7)));
    };

    const detectSpreadSteam = (): string | null => {
      if (spreadDeltaHome === null) return null;
      const absMove = Math.abs(spreadDeltaHome);
      const qualifies = absMove >= spreadThreshold || (absMove >= 0.5 && (crossesNflKeyNumber() || sportKey === 'icehockey_nhl' || sportKey === 'baseball_mlb'));
      if (!qualifies) return null;
      const pts = absMove.toFixed(1);
      const ptUnit = pts === '1.0' ? 'pt' : 'pts';
      if (openResolved && currResolved && 'home' in openResolved && 'home' in currResolved) {
        const homeRange = `${fmtSigned(openResolved.home)} -> ${fmtSigned(currResolved.home)}`;
        const awayRange = `${fmtSigned(openResolved.away)} -> ${fmtSigned(currResolved.away)}`;
        if (spreadDeltaHome < 0) {
          return `TOWARD home ${homeLabel} (${homeRange}, ${pts} ${ptUnit}) | AGAINST away ${awayLabel} (${awayRange})`;
        }
        return `TOWARD away ${awayLabel} (${awayRange}, ${pts} ${ptUnit}) | AGAINST home ${homeLabel} (${homeRange})`;
      }
      if (spreadDeltaHome < 0) {
        return `TOWARD home ${homeLabel} (${pts} ${ptUnit}) | AGAINST away ${awayLabel}`;
      }
      return `TOWARD away ${awayLabel} (${pts} ${ptUnit}) | AGAINST home ${homeLabel}`;
    };

    const detectMlSteam = (): { text: string; impShiftAbs: number } | null => {
      const useHome = openMlHomeNum !== null && currMlHomeNum !== null && openMlHomeNum !== currMlHomeNum;
      const useAway = openMlAwayNum !== null && currMlAwayNum !== null && openMlAwayNum !== currMlAwayNum;
      if (!useHome && !useAway) return null;

      let homeImpShiftPct = 0;
      let awayImpShiftPct = 0;
      let inMidBand = false;
      let centShift = 0;
      if (useHome && openMlHomeNum !== null && currMlHomeNum !== null) {
        const pOpen = americanToImpliedProb(openMlHomeNum);
        const pCurr = americanToImpliedProb(currMlHomeNum);
        if (pOpen !== null && pCurr !== null) {
          homeImpShiftPct = (pCurr - pOpen) * 100;
        }
        inMidBand = Math.abs(openMlHomeNum) <= 150 && Math.abs(currMlHomeNum) <= 150;
        centShift = Math.max(centShift, Math.abs(toCentScale(currMlHomeNum) - toCentScale(openMlHomeNum)));
      }
      if (useAway && openMlAwayNum !== null && currMlAwayNum !== null) {
        const pOpen = americanToImpliedProb(openMlAwayNum);
        const pCurr = americanToImpliedProb(currMlAwayNum);
        if (pOpen !== null && pCurr !== null) {
          awayImpShiftPct = (pCurr - pOpen) * 100;
        }
        inMidBand = inMidBand || (Math.abs(openMlAwayNum) <= 150 && Math.abs(currMlAwayNum) <= 150);
        centShift = Math.max(centShift, Math.abs(toCentScale(currMlAwayNum) - toCentScale(openMlAwayNum)));
      }

      const impShiftPct =
        useHome && (!useAway || Math.abs(homeImpShiftPct) >= Math.abs(awayImpShiftPct))
          ? homeImpShiftPct
          : -awayImpShiftPct;
      const impShiftAbs = Math.abs(impShiftPct);

      if (impShiftAbs < 2.5 && !(inMidBand && centShift >= 15)) {
        return null;
      }
      const impAbs = impShiftAbs.toFixed(1);
      const isHomeFavoredMove =
        impShiftPct > 0 ||
        (useHome && !useAway && openMlHomeNum !== null && currMlHomeNum !== null && toCentScale(currMlHomeNum) < toCentScale(openMlHomeNum));
      if (isHomeFavoredMove) {
        const toward = openMlHomeNum !== null && currMlHomeNum !== null
          ? `TOWARD home ${homeLabel} ML (${fmtOddsOrLine(openMlHomeNum)} -> ${fmtOddsOrLine(currMlHomeNum)}, +${impAbs}pp implied)`
          : `TOWARD home ${homeLabel} ML (+${impAbs}pp implied)`;
        const against = openMlAwayNum !== null && currMlAwayNum !== null
          ? `AGAINST away ${awayLabel} ML (${fmtOddsOrLine(openMlAwayNum)} -> ${fmtOddsOrLine(currMlAwayNum)})`
          : `AGAINST away ${awayLabel} ML`;
        return { text: `${toward} | ${against}`, impShiftAbs };
      }
      const toward = openMlAwayNum !== null && currMlAwayNum !== null
        ? `TOWARD away ${awayLabel} ML (${fmtOddsOrLine(openMlAwayNum)} -> ${fmtOddsOrLine(currMlAwayNum)}, +${impAbs}pp implied)`
        : openMlHomeNum !== null && currMlHomeNum !== null
          ? `TOWARD away ${awayLabel} ML (home ${fmtOddsOrLine(openMlHomeNum)} -> ${fmtOddsOrLine(currMlHomeNum)}, +${impAbs}pp implied)`
          : `TOWARD away ${awayLabel} ML (+${impAbs}pp implied)`;
      const against = openMlHomeNum !== null && currMlHomeNum !== null
        ? `AGAINST home ${homeLabel} ML (${fmtOddsOrLine(openMlHomeNum)} -> ${fmtOddsOrLine(currMlHomeNum)})`
        : `AGAINST home ${homeLabel} ML`;
      return { text: `${toward} | ${against}`, impShiftAbs };
    };

    const detectTotalSteam = (): string | null => {
      if (totalDeltaVal === null || Math.abs(totalDeltaVal) < totalThreshold) return null;
      const side = totalDeltaVal > 0 ? 'Over' : 'Under';
      const signed = totalDeltaVal > 0 ? `+${totalDeltaVal.toFixed(1)}` : totalDeltaVal.toFixed(1);
      return `TOWARD ${side} (${openTotalNum} -> ${currTotalNum}, ${signed} pts)`;
    };

    const spreadSteamText = detectSpreadSteam();
    const mlSteamObj = detectMlSteam();
    const totalSteamText = detectTotalSteam();

    // P0-3: Compute side steam (spread or ML) and total steam independently.
    // Whenever BOTH move, emit both on the Steam: line instead of letting one hide the other.
    let sideSteamText: string | null = null;
    let sideSteamKind: 'spread' | 'ml' | null = null;
    if (isMlRequested) {
      if (mlSteamObj) { sideSteamText = mlSteamObj.text; sideSteamKind = 'ml'; }
      else if (spreadSteamText) { sideSteamText = spreadSteamText; sideSteamKind = 'spread'; }
    } else {
      if (spreadSteamText) { sideSteamText = spreadSteamText; sideSteamKind = 'spread'; }
      else if (mlSteamObj) { sideSteamText = mlSteamObj.text; sideSteamKind = 'ml'; }
    }

    let orderedSteam: string | null = null;
    let activeSteamKind: 'spread' | 'ml' | 'total' | null = null;
    if (sideSteamText && totalSteamText) {
      orderedSteam = isTotalRequested
        ? `Total ${totalSteamText} | Side ${sideSteamText}`
        : `Side ${sideSteamText} | Total ${totalSteamText}`;
      activeSteamKind = sideSteamKind;
    } else if (sideSteamText) {
      orderedSteam = sideSteamText;
      activeSteamKind = sideSteamKind;
    } else if (totalSteamText) {
      orderedSteam = totalSteamText;
      activeSteamKind = 'total';
    }

    const explicitNonNeutralSteam =
      typeof (d.steam_direction || d.steam_dir) === 'string' &&
      String(d.steam_direction || d.steam_dir).trim() !== '' &&
      !/^neutral$/i.test(String(d.steam_direction || d.steam_dir).trim())
        ? String(d.steam_direction || d.steam_dir).trim()
        : null;

    const steamMag = d.steam_magnitude ?? (typeof delta === 'number' ? Math.abs(delta) : 'N/A');
    const steamDisplay = orderedSteam
      ? orderedSteam
      : explicitNonNeutralSteam
        ? `${explicitNonNeutralSteam}${typeof steamMag === 'number' ? ` (${steamMag} pts)` : ''}`
        : `neutral${typeof steamMag === 'number' ? ` (${steamMag} pts)` : ''}`;

    const distinctBooksFromSnaps = new Set(
      lineSnapshots
        .map((s: any) => String(s?.book ?? '').trim().toLowerCase())
        .filter(Boolean)
    );
    const booksTrackedRaw = toNum(d.books_tracked ?? d.distinct_books);
    const booksTracked = booksTrackedRaw !== null
      ? booksTrackedRaw
      : (distinctBooksFromSnaps.size > 0 ? distinctBooksFromSnaps.size : 1);
    const rawBook = String(d.book ?? '').trim().toLowerCase();
    const explicitDivergence =
      typeof (d.cross_book_divergence || d.divergence) === 'string' &&
      String(d.cross_book_divergence || d.divergence).trim() !== '' &&
      !/^none$/i.test(String(d.cross_book_divergence || d.divergence).trim())
        ? String(d.cross_book_divergence || d.divergence).trim()
        : null;
    const isSingleBook =
      booksTracked < 2 ||
      (rawBook === 'fanduel' && distinctBooksFromSnaps.size < 2);
    const divergence = explicitDivergence ?? (isSingleBook ? 'single_book' : 'none');

    const isNbaOrNfl =
      sportKey === 'basketball_nba' ||
      sportKey === 'americanfootball_nfl' ||
      /^(?:nba|nfl)-/i.test(gameId);
    const isExtendedSingleBookSpread =
      isSingleBook &&
      activeSteamKind === 'spread' &&
      isNbaOrNfl &&
      spreadDeltaHome !== null &&
      Math.abs(spreadDeltaHome) >= 2.0;
    const isExtendedSingleBookMl =
      isSingleBook &&
      activeSteamKind === 'ml' &&
      mlSteamObj !== null &&
      mlSteamObj.impShiftAbs >= 5.0;
    const extendedMoveTag =
      isExtendedSingleBookSpread || isExtendedSingleBookMl
        ? ' [extended_move: verify remaining value]'
        : '';

    const deltaSuffix = typeof delta === 'number' ? ` | Delta: ${delta}` : '';
    const summaryLines = [
      `[MARKET MOVEMENT: ${gameId} | ${marketType}]`,
      `Open: ${openDisplay}${openPriceSuffix} -> Current: ${currDisplay}${currPriceSuffix}${deltaSuffix}`
    ];
    if (extraMarketParts.length > 0) {
      summaryLines.push(extraMarketParts.join(' | '));
    }
    summaryLines.push(`Steam: ${steamDisplay} | Divergence: ${divergence}${extendedMoveTag}`);

    return {
      success: true,
      game_id: gameId,
      market_type: marketType,
      markets_covered: marketsCovered,
      data: d,
      summary: summaryLines.join('\n')
    };
  }
};

/**
 * Tool 6: get_historical_lessons
 * Parameters: sport: string, market_type: string, tags?: string[]
 * Queries Qdrant collection or Supabase lessons table filtered by sport, market_type, and rule_type = 'routing_rule'.
 */
export const getHistoricalLessonsTool: SwarmTool = {
  name: 'get_historical_lessons',
  description: 'Pulls routing rules and blind spots for a sport/market.',
  parameters: {
    sport: {
      type: 'string',
      description: 'Sport key (e.g. "nfl", "nba")',
      required: true
    },
    market_type: {
      type: 'string',
      description: 'Market type (e.g. "spread", "total")',
      required: true
    },
    tags: {
      type: 'array',
      description: 'Optional tags'
    }
  },
  execute: async (args: Record<string, any>, context?: {
    fetchFn?: typeof fetch;
    env?: Record<string, string | undefined>;
    qdrantClient?: any;
  }) => {
    if (!args || typeof args.sport !== 'string' || !args.sport.trim()) {
      return {
        success: false,
        error: 'invalid_sport',
        message: 'Missing or empty sport parameter.',
        summary: 'Error: Missing or empty sport parameter.'
      };
    }
    if (typeof args.market_type !== 'string' || !args.market_type.trim()) {
      return {
        success: false,
        error: 'invalid_market_type',
        message: 'Missing or empty market_type parameter.',
        summary: 'Error: Missing or empty market_type parameter.'
      };
    }
    if (args.tags !== undefined && (!Array.isArray(args.tags) || !args.tags.every((t: any) => typeof t === 'string'))) {
      return {
        success: false,
        error: 'invalid_tags',
        message: "Parameter 'tags' must be an array of strings.",
        summary: "Error: Invalid tags parameter (must be an array of strings)."
      };
    }

    const sport = args.sport.trim();
    const marketType = args.market_type.trim();
    const tags = Array.isArray(args.tags) ? args.tags.map((t: string) => t.trim().toLowerCase()) : [];
    const env = context?.env || (typeof process !== 'undefined' ? process.env : {});
    const fetchFn = context?.fetchFn || globalThis.fetch;

    let lessons: Array<{ id?: string; content?: string; lesson?: string; rule?: string }> = [];
    let source: 'qdrant' | 'supabase' | 'none' = 'none';

    // 1. Attempt Qdrant search if configured
    const qdrantUrl = env.QDRANT_URL?.trim();
    if (context?.qdrantClient || qdrantUrl) {
      try {
        const client = context?.qdrantClient || new QdrantClient({
          url: qdrantUrl,
          apiKey: env.QDRANT_API_KEY?.trim() || undefined
        });

        // Filter by rule_type = 'routing_rule', sport, market_type
        const mustFilters: any[] = [
          { key: 'rule_type', match: { value: 'routing_rule' } },
          { key: 'sport', match: { value: sport } },
          { key: 'market_type', match: { value: marketType } }
        ];
        if (tags.length > 0) {
          mustFilters.push({ key: 'tags', match: { any: tags } });
        }

        const qdrantRes = await client.scroll('swarm_learning', {
          filter: { must: mustFilters },
          limit: 5,
          with_payload: true
        });

        if (Array.isArray(qdrantRes?.points) && qdrantRes.points.length > 0) {
          lessons = qdrantRes.points.map((p: any) => ({
            id: String(p.id),
            content: p.payload?.content || p.payload?.lesson || p.payload?.rule || JSON.stringify(p.payload),
            lesson: p.payload?.lesson,
            rule: p.payload?.rule
          }));
          source = 'qdrant';
        }
      } catch (qErr) {
        // Silently fall through to Supabase fallback
      }
    }

    // 2. Fallback to Supabase lessons table
    if (lessons.length === 0) {
      const cfg = resolveSupabaseRpcConfig(env);
      if (cfg) {
        try {
          const queryParams = new URLSearchParams({
            rule_type: 'eq.routing_rule',
            sport: `eq.${sport}`,
            market_type: `eq.${marketType}`,
            select: 'id,sport,market_type,rule_type,content,lesson,tags',
            limit: '5'
          });
          const res = await fetchFn(`${cfg.supabaseUrl}/rest/v1/lessons?${queryParams.toString()}`, {
            method: 'GET',
            headers: {
              apikey: cfg.key,
              Authorization: `Bearer ${cfg.key}`,
              Accept: 'application/json'
            }
          });
          if (res.ok) {
            const rows = await res.json().catch(() => []);
            if (Array.isArray(rows) && rows.length > 0) {
              lessons = rows.map((r: any) => ({
                id: String(r.id),
                content: r.content || r.lesson || r.rule || 'Routing rule match',
                lesson: r.lesson,
                rule: r.rule
              }));
              source = 'supabase';
            }
          }
        } catch {
          // Supabase query error
        }
      }
    }

    const lessonLines = lessons.map(l => `- [${l.id || 'rule'}]: ${l.content || l.lesson || l.rule || 'rule'}`);
    const summary = [
      `[HISTORICAL LESSONS: ${sport} | ${marketType}]`,
      lessonLines.length > 0 ? lessonLines.join('\n') : `No historical routing rules found for ${sport} / ${marketType}.`
    ].join('\n');

    return {
      success: true,
      sport,
      market_type: marketType,
      source,
      count: lessons.length,
      lessons,
      summary
    };
  }
};

export const ALLOWED_FILTERED_SPORTS_TOOLS_V1 = [
  'get_matchup_fundamentals_v1',
  'get_injury_and_roster_delta_v1',
  'get_environment_and_weather_v1',
  'get_market_movement_v1',
  'get_player_prop_splits_v1'
] as const;

export const FILTERED_SPORTS_TOOL_CANONICAL_NAMES: Record<string, string> = {
  get_matchup_fundamentals: 'get_matchup_fundamentals_v1',
  get_injury_and_roster_delta: 'get_injury_and_roster_delta_v1',
  get_environment_and_weather: 'get_environment_and_weather_v1',
  get_market_movement: 'get_market_movement_v1',
  get_player_prop_splits: 'get_player_prop_splits_v1',
  get_matchup_fundamentals_v1: 'get_matchup_fundamentals_v1',
  get_injury_and_roster_delta_v1: 'get_injury_and_roster_delta_v1',
  get_environment_and_weather_v1: 'get_environment_and_weather_v1',
  get_market_movement_v1: 'get_market_movement_v1',
  get_player_prop_splits_v1: 'get_player_prop_splits_v1'
};

/**
 * Array of all 6 DuelOdds Database RPC & Historical Lessons tools.
 */
export const dueloddsRpcTools: SwarmTool[] = [
  getMatchupFundamentalsTool,
  getInjuryAndRosterDeltaTool,
  getPlayerPropSplitsTool,
  getEnvironmentAndWeatherTool,
  getMarketMovementTool,
  getHistoricalLessonsTool
];
