import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';

describe('wf-1795810273966: Manager Full ALLOWED_PROPOSER_ROWS Context & Unjustified wageringPass Block', () => {
  it('includes slate rows and full dossier sections for ALL 5 ALLOWED_PROPOSER_ROWS games without truncating after game 1', () => {
    const slateLines = [
      'R5 | Buffalo Bills -10.5 | event_id=nfl-401901 | Buffalo Bills vs New York Jets',
      'R18 | Kansas City Chiefs -4.5 | event_id=nfl-401902 | Kansas City Chiefs vs Las Vegas Raiders',
      'R70 | Boston Celtics -6.5 | event_id=nba-401903 | Boston Celtics vs Miami Heat',
      'R90 | Denver Nuggets -3.5 | event_id=nba-401904 | Denver Nuggets vs Phoenix Suns',
      'R100 | Edmonton Oilers ML | event_id=nhl-401905 | Edmonton Oilers vs Calgary Flames'
    ];
    const rawInput = slateLines.join('\n');

    const buildDossierBlock = (evId: string, label: string, rowId: string) =>
      [
        `=== GAME DOSSIER: ${evId} ===`,
        `[${rowId}] ${label}`,
        `[MATCHUP FUNDAMENTALS: ${evId}] Season 10-2 | L5 4-1 | Diff +8.4`,
        `[INJURY & ROSTER DELTA: ${evId}] Health Balance: home_advantage (Home 0 OUT vs Away 3 OUT)`,
        `[MARKET MOVEMENT: ${evId}] Steam: TOWARD home ${label} (+3.8pp implied)`
      ].join('\n');

    const verifierEvidence = [
      buildDossierBlock('nfl-401901', 'Buffalo Bills', 'R5'),
      buildDossierBlock('nfl-401902', 'Kansas City Chiefs', 'R18'),
      buildDossierBlock('nba-401903', 'Boston Celtics', 'R70'),
      buildDossierBlock('nba-401904', 'Denver Nuggets', 'R90'),
      buildDossierBlock('nhl-401905', 'Edmonton Oilers', 'R100')
    ].join('\n\n');

    const managerAgent = new Agent('Manager Node', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia', 'nv-key');
    const a1 = new Agent('Quant Proposer', 'gemini-4-hydrogen', 'gemini', 'g-key');
    a1.id = 'a1';
    const a2 = new Agent('Market Proposer', 'groq/openai/gpt-oss-120b', 'groq', 'gr-key');
    a2.id = 'a2';

    const ctx = new SwarmContext();
    const res = compileSynthesisPrompt({
      task: 'Build a 3-leg optimal parlay from today slate.',
      rawInput,
      analysts: [a1, a2],
      managerAgent,
      allAnalystReports: [
        [
          {
            picks: [
              { row: 'R5', event_id: 'nfl-401901', side: 'Buffalo Bills -10.5', confidence: 0.8 },
              { row: 'R18', event_id: 'nfl-401902', side: 'Kansas City Chiefs -4.5', confidence: 0.77 },
              { row: 'R70', event_id: 'nba-401903', side: 'Boston Celtics -6.5', confidence: 0.75 }
            ],
            summary: 'Quant picks R5, R18, R70.'
          }
        ],
        [
          {
            picks: [
              { row: 'R90', event_id: 'nba-401904', side: 'Denver Nuggets -3.5', confidence: 0.74 },
              { row: 'R100', event_id: 'nhl-401905', side: 'Edmonton Oilers ML', confidence: 0.72 }
            ],
            summary: 'Market picks R90, R100.'
          }
        ]
      ],
      clusterDigests: {},
      historicalContext: '',
      context: ctx,
      params: { allowParlay: true, isBettingRun: true } as any,
      bypassCache: true,
      verifierEvidence
    });

    const prompt = res.effectiveDynamicPrompt;
    for (const [evId, rowId] of [
      ['nfl-401901', 'R5'],
      ['nfl-401902', 'R18'],
      ['nba-401903', 'R70'],
      ['nba-401904', 'R90'],
      ['nhl-401905', 'R100']
    ]) {
      expect(prompt).toContain(rowId);
      expect(prompt).toContain(`=== GAME DOSSIER: ${evId} ===`);
      expect(prompt).toContain(`[MATCHUP FUNDAMENTALS: ${evId}]`);
      expect(prompt).toContain(`[INJURY & ROSTER DELTA: ${evId}]`);
      expect(prompt).toContain(`[MARKET MOVEMENT: ${evId}]`);
    }
  });

  it('rejects empty wageringPass: true from Manager when criticApproved === true and >= 2 distinct-game approved proposer rows exist', async () => {
    const manager = new Agent('Manager Node', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'simulated', 'mock-key');
    const critic = new Agent('Verification Critic', 'gemini-3.5-flash-lite', 'simulated', 'mock-key');

    const slate = [
      'R5 | Buffalo Bills -10.5 | event_id=nfl-401901 | Buffalo Bills vs New York Jets',
      'R18 | Kansas City Chiefs -4.5 | event_id=nfl-401902 | Kansas City Chiefs vs Las Vegas Raiders',
      'R70 | Boston Celtics -6.5 | event_id=nba-401903 | Boston Celtics vs Miami Heat'
    ].join('\n');

    const unjustifiedPass = {
      summary: 'Insufficient market lines for remaining games; passing on the slate.',
      picks: [],
      scorecards: [],
      components: [],
      criticApproved: true,
      wageringPass: true
    };
    const compiledParlay = {
      summary: 'Proceeding with top 2 distinct-game legs: Buffalo Bills -10.5 (R5) and Kansas City Chiefs -4.5 (R18).',
      picks: [
        { row: 'R5', event_id: 'nfl-401901', side: 'Buffalo Bills -10.5', confidence: 0.8, reason: 'Season 10-2.' },
        { row: 'R18', event_id: 'nfl-401902', side: 'Kansas City Chiefs -4.5', confidence: 0.77, reason: 'Season 9-3.' }
      ],
      scorecards: [],
      components: [],
      criticApproved: true,
      wageringPass: false
    };

    const managerSpy = vi.spyOn(manager, 'run')
      .mockResolvedValueOnce(JSON.stringify(unjustifiedPass))
      .mockResolvedValueOnce(JSON.stringify(compiledParlay));

    const ctx = new SwarmContext();
    const lifecycle = new AnalysisLifecycle(manager, critic, 2);

    const result = await lifecycle.executeAndVerify(
      {
        fullBoard: slate,
        criticVerdictApproved: true,
        allowParlay: true,
        specialistPicks: [
          { row: 'R5', event_id: 'nfl-401901', side: 'Buffalo Bills -10.5', confidence: 0.8 },
          { row: 'R18', event_id: 'nfl-401902', side: 'Kansas City Chiefs -4.5', confidence: 0.77 },
          { row: 'R70', event_id: 'nba-401903', side: 'Boston Celtics -6.5', confidence: 0.75 }
        ],
        toolResults: [
          'EVENT nfl-401901\nBuffalo Bills: Season 10-2',
          'EVENT nfl-401902\nKansas City Chiefs: Season 9-3'
        ].join('\n')
      },
      ctx,
      'Build an optimal parlay from the slate.',
      'Audit parlay.'
    );

    const failEvt = ctx.events.find((e) => typeof e.action === 'string' && e.action.startsWith('Verification FAILED on attempt 1'));
    expect(failEvt).toBeDefined();
    expect(failEvt?.action).toMatch(/compile the top 2-3 distinct-game legs strictly from ALLOWED_PROPOSER_ROWS/i);
    expect(managerSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.finalProposal?.picks?.map((p: any) => p.row)).toEqual(['R5', 'R18']);
  });
});
