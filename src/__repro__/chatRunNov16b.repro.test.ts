import { describe, it, expect, vi } from 'vitest';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { countVerifiedCitations } from '../swarm/engine/predictionEnsemble.ts';
import { stripApproximateOdds, guardAnalystResponse } from '../swarm/parser/responseGuards.ts';
import { adaptContextEnvelope } from '../swarm/morning/gameContext.ts';
import { ModelRouter } from '../swarm/router.ts';

// Repro for wf-1794851496795 (Nov 16 2026, 11:51 AM CST) pinned at c77ac57.
describe('chatRunNov16b repro', () => {
  it('(1) verifier prompt includes rawData.toolResults within CAP', async () => {
    let verifyPrompt = '';
    const proposer: any = { role: 'Manager', modelName: 'm', provider: 'openrouter',
      run: vi.fn(async () => JSON.stringify({ summary: 'Fade PHI: Joel Embiid out', picks: [] })) };
    const critic: any = { role: 'Risk Critic', modelName: 'c', provider: 'groq',
      run: vi.fn(async (p: string) => { verifyPrompt = p; return JSON.stringify({ pass: false, feedback: 'Embiid not in analyst reports' }); }) };
    await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
      { analystReports: [{ agent: 'a1', summary: 'short' }], rawBoard: 'nba-401909997 PHI @ BKN',
        toolResults: '[INJURY: nba-401909997] PHI: Joel Embiid (Out); CLE: Evan Mobley (Out)' },
      new SwarmContext(), 'Compile', 'Verify');
    expect(verifyPrompt.length).toBeGreaterThan(0);
    expect(verifyPrompt.length).toBeLessThanOrEqual(5600);
    expect(verifyPrompt).toContain('Joel Embiid (Out)');
    expect(verifyPrompt).toContain('Evan Mobley (Out)');
  });

  it('(2) game-major prefetch on 6 games / cap 8 => injuries + fundamentals for first 4 games', async () => {
    const inj: string[] = [];
    const mk = (name: string, push?: string[]) => ({ name, description: name,
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => { push?.push(game_id); return { success: true, summary: `${name}:${game_id}` }; }) });
    const registry = new ToolRegistry([mk('get_matchup_fundamentals'), mk('get_injury_and_roster_delta', inj)]);
    const games = ['nba-401909998','nba-401909997','nba-401909994','nba-401909996','nba-401909995','nba-401910000'];
    const agent: any = { id: 'a1', role: 'a1', provider: 'openrouter', run: vi.fn(async () => JSON.stringify({ insights: [], summary: 'x' })) };
    await runSeatWithTools({ agent, seat: 'a1', prompt: 'p', gameIds: games, registry });
    expect(inj).toEqual(games.slice(0, 4));
  });

  it('(3) countVerifiedCitations > 0 for real seat tool-summary headers', () => {
    const seat = { summary: 'GSW -3.5', toolEvidence: '[MATCHUP FUNDAMENTALS: nba-401910000 (GSW @ NOP)] L10 ...\n[INJURY & ROSTER DELTA: nba-401910000] GSW: Stephen Curry (Out)' };
    expect(countVerifiedCitations(seat)).toBeGreaterThan(0);
  });

  it('(2b) guard strips exact odds / stake / payout and sets seat_emitted_pricing', () => {
    const t = 'GSW -3.5 at -110, stake 2u, payout $220, Curry 28.4 PPG';
    const cleaned = stripApproximateOdds(t);
    expect(cleaned).not.toContain('-110');
    expect(cleaned).not.toContain('2u');
    expect(cleaned).not.toContain('stake');
    expect(cleaned).not.toContain('payout');
    expect(cleaned).toContain('GSW -3.5');
    expect(cleaned).toContain('Curry 28.4 PPG');

    const guarded = guardAnalystResponse(
      JSON.stringify({
        insights: [t],
        anomalies: [],
        summary: 'GSW -3.5',
        recommendation: { pick: 'GSW -3.5', odds: -110, stake: 2 }
      }),
      'Quant'
    );
    expect(guarded.flags).toContain('seat_emitted_pricing');
    expect((guarded as any).recommendation?.odds).toBeUndefined();
    expect((guarded as any).recommendation?.stake).toBeUndefined();
  });

  it('(5) adapter maps "home"/"away" selections and derives spread_away', () => {
    const now = '2026-11-16T17:38:19.486Z';
    const row: any = { event_id: 'nba-401910000', status: 'partial', sections: {
      game: { status: 'ready', items: [{ event_id: 'nba-401910000', home_team: 'New Orleans Pelicans', home_team_id: '3', away_team: 'Golden State Warriors', away_team_id: '9' }] },
      odds: { status: 'ready', items: [
        { book: 'fanduel', market: 'h2h', selection: 'home', american_price: 140, line: null, snapshot_at: now },
        { book: 'fanduel', market: 'h2h', selection: 'away', american_price: -165, line: null, snapshot_at: now },
        { book: 'fanduel', market: 'spreads', selection: 'home', american_price: -110, line: 3.5, snapshot_at: now },
        { book: 'fanduel', market: 'totals', selection: 'over', american_price: -110, line: 228.5, snapshot_at: now } ] } } };
    const out: any = adaptContextEnvelope(row);
    const o = out.sections.odds[0];
    expect(o.total).toBe(228.5);
    expect(o.ml_home).toBe(140);
    expect(o.ml_away).toBe(-165);
    expect(o.spread_home).toBe(3.5);
    expect(o.spread_away).toBe(-3.5);
    expect(o.spread_price_away).toBeNull();
  });

  it('(6) router does not return formatting tier for "best nba bets today" with DuelOdds JSON header', () => {
    const duelOddsTask = 'Reply ONLY with a single top-level JSON object\nUser Question: best nba bets today';
    expect(ModelRouter.inferComplexity(duelOddsTask, 500, 1, false, { userQuestion: 'best nba bets today' })).not.toBe('formatting');
    expect(ModelRouter.inferComplexity('format as json', 500, 1, false, { deepAnalysis: true })).not.toBe('formatting');
    expect(ModelRouter.inferComplexity('format as json', 500, 1, true)).not.toBe('formatting');
  });
});
