import { describe, it, expect, vi } from 'vitest';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { guardAnalystResponse, isDataRequest } from '../swarm/parser/responseGuards.ts';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';

// Repro for the Nov 16 2026 ~1:34 PM CST parlay run, pinned at Swarm 7f1a066 (#160).
const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };
// Real order returned by get_injury_and_roster_delta_v1('nfl-401873065') (SELECT, Nov 16).
const NFL_INJ = [
  ['24','Branson Taylor','out'],['24','Kayode Awosika','questionable'],['24','Kendall Williamson','out'],
  ['24','Ladd McConkey','out'],['24','Trey Pipkins III','out'],['33','Adam Randall','out'],
  ['33','Adisa Isaac','questionable'],['33','Jaylinn Hawkins','out'],['33','Lamar Jackson','out'],['33','Tyler Huntley','out']
].map(([team_id, player_name, status]) => ({ team_id, player_name, status }));

describe('parlayRunNov16c repro', () => {
  it('(1) injury summary groups by team with out/doubtful first and includes Lamar/Huntley', async () => {
    const injuriesWithPos = NFL_INJ.map((p: any) => p.player_name === 'Lamar Jackson' ? { ...p, position: 'QB', source_ref: 'espn' } : { ...p, source_ref: 'espn' });
    const fetchFn: any = vi.fn(async () => new Response(JSON.stringify({
      source: 'snapshot',
      game_id: 'nfl-401873065',
      home_team_id: '33',
      home_team: 'BAL',
      away_team_id: '24',
      away_team: 'LAC',
      injuries: injuriesWithPos
    }), { status: 200 }));
    const res: any = await getInjuryAndRosterDeltaTool.execute({ game_id: 'nfl-401873065' }, { fetchFn, env });
    expect(res.success).toBe(true);
    expect(res.summary).toContain('BAL: ');
    expect(res.summary).toContain('Lamar Jackson (QB): OUT');
    expect(res.summary).toContain('Tyler Huntley: OUT');
    expect(res.summary).toContain('LAC: ');
    expect(res.summary.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(res.data)).not.toContain('source_ref');
  });

  it('(2+3) object with picks and no insights -> stripped insights, keeps picks, _placeholder false', () => {
    const quant = JSON.stringify({ picks: [{ pick: 'BAL -4.5', odds: '-110/-106', edge: '~+260' }, { pick: 'BOS -340 ML' }], summary: 'BAL -4.5 at -110' });
    const g: any = guardAnalystResponse(quant, 'Quant Proposer');
    expect(g.summary).not.toContain('-110');
    expect(g._placeholder).toBeUndefined();
    expect(g.insights.join(' ')).not.toContain('-110');
    expect(g.insights.join(' ')).not.toContain('~+260');
    expect(g.insights.join(' ')).not.toContain('-340');
    expect(g.insights).toContain('BAL -4.5');
    expect(g.picks).toHaveLength(2);
    expect(g.flags).toContain('seat_emitted_pricing');

    const market: any = guardAnalystResponse(JSON.stringify({ recommendation: { pick: 'X +190' }, lines: ['-162'] }), 'Market Proposer');
    expect(market._placeholder).toBe(true);
    expect(market.insights[0]).not.toContain('+190');
    expect(market.insights[0]).not.toContain('-162');
    expect([g, market].every(r => r._placeholder === true || isDataRequest(r))).toBe(false);
  });

  it('(6) game-major prefetch: 6 games / cap 8 -> injury+fundamentals for games 1-4 (BOS included), games 5-6 not fetched', async () => {
    const fund: string[] = [];
    const inj: string[] = [];
    const mk = (name: string, push?: string[]) => ({ name, description: name,
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => { push?.push(game_id); return { success: true, summary: `${name}:${game_id}` }; }) });
    const registry = new ToolRegistry([mk('get_matchup_fundamentals', fund), mk('get_injury_and_roster_delta', inj)]);
    const games = ['nba-401909998','nfl-401873065','nba-401909994','nhl-401892727','nba-401909995','nba-401910000'];
    const agent: any = { id: 'a1', role: 'a1', provider: 'openrouter', run: vi.fn(async () => JSON.stringify({ insights: ['x'], summary: 'x' })) };
    const res = await runSeatWithTools({ agent, seat: 'a1', prompt: 'p', gameIds: games, registry });
    expect(inj).toEqual(games.slice(0, 4));
    expect(fund).toEqual(games.slice(0, 4)); // BOS nba-401909994 gets fundamentals
    expect(res.toolEvidence).toContain('nba-401909995: not fetched');
    expect(res.toolEvidence).toContain('nba-401910000: not fetched');
  });
});
