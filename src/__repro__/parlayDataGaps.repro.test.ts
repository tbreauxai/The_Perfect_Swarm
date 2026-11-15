import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getMatchupFundamentalsTool,
  getMarketMovementTool
} from '../swarm/tools/dueloddsRpcTools.ts';
import { upsertGameJudgmentV2 } from '../swarm/morning/supabase.ts';
import type { SlateGame, SupabaseConfig } from '../swarm/types.ts';
import type { JudgmentV2 } from '../swarm/morning/types.ts';

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key'
};

const mockCfg: SupabaseConfig = {
  supabaseUrl: 'https://mock.supabase.co',
  supabaseServiceKey: 'mock-key'
};

const mockGame: SlateGame = {
  eventId: 'nba-bos-dal-2026',
  sport: 'basketball_nba',
  league: 'nba',
  homeTeam: 'Boston Celtics',
  awayTeam: 'Dallas Mavericks',
  commenceTime: '2026-11-15T20:00:00Z',
  gameDate: '2026-11-15',
  weatherSnapshot: null,
  oddsSnapshot: {
    spread: -3.5,
    overUnder: 224.5
  }
};

const mockJudgmentV2: JudgmentV2 = {
  side: 'home',
  confidence: 'medium',
  projMargin: 5.5,
  projTotal: 228.0,
  totalLean: 'over',
  reasons: ['Strong home offense and pace advantage']
};

describe('parlayDataGaps repro & contract tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('(A) empty RPC source: empty with 32-hex id labels "no canonical game", not "Pace: Home N/A"', async () => {
    const hexId = '0123456789abcdef0123456789abcdef';
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ source: 'empty', status: 'no_rows' }), { status: 200 })
    );

    const res = await (getMatchupFundamentalsTool as any).execute(
      { game_id: hexId },
      { fetchFn: mockFetch as any, env: mockEnv }
    );

    expect(res.success).toBe(true);
    expect(res.empty).toBe(true);
    expect(res.summary).toContain(`no canonical game for ${hexId}`);
    expect(res.summary).not.toContain('Pace:');
    expect(res.summary).not.toContain('Home N/A');
    expect(res.summary).not.toContain('ATS Splits:');
  });

  it('(B) real shape with BOS 7-3, net_margin 8.3 and DAL -3.3 renders values without Pace/ATS N/A', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          home: {
            team: 'BOS',
            games_played: 10,
            wins: 7,
            losses: 3,
            points_for_avg: 117.2,
            points_against_avg: 108.9,
            net_margin: 8.3,
            recent_results: ['W', 'W', 'L']
          },
          away: {
            team: 'DAL',
            games_played: 10,
            wins: 4,
            losses: 6,
            points_for_avg: 110.1,
            points_against_avg: 113.4,
            net_margin: -3.3,
            recent_results: ['L', 'L', 'W']
          },
          h2h: []
        }),
        { status: 200 }
      )
    );

    const res = await (getMatchupFundamentalsTool as any).execute(
      { game_id: 'nba-bos-dal-2026', window: 'season' },
      { fetchFn: mockFetch as any, env: mockEnv }
    );

    expect(res.success).toBe(true);
    expect(res.summary).toContain('Home (BOS): W-L 7-3 | PF/PA 117.2 / 108.9 | Net Margin 8.3 | Recent W,W,L');
    expect(res.summary).toContain('Away (DAL): W-L 4-6 | PF/PA 110.1 / 113.4 | Net Margin -3.3 | Recent L,L,W');
    expect(res.summary).toContain('8.3');
    expect(res.summary).toContain('-3.3');
    expect(res.summary).not.toContain('Pace:');
    expect(res.summary).not.toContain('ATS Splits:');
    expect(res.summary).not.toContain('N/A');
  });

  it('(C) snapshots_tracked: 1 emits "1 snapshot, no history" without Delta: 0 or neutral steam', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          market_type: 'spread',
          snapshots_tracked: 1,
          opening: { line: -3.5, price: -110, timestamp: '2026-11-15T10:00:00Z' },
          current: { line: -3.5, price: -110, timestamp: '2026-11-15T10:00:00Z' },
          delta: { line_delta: 0, price_delta: 0 },
          steam_detected: false,
          steam_side: 'neutral',
          reverse_line_movement: false
        }),
        { status: 200 }
      )
    );

    const res = await (getMarketMovementTool as any).execute(
      { game_id: 'nba-bos-dal-2026', market_type: 'spread' },
      { fetchFn: mockFetch as any, env: mockEnv }
    );

    expect(res.success).toBe(true);
    expect(res.summary).toMatch(/1 snapshot/);
    expect(res.summary).toContain('no history');
    expect(res.summary).not.toContain('Delta: 0');
    expect(res.summary).not.toContain('Steam: neutral');
    expect(res.summary).not.toContain('neutral');
  });

  it('(D) upsertGameJudgmentV2 writes tools_called array to game_judgments row', async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(null, { status: 201 });
    });

    const toolsCalled = ['get_matchup_fundamentals_canonical_v1', 'get_market_movement_v1'];

    await upsertGameJudgmentV2(
      mockCfg,
      mockGame,
      mockJudgmentV2,
      { model: 'test-model' },
      'wf-test-789',
      mockFetch as any,
      toolsCalled
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.tools_called).toEqual(toolsCalled);
    expect(capturedBody.workflow_id).toBe('wf-test-789');
    expect(capturedBody.event_id).toBe('nba-bos-dal-2026');
    expect(capturedBody.proj_margin).toBe(5.5);
    expect(capturedBody.proj_total).toBe(228.0);
  });

  it('(D2) upsertGameJudgmentV2 defaults tools_called to [] when omitted', async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(null, { status: 201 });
    });

    await upsertGameJudgmentV2(
      mockCfg,
      mockGame,
      mockJudgmentV2,
      { model: 'test-model' },
      'wf-test-789',
      mockFetch as any
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.tools_called).toEqual([]);
  });
});
