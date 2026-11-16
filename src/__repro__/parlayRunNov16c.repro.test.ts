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

  it('(2+3) object without insights -> placeholder carrying unstripped raw JSON odds; isDataRequest irrelevant', () => {
    const quant = JSON.stringify({ picks: [{ pick: 'BAL -4.5', odds: '-110/-106', edge: '~+260' }, { pick: 'BOS -340 ML' }], summary: 'BAL -4.5 at -110' });
    const g: any = guardAnalystResponse(quant, 'Quant Proposer');
    expect(g.summary).not.toContain('-110');          // summary IS stripped
    expect(g._placeholder).toBe(true);                // but seat becomes a placeholder
    expect(g.insights[0]).toContain('-110/-106');     // and fallback insight carries raw odds verbatim
    expect(g.picks).toBeUndefined();                  // picks dropped on the object path
    expect(g.flags).toContain('seat_emitted_pricing');
    // index.ts:411 => every non-critic seat placeholder => critic-only early exit
    const market: any = guardAnalystResponse(JSON.stringify({ recommendation: { pick: 'X +190' }, lines: ['-162'] }), 'Market Proposer');
    expect(market._placeholder).toBe(true);
    expect([g, market].every(r => r._placeholder === true || isDataRequest(r))).toBe(true);
  });

  it('(6) injury-first tool-major prefetch: 6 games / cap 8 -> fundamentals only for first 2 games', async () => {
    const fund: string[] = [];
    const mk = (name: string, push?: string[]) => ({ name, description: name,
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => { push?.push(game_id); return { success: true, summary: `${name}:${game_id}` }; }) });
    const registry = new ToolRegistry([mk('get_matchup_fundamentals', fund), mk('get_injury_and_roster_delta')]);
    const games = ['nba-401909998','nfl-401873065','nba-401909994','nhl-401892727','nba-401909995','nba-401910000'];
    const agent: any = { id: 'a1', role: 'a1', provider: 'openrouter', run: vi.fn(async () => JSON.stringify({ insights: ['x'], summary: 'x' })) };
    await runSeatWithTools({ agent, seat: 'a1', prompt: 'p', gameIds: games, registry });
    expect(fund).toEqual(['nba-401909998', 'nfl-401873065']); // BOS nba-401909994 never fetched
  });
});
