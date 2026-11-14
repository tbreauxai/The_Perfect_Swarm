import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  getMatchupFundamentalsTool,
  getInjuryAndRosterDeltaTool,
  getPlayerPropSplitsTool,
  getEnvironmentAndWeatherTool,
  getMarketMovementTool,
  resolveSupabaseRpcConfig
} from '../../src/swarm/tools/dueloddsRpcTools.ts';

const fixturePath = resolve(__dirname, '../../fixtures/duelodds_tool_rpc_signatures_v1.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const mockValidEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'mock-anon-publishable-key-xyz'
};

describe('Contract: DuelOdds Tool RPC Signatures & PostgREST p*-Params', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tools = [
    {
      name: 'getMatchupFundamentalsTool',
      tool: getMatchupFundamentalsTool,
      expectedRpc: 'get_matchup_fundamentals_v1',
      allArgs: { game_id: 'g-nfl-123', window: 'L5' },
      minArgs: { game_id: 'g-nfl-123' }
    },
    {
      name: 'getInjuryAndRosterDeltaTool',
      tool: getInjuryAndRosterDeltaTool,
      expectedRpc: 'get_injury_and_roster_delta_v1',
      allArgs: { game_id: 'g-nfl-123', position_group: 'QB' },
      minArgs: { game_id: 'g-nfl-123' }
    },
    {
      name: 'getPlayerPropSplitsTool',
      tool: getPlayerPropSplitsTool,
      expectedRpc: 'get_player_prop_splits_v1',
      allArgs: { player_id: 'p-15', stat_category: 'pass_yds', last_n: 10, line: 265.5 },
      minArgs: { player_id: 'p-15', stat_category: 'pass_yds' }
    },
    {
      name: 'getEnvironmentAndWeatherTool',
      tool: getEnvironmentAndWeatherTool,
      expectedRpc: 'get_environment_and_weather_v1',
      allArgs: { game_id: 'g-nfl-123' },
      minArgs: { game_id: 'g-nfl-123' }
    },
    {
      name: 'getMarketMovementTool',
      tool: getMarketMovementTool,
      expectedRpc: 'get_market_movement_v1',
      allArgs: { game_id: 'g-nfl-123', market_type: 'spread' },
      minArgs: { game_id: 'g-nfl-123', market_type: 'spread' }
    }
  ];

  for (const t of tools) {
    it(`calls ${t.expectedRpc} with all args and verifies p*-prefixed parameters match fixture signature`, async () => {
      let capturedUrl = '';
      let capturedBody: Record<string, unknown> = {};

      const mockFetch = vi.fn(async (url: string, init: any) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      await t.tool.execute(t.allArgs, { fetchFn: mockFetch as any, env: mockValidEnv });

      expect(capturedUrl).toContain(`/rest/v1/rpc/${t.expectedRpc}`);
      const fnSpec = fixture.functions[t.expectedRpc];
      expect(fnSpec).toBeDefined();

      const allowedArgNames = new Set(fnSpec.args.map((a: any) => a.name));
      const requiredArgNames = fnSpec.args.filter((a: any) => a.required).map((a: any) => a.name);

      const sentKeys = Object.keys(capturedBody);
      // Every sent key must start with p*
      for (const key of sentKeys) {
        expect(key.startsWith('p_')).toBe(true);
        expect(allowedArgNames.has(key)).toBe(true);
      }

      // Every required arg in fixture must be sent
      for (const req of requiredArgNames) {
        expect(sentKeys).toContain(req);
      }
    });

  describe('Minimal-args calls omit optional parameters', () => {
    it('getMatchupFundamentalsTool with no window sends only p_game_id', async () => {
      let capturedBody: Record<string, unknown> = {};
      const mockFetch = vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({}), { status: 200 });
      });
      await getMatchupFundamentalsTool.execute({ game_id: 'g-123' }, { fetchFn: mockFetch as any, env: mockValidEnv });
      expect(capturedBody).toEqual({ p_game_id: 'g-123' });
    });

    it('getInjuryAndRosterDeltaTool with no position_group sends only p_game_id', async () => {
      let capturedBody: Record<string, unknown> = {};
      const mockFetch = vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({}), { status: 200 });
      });
      await getInjuryAndRosterDeltaTool.execute({ game_id: 'g-123' }, { fetchFn: mockFetch as any, env: mockValidEnv });
      expect(capturedBody).toEqual({ p_game_id: 'g-123' });
    });

    it('getPlayerPropSplitsTool with no last_n and no line sends only p_player_id and p_stat_category', async () => {
      let capturedBody: Record<string, unknown> = {};
      const mockFetch = vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({}), { status: 200 });
      });
      await getPlayerPropSplitsTool.execute(
        { player_id: 'p-15', stat_category: 'pass_yds' },
        { fetchFn: mockFetch as any, env: mockValidEnv }
      );
      expect(capturedBody).toEqual({ p_player_id: 'p-15', p_stat_category: 'pass_yds' });
    });
  });
  }

  it('rejects service-role key only environments with supabase_not_configured', async () => {
    const serviceRoleOnlyEnv = {
      SUPABASE_URL: 'https://mock.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJ-service-role-secret-key'
    };

    expect(resolveSupabaseRpcConfig(serviceRoleOnlyEnv)).toBeNull();

    const res = await getMatchupFundamentalsTool.execute(
      { game_id: 'g-123' },
      { env: serviceRoleOnlyEnv }
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe('supabase_not_configured');
  });

  it('rejects publishable key matching service-role key or containing service_role', async () => {
    const leakedServiceEnv = {
      SUPABASE_URL: 'https://mock.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'test-service_role-leak'
    };
    expect(resolveSupabaseRpcConfig(leakedServiceEnv)).toBeNull();

    const identicalEnv = {
      SUPABASE_URL: 'https://mock.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'key-123',
      SUPABASE_SERVICE_ROLE_KEY: 'key-123'
    };
    expect(resolveSupabaseRpcConfig(identicalEnv)).toBeNull();
  });
});
