import { describe, it, expect, vi } from 'vitest';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { buildVerifierEvidence } from '../swarm/engine/verifierEvidence.ts';

// Repro for wf-1794867719290 (Nov 16 2026, 4:21:59 PM CST), Swarm 9669da4 (#161).
const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };
const INJ: Record<string, Array<[string, string, string]>> = {
  'nba-401909998': [['10','Fred VanVleet','out'],['10','Steven Adams','out'],['14','Tyler Herro','out'],['14','Terry Rozier','out']],
  'nfl-401873065': [['24','Ladd McConkey','out'],['24','Trey Pipkins III','out'],['33','Lamar Jackson','out'],['33','Tyler Huntley','out'],['33','Adisa Isaac','questionable']],
  'nba-401909997': [['20','Adem Bona','out'],['20','Ariel Hukporti','out'],['20','Dominick Barlow','out'],['20','Joel Embiid','questionable']],
  'nhl-401892727': [['129764','Logan Cooley','out'],['22','Thatcher Demko','out']],
  'nba-401909994': [['19','Izaiyah Nelson','out'],['19','Jonathan Isaac','out'],['19','Noah Penda','out'],['19','Paolo Banchero','out']],
  'nba-401910000': [['9','Stephen Curry','out'],['3','Dejounte Murray','out']]
};
const GAMES = Object.keys(INJ);
const fetchFn: any = vi.fn(async (_u: string, init: any) => {
  const id = JSON.parse(init.body).p_game_id;
  return new Response(JSON.stringify({ source: 'snapshot', game_id: id, injuries: INJ[id].map(([team_id, player_name, status]) => ({ team_id, player_name, status })) }), { status: 200 });
});
const injuryTool = { ...getInjuryAndRosterDeltaTool, execute: (a: any) => getInjuryAndRosterDeltaTool.execute(a, { fetchFn, env }) };
const pad = (s: string) => s + ' ' + 'L10 form W-L, net margin, pace, ORtg/DRtg, rest days, home/away splits. '.repeat(8);
const mk = (name: string, f: (g: string) => string) => ({ name, description: name,
  parameters: { game_id: { type: 'string' as const, description: 'id', required: true }, market_type: { type: 'string' as const, description: 'm' } },
  execute: vi.fn(async ({ game_id }: any) => ({ success: true, summary: f(game_id) })) });
const registry = new ToolRegistry([injuryTool as any,
  mk('get_matchup_fundamentals', g => pad(`[MATCHUP FUNDAMENTALS: ${g} (L10)]`)),
  mk('get_market_movement', g => `[MARKET MOVEMENT: ${g}] FanDuel open/curr spread, total, ML`)]);
const seat = (id: string, provider: string) => ({ id, role: id, provider, run: vi.fn(async () => JSON.stringify({ insights: ['x'], summary: 'x' })) }) as any;

describe('verifierEvidenceUnion repro', () => {
  it('verifier [Tool Evidence] unions and dedupes all seats so Banchero, Embiid, and Lamar all fit within groq CAP', async () => {
    const seats = [['a1', 'openrouter'], ['a2', 'openrouter'], ['critic', 'groq']] as const;
    const reports: any[] = [];
    for (const [id, prov] of seats) {
      const r = await runSeatWithTools({ agent: seat(id, prov), seat: id, prompt: 'p', gameIds: GAMES, registry });
      reports.push({ role: id, toolEvidence: r.toolEvidence, toolEvidenceItems: r.toolEvidenceItems, covered: r.coveredEventIds });
    }
    expect(reports[1].toolEvidence).toContain('nba-401909994');
    expect(reports[2].toolEvidence).toContain('Paolo Banchero');

    const verifierEvidence = buildVerifierEvidence(reports, GAMES.map(id => `event_id=${id} | sport=nba | AWAY @ HOME`).join('\n'));
    expect(verifierEvidence).toContain('Paolo Banchero');
    expect(verifierEvidence).toContain('Joel Embiid');
    expect(verifierEvidence).toContain('Lamar Jackson');
    // Each event appears once per tool
    expect(verifierEvidence.match(/EVENT nba-401909994/g)).toHaveLength(1);

    let verifyPrompt = '';
    const proposer: any = { role: 'Manager', modelName: 'm', provider: 'openrouter',
      run: vi.fn(async () => JSON.stringify({ summary: 'BOS -8.5: ORL without Paolo Banchero (OUT); PHI Joel Embiid questionable; BAL Lamar Jackson OUT. ' + 'Reasoning. '.repeat(200), picks: [{ pick: 'BOS -8.5', event_id: 'nba-401909994' }] })) };
    const critic: any = { role: 'Risk Critic', modelName: 'c', provider: 'groq',
      run: vi.fn(async (p: string) => { verifyPrompt = p; return JSON.stringify({ pass: false, feedback: 'x' }); }) };
    await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
      { analystReports: [{ agent: 'a1', summary: 'BOS -8.5' }], rawBoard: GAMES.join('\n'), toolResults: verifierEvidence },
      new SwarmContext(), 'Compile', 'Verify');
    const ev = verifyPrompt.slice(verifyPrompt.indexOf('[Tool Evidence]:\n'));
    expect(verifyPrompt.length).toBeLessThanOrEqual(5600);       // lifecycle.ts:130 CAP for groq
    expect(ev).toContain('Lamar Jackson');
    expect(ev).toContain('Joel Embiid');
    expect(ev).toContain('Paolo Banchero');
  });
});
