import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getMatchupFundamentalsTool,
  getInjuryAndRosterDeltaTool,
  getPlayerPropSplitsTool,
  getEnvironmentAndWeatherTool,
  getMarketMovementTool,
  getHistoricalLessonsTool,
  dueloddsRpcTools,
  callSupabaseRpc,
  resolveSupabaseRpcConfig
} from './dueloddsRpcTools.ts';
import { globalToolRegistry } from './registry.ts';

// Rough token estimator (~4 chars per token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key'
};

describe('DuelOdds Database RPC Tools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Credentials & Config Resolution', () => {
    it('resolves config with publishable or anon key', () => {
      const cfg = resolveSupabaseRpcConfig(mockEnv);
      expect(cfg).toEqual({
        supabaseUrl: 'https://mock.supabase.co',
        key: 'mock-anon-key'
      });
    });

    it('returns null if SUPABASE_URL or key is missing', () => {
      expect(resolveSupabaseRpcConfig({})).toBeNull();
      expect(resolveSupabaseRpcConfig({ SUPABASE_URL: 'https://foo.com' })).toBeNull();
      expect(resolveSupabaseRpcConfig({ SUPABASE_ANON_KEY: 'key' })).toBeNull();
    });

    it('handles missing credentials gracefully on tool execution', async () => {
      const res = await (getMatchupFundamentalsTool as any).execute(
        { game_id: 'g-1' },
        { env: {} }
      );
      expect(res.success).toBe(false);
      expect(res.error).toBe('supabase_not_configured');
      expect(res.summary).toContain('Error');
    });
  });

  describe('Tool 1: get_matchup_fundamentals', () => {
    it('validates game_id input parameter', async () => {
      const res1 = await (getMatchupFundamentalsTool as any).execute({});
      expect(res1.success).toBe(false);
      expect(res1.error).toBe('invalid_game_id');

      const res2 = await (getMatchupFundamentalsTool as any).execute({ game_id: '   ' });
      expect(res2.success).toBe(false);
      expect(res2.error).toBe('invalid_game_id');
    });

    it('validates window parameter', async () => {
      const res = await (getMatchupFundamentalsTool as any).execute({
        game_id: 'g-1',
        window: 'L20' // Invalid
      });
      expect(res.success).toBe(false);
      expect(res.error).toBe('invalid_window');
    });

    it('successfully calls get_matchup_fundamentals_v1 and formats dense summary <= 250 tokens', async () => {
      const mockFetch = vi.fn(async (url: string, init: any) => {
        expect(url).toContain('/rest/v1/rpc/get_matchup_fundamentals_v1');
        const body = JSON.parse(init.body);
        expect(body.game_id).toBe('game-kc-buf-2026');
        expect(body.window).toBe('L5');
        return new Response(
          JSON.stringify({
            home_team: 'KC',
            away_team: 'BUF',
            home_pace: 68.4,
            away_pace: 65.2,
            net_off_margin: 4.8,
            net_def_margin: -2.1,
            home_ats_split: '4-1-0',
            away_ats_split: '3-2-0'
          }),
          { status: 200 }
        );
      });

      const res = await (getMatchupFundamentalsTool as any).execute(
        { game_id: 'game-kc-buf-2026', window: 'L5' },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[MATCHUP FUNDAMENTALS: game-kc-buf-2026 (L5)]');
      expect(res.summary).toContain('Pace: Home 68.4 | Away 65.2');
      expect(res.summary).toContain('Net Margins: Off 4.8 | Def -2.1');
      expect(res.summary).toContain('ATS Splits: Home 4-1-0 | Away 3-2-0');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });
  });

  describe('Tool 2: get_injury_and_roster_delta', () => {
    it('validates game_id parameter', async () => {
      const res = await (getInjuryAndRosterDeltaTool as any).execute({});
      expect(res.success).toBe(false);
      expect(res.error).toBe('invalid_game_id');
    });

    it('calls get_injury_and_roster_delta_v1 and formats active/out statuses and expected minute shifts <= 250 tokens', async () => {
      const mockFetch = vi.fn(async (url: string, init: any) => {
        expect(url).toContain('/rest/v1/rpc/get_injury_and_roster_delta_v1');
        const body = JSON.parse(init.body);
        expect(body.game_id).toBe('game-kc-buf-2026');
        expect(body.position_group).toBe('WR');
        return new Response(
          JSON.stringify([
            { player_name: 'Rashee Rice', position: 'WR', status: 'OUT', minute_shift: -32.5 },
            { player_name: 'Xavier Worthy', position: 'WR', status: 'QUESTIONABLE', minute_shift: 8.0 }
          ]),
          { status: 200 }
        );
      });

      const res = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'game-kc-buf-2026', position_group: 'WR' },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[INJURY & ROSTER DELTA: game-kc-buf-2026 | WR]');
      expect(res.summary).toContain('Rashee Rice (WR): OUT (shift: -32.5)');
      expect(res.summary).toContain('Xavier Worthy (WR): QUESTIONABLE (shift: +8)');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });
  });

  describe('Tool 3: get_player_prop_splits', () => {
    it('validates player_id and stat_category parameters', async () => {
      const res1 = await (getPlayerPropSplitsTool as any).execute({ stat_category: 'pass_yds' });
      expect(res1.success).toBe(false);
      expect(res1.error).toBe('invalid_player_id');

      const res2 = await (getPlayerPropSplitsTool as any).execute({ player_id: 'p-1' });
      expect(res2.success).toBe(false);
      expect(res2.error).toBe('invalid_stat_category');

      const res3 = await (getPlayerPropSplitsTool as any).execute({
        player_id: 'p-1',
        stat_category: 'pass_yds',
        last_n: -5
      });
      expect(res3.success).toBe(false);
      expect(res3.error).toBe('invalid_last_n');
    });

    it('calls get_player_prop_splits_v1 and formats hit rate, median, variance, and logs <= 250 tokens', async () => {
      const mockFetch = vi.fn(async (url: string, init: any) => {
        expect(url).toContain('/rest/v1/rpc/get_player_prop_splits_v1');
        const body = JSON.parse(init.body);
        expect(body.player_id).toBe('p-mahomes-15');
        expect(body.stat_category).toBe('pass_yds');
        expect(body.last_n).toBe(10);
        expect(body.line).toBe(265.5);
        return new Response(
          JSON.stringify({
            hit_rate: 0.7,
            over_count: 7,
            sample_size: 10,
            line: 265.5,
            median: 278.0,
            variance: 420.5,
            recent_logs: [292, 245, 310, 275, 280]
          }),
          { status: 200 }
        );
      });

      const res = await (getPlayerPropSplitsTool as any).execute(
        { player_id: 'p-mahomes-15', stat_category: 'pass_yds', last_n: 10, line: 265.5 },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[PLAYER PROP SPLITS: p-mahomes-15 | pass_yds]');
      expect(res.summary).toContain('Hit Rate: 70.0% (7/10 Over 265.5)');
      expect(res.summary).toContain('Median: 278 | Variance: 420.5');
      expect(res.summary).toContain('Recent: [292, 245, 310, 275, 280]');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });
  });

  describe('Tool 4: get_environment_and_weather', () => {
    it('validates game_id parameter', async () => {
      const res = await (getEnvironmentAndWeatherTool as any).execute({});
      expect(res.success).toBe(false);
      expect(res.error).toBe('invalid_game_id');
    });

    it('short-circuits immediately when is_dome: true is passed without calling RPC', async () => {
      const mockFetch = vi.fn();
      const res = await (getEnvironmentAndWeatherTool as any).execute(
        { game_id: 'game-dome-1', is_dome: true },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(res.success).toBe(true);
      expect(res.is_dome).toBe(true);
      expect(res.short_circuited).toBe(true);
      expect(res.summary).toContain('Indoor / Dome (climate-controlled). Weather factors not applicable.');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });

    it('short-circuits when RPC returns is_dome: true', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify({ is_dome: true, venue_name: 'Allegiant Stadium' }), { status: 200 })
      );

      const res = await (getEnvironmentAndWeatherTool as any).execute(
        { game_id: 'game-vegas-1' },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.success).toBe(true);
      expect(res.is_dome).toBe(true);
      expect(res.summary).toContain('Indoor / Dome (climate-controlled)');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });

    it('formats outdoor weather when is_dome is false <= 250 tokens', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            is_dome: false,
            condition: 'Snow',
            temp_f: 28,
            temp_c: -2,
            wind_mph: 16,
            wind_dir: 'NW',
            precip_prob: 0.65
          }),
          { status: 200 }
        )
      );

      const res = await (getEnvironmentAndWeatherTool as any).execute(
        { game_id: 'game-lambeau-1' },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(res.success).toBe(true);
      expect(res.is_dome).toBe(false);
      expect(res.summary).toContain('[ENVIRONMENT & WEATHER: game-lambeau-1]');
      expect(res.summary).toContain('Conditions: Snow | Temp: 28°F (-2°C)');
      expect(res.summary).toContain('Wind: 16 mph NW | Precip: 65%');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });
  });

  describe('Tool 5: get_market_movement', () => {
    it('validates game_id and market_type parameters', async () => {
      const res1 = await (getMarketMovementTool as any).execute({ market_type: 'spread' });
      expect(res1.success).toBe(false);
      expect(res1.error).toBe('invalid_game_id');

      const res2 = await (getMarketMovementTool as any).execute({ game_id: 'g-1' });
      expect(res2.success).toBe(false);
      expect(res2.error).toBe('invalid_market_type');
    });

    it('calls get_market_movement_v1 and formats open vs current, steam, divergence <= 250 tokens', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            open_line: -2.5,
            open_price: '-110',
            current_line: -3.5,
            current_price: '-115',
            line_delta: -1.0,
            steam_direction: 'home_steam',
            steam_magnitude: 1.0,
            cross_book_divergence: 'DraftKings -3.5 vs FanDuel -3.0'
          }),
          { status: 200 }
        )
      );

      const res = await (getMarketMovementTool as any).execute(
        { game_id: 'game-kc-buf-2026', market_type: 'spread' },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[MARKET MOVEMENT: game-kc-buf-2026 | spread]');
      expect(res.summary).toContain('Open: -2.5 (-110) -> Current: -3.5 (-115) | Delta: -1');
      expect(res.summary).toContain('Steam: home_steam (1 pts) | Divergence: DraftKings -3.5 vs FanDuel -3.0');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });
  });

  describe('Tool 6: get_historical_lessons', () => {
    it('validates sport and market_type parameters', async () => {
      const res1 = await (getHistoricalLessonsTool as any).execute({ market_type: 'spread' });
      expect(res1.success).toBe(false);
      expect(res1.error).toBe('invalid_sport');

      const res2 = await (getHistoricalLessonsTool as any).execute({ sport: 'americanfootball_nfl' });
      expect(res2.success).toBe(false);
      expect(res2.error).toBe('invalid_market_type');

      const res3 = await (getHistoricalLessonsTool as any).execute({
        sport: 'americanfootball_nfl',
        market_type: 'spread',
        tags: 'dome' as any
      });
      expect(res3.success).toBe(false);
      expect(res3.error).toBe('invalid_tags');
    });

    it('queries Qdrant first when client is available', async () => {
      const mockQdrant = {
        scroll: vi.fn(async () => ({
          points: [
            {
              id: 'lesson-1',
              payload: {
                rule_type: 'routing_rule',
                sport: 'americanfootball_nfl',
                market_type: 'spread',
                content: 'NFL road underdogs > 7 pts in division games cover at 58% clip.'
              }
            }
          ]
        }))
      };

      const res = await (getHistoricalLessonsTool as any).execute(
        { sport: 'americanfootball_nfl', market_type: 'spread' },
        { qdrantClient: mockQdrant }
      );

      expect(mockQdrant.scroll).toHaveBeenCalledTimes(1);
      expect(res.success).toBe(true);
      expect(res.source).toBe('qdrant');
      expect(res.count).toBe(1);
      expect(res.summary).toContain('NFL road underdogs > 7 pts');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });

    it('falls back to Supabase lessons table when Qdrant is unavailable', async () => {
      const mockFetch = vi.fn(async (url: string) => {
        expect(url).toContain('/rest/v1/lessons?');
        return new Response(
          JSON.stringify([
            {
              id: 'lesson-supa-1',
              rule_type: 'routing_rule',
              sport: 'basketball_nba',
              market_type: 'total',
              content: 'NBA b2b teams on 3-in-4 nights hit under 61% when total > 230.'
            }
          ]),
          { status: 200 }
        );
      });

      const res = await (getHistoricalLessonsTool as any).execute(
        { sport: 'basketball_nba', market_type: 'total' },
        { fetchFn: mockFetch as any, env: mockEnv }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.success).toBe(true);
      expect(res.source).toBe('supabase');
      expect(res.count).toBe(1);
      expect(res.summary).toContain('NBA b2b teams on 3-in-4 nights hit under');
      expect(estimateTokens(res.summary)).toBeLessThanOrEqual(250);
    });
  });

  describe('Registry Integration', () => {
    it('registers all 6 DuelOdds database tools in globalToolRegistry', () => {
      for (const tool of dueloddsRpcTools) {
        expect(globalToolRegistry.has(tool.name)).toBe(true);
        expect(globalToolRegistry.get(tool.name)).toBeDefined();
      }
    });

    it('renders compact prompt schema including all 6 tools', () => {
      const schema = globalToolRegistry.renderPromptSchema();
      expect(schema).toContain('Tool: get_matchup_fundamentals');
      expect(schema).toContain('Tool: get_injury_and_roster_delta');
      expect(schema).toContain('Tool: get_player_prop_splits');
      expect(schema).toContain('Tool: get_environment_and_weather');
      expect(schema).toContain('Tool: get_market_movement');
      expect(schema).toContain('Tool: get_historical_lessons');
    });
  });
});
