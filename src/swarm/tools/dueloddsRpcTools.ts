/**
 * Deterministic DuelOdds Database RPC & Historical Lessons Swarm Tools.
 * Conforms to SwarmTool contract with strict input validation,
 * deterministic execution, dome short-circuiting, and token-dense formatting (<= 250 tokens).
 */

import type { SwarmTool } from './types.ts';
import { QdrantClient } from '@qdrant/js-client-rest';

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

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        error: `rpc_failed_${res.status}`,
        message: `Supabase RPC ${rpcName} failed [${res.status}]: ${errText}`
      };
    }

    const data = (await res.json().catch(() => null)) as T;
    return { ok: true, data };
  } catch (err: any) {
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
    const homePace = d.home_pace ?? d.pace?.home ?? 'N/A';
    const awayPace = d.away_pace ?? d.pace?.away ?? 'N/A';
    const netOff = d.net_off_margin ?? d.off_margin ?? 'N/A';
    const netDef = d.net_def_margin ?? d.def_margin ?? 'N/A';
    const homeAts = d.home_ats_split ?? d.home_ats ?? 'N/A';
    const awayAts = d.away_ats_split ?? d.away_ats ?? 'N/A';

    const displayWindow = windowVal || 'season';
    const summary = [
      `[MATCHUP FUNDAMENTALS: ${gameId} (${displayWindow})]`,
      `Pace: Home ${homePace} | Away ${awayPace}`,
      `Net Margins: Off ${netOff} | Def ${netDef}`,
      `ATS Splits: Home ${homeAts} | Away ${awayAts}`
    ].join('\n');

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
    const injuries = Array.isArray(d.injuries)
      ? d.injuries
      : Array.isArray(d.players)
        ? d.players
        : Array.isArray(d)
          ? d
          : [];

    const injuryLines = injuries.slice(0, 6).map((p: any) => {
      const name = p.player_name || p.name || p.player_id || 'Unknown';
      const pos = p.position || p.pos || '';
      const status = p.status || p.injury_status || 'OUT';
      const shift = p.minute_shift ?? p.usage_shift ?? p.delta ?? '';
      const shiftStr = shift !== '' ? ` (shift: ${shift > 0 ? '+' : ''}${shift})` : '';
      return `- ${name}${pos ? ` (${pos})` : ''}: ${status}${shiftStr}`;
    });

    const summary = [
      `[INJURY & ROSTER DELTA: ${gameId}${positionGroup ? ` | ${positionGroup}` : ''}]`,
      injuryLines.length > 0 ? injuryLines.join('\n') : 'No significant roster deltas or injury tags reported.'
    ].join('\n');

    return {
      success: true,
      game_id: gameId,
      position_group: positionGroup,
      data: d,
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
    const isDome = Boolean(d.is_dome || d.dome_closed || d.indoor);

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

    const tempF = d.temp_f ?? (d.temp_c !== undefined ? Math.round((d.temp_c * 9) / 5 + 32) : 'N/A');
    const tempC = d.temp_c ?? (d.temp_f !== undefined ? Math.round(((d.temp_f - 32) * 5) / 9) : 'N/A');
    const windMph = d.wind_mph ?? (d.wind_kph !== undefined ? Math.round(d.wind_kph * 0.621371) : 'N/A');
    const windDir = d.wind_dir || d.wind_direction || '';
    const precipProb = d.precip_prob !== undefined ? `${Math.round(d.precip_prob <= 1 ? d.precip_prob * 100 : d.precip_prob)}%` : '0%';
    const condition = d.condition || 'Clear';

    const summary = [
      `[ENVIRONMENT & WEATHER: ${gameId}]`,
      `Conditions: ${condition} | Temp: ${tempF}°F (${tempC}°C)`,
      `Wind: ${windMph} mph ${windDir} | Precip: ${precipProb}`
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
    if (typeof args.market_type !== 'string' || !args.market_type.trim()) {
      return {
        success: false,
        error: 'invalid_market_type',
        message: 'Missing or empty market_type parameter.',
        summary: 'Error: Missing or empty market_type parameter.'
      };
    }
    const gameId = args.game_id.trim();
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
    const openLine = d.open_line ?? d.opening_spread ?? d.opening_total ?? d.opening_line ?? 'N/A';
    const openPrice = d.open_price ?? d.opening_price ?? '-110';
    const currLine = d.current_line ?? d.current_spread ?? d.current_total ?? 'N/A';
    const currPrice = d.current_price ?? '-110';
    const delta = d.line_delta ?? d.spread_delta ?? d.total_delta ?? (
      typeof openLine === 'number' && typeof currLine === 'number'
        ? Number((currLine - openLine).toFixed(2))
        : '0'
    );
    const steamDir = d.steam_direction || d.steam_dir || 'neutral';
    const steamMag = d.steam_magnitude ?? (delta !== 'N/A' ? Math.abs(Number(delta)) : 0);
    const divergence = d.cross_book_divergence || d.divergence || 'none';

    const summary = [
      `[MARKET MOVEMENT: ${gameId} | ${marketType}]`,
      `Open: ${openLine} (${openPrice}) -> Current: ${currLine} (${currPrice}) | Delta: ${delta}`,
      `Steam: ${steamDir} (${steamMag} pts) | Divergence: ${divergence}`
    ].join('\n');

    return {
      success: true,
      game_id: gameId,
      market_type: marketType,
      data: d,
      summary
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
