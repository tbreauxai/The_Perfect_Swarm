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

    const formatH2h = (h2h: any): string => {
      if (!Array.isArray(h2h) || h2h.length === 0) return '';
      return h2h.map((g: any) => {
        const date = g.game_date ? `${g.game_date}: ` : '';
        const score = (g.team_score !== undefined && g.opponent_score !== undefined)
          ? ` ${g.team_score}-${g.opponent_score}`
          : '';
        const res = g.result ? ` (${g.result})` : '';
        const match = g.team_abbr && g.opponent_abbr ? `${g.team_abbr} vs ${g.opponent_abbr}` : '';
        return `${date}${match}${score}${res}`.trim();
      }).join('; ');
    };

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
        const mappedItems = mapFormValue(d.form.items) as any[];
        const byTeam = new Map<string, any[]>();
        for (const item of mappedItems) {
          const team = String(item?.team ?? item?.team_id ?? 'Unknown');
          const list = byTeam.get(team);
          if (list) list.push(item);
          else byTeam.set(team, [item]);
        }
        if (homeLbl && !byTeam.has(String(homeLbl))) {
          const homeMatched = Array.from(byTeam.keys()).find(k => k.toLowerCase() === String(homeLbl).toLowerCase());
          if (!homeMatched) byTeam.set(String(homeLbl), []);
        }
        if (awayLbl && !byTeam.has(String(awayLbl))) {
          const awayMatched = Array.from(byTeam.keys()).find(k => k.toLowerCase() === String(awayLbl).toLowerCase());
          if (!awayMatched) byTeam.set(String(awayLbl), []);
        }
        const parts: string[] = [];
        for (const [team, items] of byTeam.entries()) {
          const sorted = [...items].sort((a, b) =>
            String(b?.game_date ?? '').localeCompare(String(a?.game_date ?? ''))
          );
          const results = sorted
            .map((it) => (typeof it?.result === 'string' ? it.result.trim().toUpperCase() : ''))
            .filter(Boolean);
          const wins = results.filter((r) => r === 'W').length;
          const losses = results.filter((r) => r === 'L').length;
          const isHomeSide = homeLbl && team.toLowerCase() === String(homeLbl).toLowerCase();
          const isAwaySide = awayLbl && team.toLowerCase() === String(awayLbl).toLowerCase();
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
      const h2hText = formatH2h(d.h2h);
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

    const homeTeam = homeObj.team || d.home_team || (context as any)?.game?.home_team || 'Home';
    const awayTeam = awayObj.team || d.away_team || (context as any)?.game?.away_team || 'Away';
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

    const h2hText = formatH2h(d.h2h);
    const summaryLines = [
      `[MATCHUP FUNDAMENTALS: ${gameId} (${displayWindow})]`,
      `Home (${homeTeam}): W-L ${homeWl} | PF/PA ${homePfPa} | Net Margin ${homeNet} | Recent ${homeRecent}${homeExtra}`,
      `Away (${awayTeam}): W-L ${awayWl} | PF/PA ${awayPfPa} | Net Margin ${awayNet} | Recent ${awayRecent}${awayExtra}`
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
      const enriched = {
        ...p,
        team_abbr: p.team_abbr || resolved.abbr,
        team_name: p.team_name || resolved.name
      };
      keptInjuries.push(enriched);
      const groupKey = resolved.abbr || resolved.label;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, { label: resolved.label, items: [] });
      }
      grouped.get(groupKey)!.items.push(enriched);
    }

    const injuryLines: string[] = [];
    for (const { label, items } of grouped.values()) {
      const sorted = items
        .map((p, idx) => ({ p, idx, rank: statusRank(p.status || p.injury_status || 'OUT') }))
        .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
        .slice(0, 5)
        .map(({ p }) => {
          const name = p.player_name || p.name || p.player_id || 'Unknown';
          const pos = p.position || p.pos || '';
          const status = String(p.status || p.injury_status || 'OUT').toUpperCase();
          const shift = p.minute_shift ?? p.usage_shift ?? p.delta ?? '';
          const shiftStr = shift !== '' ? ` (shift: ${shift > 0 ? '+' : ''}${shift})` : '';
          return `${name}${pos ? ` (${pos})` : ''}: ${status}${shiftStr}`;
        });
      if (sorted.length > 0) {
        injuryLines.push(`- ${label}: ${sorted.join('; ')}`);
      }
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
          ...(Array.isArray(d.injuries) ? { injuries: strippedKept } : {}),
          ...(Array.isArray(d.players) ? { players: strippedKept } : {})
        };

    const summary = [
      `[INJURY & ROSTER DELTA: ${gameId}${positionGroup ? ` | ${positionGroup}` : ''}]`,
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
      return 'basketball_nba';
    };
    const sportKey = inferSportKey();
    const spreadThreshold = (sportKey === 'americanfootball_nfl' || sportKey === 'icehockey_nhl' || sportKey === 'baseball_mlb') ? 1.0 : 1.5;
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

    const detectSpreadSteam = (): string | null => {
      if (spreadDeltaHome === null || Math.abs(spreadDeltaHome) < spreadThreshold) return null;
      if (spreadDeltaHome < 0) {
        return `home ${homeLabel} (${spreadDeltaHome.toFixed(1)} pts)`;
      }
      return `away ${awayLabel} (-${Math.abs(spreadDeltaHome).toFixed(1)} pts)`;
    };

    const detectMlSteam = (): string | null => {
      let useHome = openMlHomeNum !== null && currMlHomeNum !== null && openMlHomeNum !== currMlHomeNum;
      let useAway = openMlAwayNum !== null && currMlAwayNum !== null && openMlAwayNum !== currMlAwayNum;
      if (!useHome && !useAway) return null;

      let impShiftPct = 0;
      let inMidBand = false;
      let centShift = 0;
      if (useHome && openMlHomeNum !== null && currMlHomeNum !== null) {
        const pOpen = americanToImpliedProb(openMlHomeNum);
        const pCurr = americanToImpliedProb(currMlHomeNum);
        if (pOpen !== null && pCurr !== null) {
          impShiftPct = (pCurr - pOpen) * 100;
        }
        inMidBand = Math.abs(openMlHomeNum) <= 150 && Math.abs(currMlHomeNum) <= 150;
        centShift = Math.abs(toCentScale(currMlHomeNum) - toCentScale(openMlHomeNum));
      } else if (useAway && openMlAwayNum !== null && currMlAwayNum !== null) {
        const pOpen = americanToImpliedProb(openMlAwayNum);
        const pCurr = americanToImpliedProb(currMlAwayNum);
        if (pOpen !== null && pCurr !== null) {
          impShiftPct = -((pCurr - pOpen) * 100);
        }
        inMidBand = Math.abs(openMlAwayNum) <= 150 && Math.abs(currMlAwayNum) <= 150;
        centShift = Math.abs(toCentScale(currMlAwayNum) - toCentScale(openMlAwayNum));
      }

      if (Math.abs(impShiftPct) < 2.5 && !(inMidBand && centShift >= 15)) {
        return null;
      }
      const impAbs = Math.abs(impShiftPct).toFixed(1);
      if (impShiftPct > 0 || (!useAway && openMlHomeNum !== null && currMlHomeNum !== null && toCentScale(currMlHomeNum) < toCentScale(openMlHomeNum))) {
        if (openMlHomeNum !== null && currMlHomeNum !== null) {
          return `home ${homeLabel} ML (${fmtOddsOrLine(openMlHomeNum)} -> ${fmtOddsOrLine(currMlHomeNum)}, +${impAbs}% imp)`;
        }
        return `home ${homeLabel} ML (+${impAbs}% imp)`;
      }
      if (openMlAwayNum !== null && currMlAwayNum !== null) {
        return `away ${awayLabel} ML (${fmtOddsOrLine(openMlAwayNum)} -> ${fmtOddsOrLine(currMlAwayNum)}, +${impAbs}% imp)`;
      }
      if (openMlHomeNum !== null && currMlHomeNum !== null) {
        return `away ${awayLabel} ML (home ${fmtOddsOrLine(openMlHomeNum)} -> ${fmtOddsOrLine(currMlHomeNum)}, +${impAbs}% imp)`;
      }
      return `away ${awayLabel} ML (+${impAbs}% imp)`;
    };

    const detectTotalSteam = (): string | null => {
      if (totalDeltaVal === null || Math.abs(totalDeltaVal) < totalThreshold) return null;
      const side = totalDeltaVal > 0 ? 'over' : 'under';
      const signed = totalDeltaVal > 0 ? `+${totalDeltaVal.toFixed(1)}` : totalDeltaVal.toFixed(1);
      return `${side} (${openTotalNum} -> ${currTotalNum}, ${signed} pts)`;
    };

    const orderedSteam = isMlRequested
      ? (detectMlSteam() || detectSpreadSteam() || detectTotalSteam())
      : isTotalRequested
        ? (detectTotalSteam() || detectSpreadSteam() || detectMlSteam())
        : (detectSpreadSteam() || detectMlSteam() || detectTotalSteam());

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
    const explicitDivergence =
      typeof (d.cross_book_divergence || d.divergence) === 'string' &&
      String(d.cross_book_divergence || d.divergence).trim() !== '' &&
      !/^none$/i.test(String(d.cross_book_divergence || d.divergence).trim())
        ? String(d.cross_book_divergence || d.divergence).trim()
        : null;
    const divergence = explicitDivergence ?? (booksTracked >= 2 ? 'none' : 'single_book_only');

    const deltaSuffix = typeof delta === 'number' ? ` | Delta: ${delta}` : '';
    const summaryLines = [
      `[MARKET MOVEMENT: ${gameId} | ${marketType}]`,
      `Open: ${openDisplay}${openPriceSuffix} -> Current: ${currDisplay}${currPriceSuffix}${deltaSuffix}`
    ];
    if (extraMarketParts.length > 0) {
      summaryLines.push(extraMarketParts.join(' | '));
    }
    summaryLines.push(`Steam: ${steamDisplay} | Divergence: ${divergence}`);

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
