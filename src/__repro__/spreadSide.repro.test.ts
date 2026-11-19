import { describe, it, expect, vi } from 'vitest';
import { getMarketMovementTool } from '../swarm/tools/dueloddsRpcTools.ts';
import {
  SPREAD_SIDE_RULE,
  auditMarketCoverageAndRowBinding,
  checkRowSideBinding,
  extractRowOptions,
  sanitizeRowMismatchedPicks
} from '../swarm/tools/marketRowBinding.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { Agent } from '../swarm/agent.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

describe('Spread side must match the row (Blazers @ Bucks)', () => {
  it('(1) SPREAD_SIDE_RULE is injected verbatim in all swarm instructions and lifecycle retry rules', async () => {
    for (const instr of [
      ANALYST_SYSTEM_INSTRUCTION,
      RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      MANAGER_SYSTEM_INSTRUCTION
    ]) {
      expect(instr).toContain('SPREAD SIDE:');
      expect(instr).toContain('- Read the sign from the row or the tool.');
      expect(instr).toContain('- A negative spread is the favorite. A positive spread is the underdog.');
      expect(instr).toContain('- Do not flip the sign when naming the other team.');
      expect(instr).toContain('- Portland +10.5 is not Portland -10.5.');
    }
    expect(SPREAD_SIDE_RULE).toContain('Portland +10.5 is not Portland -10.5.');

    const capturedPrompts: string[] = [];
    const proposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async (prompt: string) => {
        capturedPrompts.push(prompt);
        return JSON.stringify({
          summary: 'Portland Trail Blazers +10.5 is the underdog at Milwaukee Bucks -10.5.',
          picks: [{ row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers +10.5', market: 'spread' }]
        });
      })
    };
    const critic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify({ pass: false, feedback: 'Veto: check spread sign.' }))
        .mockResolvedValueOnce(JSON.stringify({ pass: true, feedback: 'Verified.' }))
    };

    const board =
      'event_id=nba-por-mil | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-19T23:00:00Z | options: R1 Portland Trail Blazers +10.5 (-110), R2 Milwaukee Bucks -10.5 (-110)';

    await new AnalysisLifecycle(proposer, critic, 2).executeAndVerify(
      {
        rawBoard: board,
        fullBoard: board,
        analystReports: '[Market] R1 Portland Trail Blazers +10.5',
        toolResults: '[MARKET MOVEMENT: nba-por-mil | all]\nCurrent: home MIL -10.5 / away POR +10.5 (-110)'
      },
      new SwarmContext(),
      'Analyze Blazers @ Bucks',
      'Verify Blazers @ Bucks'
    );

    expect(capturedPrompts.length).toBe(2);
    expect(capturedPrompts[1]).toContain('9. SPREAD SIDE:');
    expect(capturedPrompts[1]).toContain('Portland +10.5 is not Portland -10.5.');
  });

  it('(2) get_market_movement does not misassign bare +10.5 to home Milwaukee Bucks or flip Portland to -10.5', async () => {
    // A: Bare +10.5 with slate options for Blazers (+10.5) @ Bucks (-10.5) + ML
    const fetchFnWithBare: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-por-mil',
          bookmaker: 'fanduel',
          opening: { spread: 10.5, total: 224.5, ml_home: -450, ml_away: 350, price: -110 },
          latest: { spread: 10.5, total: 225.0, ml_home: -460, ml_away: 360, price: -110 },
          line_snapshots: [
            { spread: 10.5, total: 224.5, ml_home: -450, ml_away: 350, captured_at: '2026-11-19T14:00:00Z' },
            { spread: 10.5, total: 225.0, ml_home: -460, ml_away: 360, captured_at: '2026-11-19T18:00:00Z' }
          ]
        }),
        { status: 200 }
      )
    );

    const resMatched: any = await getMarketMovementTool.execute(
      { game_id: 'nba-por-mil', market_type: 'all' },
      {
        fetchFn: fetchFnWithBare,
        env,
        game: {
          event_id: 'nba-por-mil',
          sport: 'basketball_nba',
          away_team: 'Portland Trail Blazers',
          home_team: 'Milwaukee Bucks',
          options: [
            { id: 'R1', text: 'Portland Trail Blazers +10.5 (-110)' },
            { id: 'R2', text: 'Milwaukee Bucks -10.5 (-110)' }
          ]
        }
      } as any
    );

    expect(resMatched.success).toBe(true);
    expect(resMatched.summary).toContain('home Milwaukee Bucks -10.5 / away Portland Trail Blazers +10.5');
    expect(resMatched.summary).not.toContain('Portland Trail Blazers -10.5');
    expect(resMatched.summary).not.toContain('Milwaukee Bucks +10.5');

    // B: Unattributed bare +10.5 with NO slate options and NO ML emits raw "spread +10.5" without flipping
    const fetchFnUnattributed: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-por-mil',
          bookmaker: 'fanduel',
          latest: { spread: 10.5, price: -110 },
          line_snapshots: [{ spread: 10.5, captured_at: '2026-11-19T18:00:00Z' }]
        }),
        { status: 200 }
      )
    );

    const resRaw: any = await getMarketMovementTool.execute(
      { game_id: 'nba-por-mil', market_type: 'spread' },
      {
        fetchFn: fetchFnUnattributed,
        env,
        game: {
          event_id: 'nba-por-mil',
          sport: 'basketball_nba',
          away_team: 'Portland Trail Blazers',
          home_team: 'Milwaukee Bucks'
        }
      } as any
    );

    expect(resRaw.success).toBe(true);
    expect(resRaw.summary).toContain('spread +10.5');
    expect(resRaw.summary).not.toContain('Portland Trail Blazers -10.5');
    expect(resRaw.summary).not.toContain('Milwaukee Bucks +10.5');
  });

  it('(3) Deterministic Critic audit rejects and sanitizer fixes/strips spread sign and favorite/underdog flips', () => {
    const board =
      'event_id=nba-por-mil | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-19T23:00:00Z | options: R1 Portland Trail Blazers +10.5 (-110), R2 Milwaukee Bucks -10.5 (-110), R3 Portland Trail Blazers ML (+360), R4 Milwaukee Bucks ML (-460)';
    const rowMap = extractRowOptions([board]);
    const r1 = rowMap.get('R1')!;
    expect(checkRowSideBinding('R1', 'Portland Trail Blazers -10.5', r1).valid).toBe(false);
    expect(checkRowSideBinding('R1', 'Portland Trail Blazers +10.5', r1).valid).toBe(true);

    // Case A: Prose says "Portland was a -10.5" and calls Portland favored
    const flippedProseAudit = auditMarketCoverageAndRowBinding(
      {
        summary: 'Latest analysis said Portland was a -10.5 favorite on the road.',
        picks: []
      },
      '',
      board
    );
    expect(flippedProseAudit.pass).toBe(false);
    expect(flippedProseAudit.flags).toContain('spread_side_mismatch');
    expect(flippedProseAudit.feedback).toContain('+10.5');

    // Case B: Pick cites flipped spread "-10.5" without row ID or with row R1
    const flippedPickAudit = auditMarketCoverageAndRowBinding(
      {
        summary: 'Backing Portland.',
        picks: [{ row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers -10.5', market: 'spread' }]
      },
      '',
      board
    );
    expect(flippedPickAudit.pass).toBe(false);

    const rowlessFlipAudit = auditMarketCoverageAndRowBinding(
      {
        summary: 'Take Milwaukee +10.5 as the underdog.',
        picks: [{ event_id: 'nba-por-mil', side: 'Milwaukee Bucks +10.5', market: 'spread' }]
      },
      '',
      board
    );
    expect(rowlessFlipAudit.pass).toBe(false);
    expect(rowlessFlipAudit.flags).toContain('spread_side_mismatch');

    // Case C: Valid underdog/favorite wording does not trigger false positive
    const validAudit = auditMarketCoverageAndRowBinding(
      {
        summary:
          'Portland Trail Blazers +10.5 is the road underdog against the heavy favorite Milwaukee Bucks (-10.5).',
        picks: [
          {
            row: 'R1',
            event_id: 'nba-por-mil',
            side: 'Portland Trail Blazers +10.5',
            market: 'spread',
            reason: 'Portland (+10.5) gets double-digit points as the underdog vs favored Milwaukee (-10.5).'
          }
        ]
      },
      '',
      board
    );
    expect(validAudit.pass).toBe(true);

    // Case D: Sanitizer drops flipped pick & removes "Portland -10.5" while preserving grounded picks
    const dirtyReport: any = {
      summary:
        'Portland was a -10.5 favorite in this matchup. Milwaukee Bucks -10.5 lays 10.5 points at home.',
      insights: ['Blazers (-10.5) look mispriced here.', 'Milwaukee is favored by 10.5 points.'],
      picks: [
        { row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers -10.5', market: 'spread' },
        { row: 'R2', event_id: 'nba-por-mil', side: 'Milwaukee Bucks -10.5', market: 'spread' }
      ],
      components: [
        {
          id: 'c1',
          type: 'InsightList',
          props: {
            title: 'Key Notes',
            insights: [
              { type: 'info', message: 'Portland -10.5 is favored tonight.' },
              { type: 'info', message: 'Portland Trail Blazers +10.5 are the underdog at Milwaukee.' }
            ]
          }
        }
      ]
    };
    const cleaned = sanitizeRowMismatchedPicks(dirtyReport, board);
    expect(cleaned.picks).toHaveLength(1);
    expect(cleaned.picks[0].row).toBe('R2');
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toMatch(/Portland[^"}]*-10\.5/i);
    expect(serialized).not.toMatch(/Blazers[^"}]*-10\.5/i);
    expect(serialized).toContain('Milwaukee Bucks -10.5');
    expect(serialized).toContain('Portland Trail Blazers +10.5');
  });

  it('(4) End-to-end Blazers @ Bucks request catches "Portland -10.5" on Attempt 1 and enforces "+10.5 underdog / -10.5 favorite"', async () => {
    const slate =
      'event_id=nba-por-mil | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-19T23:00:00Z | options: R1 Portland Trail Blazers +10.5 (-110), R2 Milwaukee Bucks -10.5 (-110), R3 Portland Trail Blazers ML (+360), R4 Milwaukee Bucks ML (-460)';

    const fetchFn: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-por-mil',
          bookmaker: 'fanduel',
          opening: { spread: 10.5, total: 224.5, ml_home: -450, ml_away: 350, price: -110 },
          latest: { spread: 10.5, total: 225.0, ml_home: -460, ml_away: 360, price: -110 },
          line_snapshots: [
            { spread: 10.5, total: 224.5, ml_home: -450, ml_away: 350, captured_at: '2026-11-19T14:00:00Z' },
            { spread: 10.5, total: 225.0, ml_home: -460, ml_away: 360, captured_at: '2026-11-19T18:00:00Z' }
          ]
        }),
        { status: 200 }
      )
    );

    const marketTool = {
      ...getMarketMovementTool,
      execute: (args: any, ctx?: any) => getMarketMovementTool.execute(args, { ...ctx, fetchFn, env })
    };
    const injuryTool = {
      name: 'get_injury_and_roster_delta',
      description: 'injuries',
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => ({
        success: true,
        summary: `[INJURY & ROSTER DELTA: ${game_id}] Lineups intact.`
      }))
    };
    const fundamentalsTool = {
      name: 'get_matchup_fundamentals',
      description: 'fundamentals',
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => ({
        success: true,
        summary: `[MATCHUP FUNDAMENTALS: ${game_id}] Milwaukee holds home net-rating advantage; Portland is playing on the road.`
      }))
    };

    const registry = new ToolRegistry([marketTool as any, injuryTool as any, fundamentalsTool as any]);
    let managerAttempts = 0;

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis: 'Portland Trail Blazers are +10.5 road underdogs at Milwaukee Bucks (-10.5 favorite).',
          picks: [{ row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers +10.5', market: 'spread', confidence: 71 }],
          scorecards: []
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        return JSON.stringify({
          analysis: 'Market shows home Milwaukee Bucks -10.5 (ml_home -460) and away Portland Trail Blazers +10.5 (ml_away +360).',
          picks: [{ row: 'R2', event_id: 'nba-por-mil', side: 'Milwaukee Bucks -10.5', market: 'spread', confidence: 69 }],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({ pass: true, feedback: 'Looks good.', verdict: 'Verified', flags: [] });
      }

      // Manager attempts in Verification Lifecycle (and final synthesis before lifecycle)
      if (prompt.includes('Previous Verification Critique')) {
        managerAttempts++;
        return JSON.stringify({
          ui_title: 'Blazers @ Bucks Breakdown',
          pass: true,
          summary:
            'Bottom-line call: Portland Trail Blazers +10.5 (R1) is the road underdog while home Milwaukee Bucks -10.5 (ml_home -460) is favored. Analysts split slightly on spread value vs home favorite chalk.',
          picks: [{ row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers +10.5', market: 'spread', confidence: 71 }],
          components: []
        });
      }
      // First verification attempt outputs flipped Portland -10.5 -> deterministic Critic must veto it!
      if (prompt.includes('Analyst Reports Sample') || prompt.includes('Analyst Reports:')) {
        return JSON.stringify({
          ui_title: 'Blazers @ Bucks Breakdown',
          pass: true,
          summary: 'Bottom-line call: Portland was a -10.5 favorite in Milwaukee.',
          picks: [{ row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers -10.5', market: 'spread', confidence: 71 }],
          components: []
        });
      }
      return JSON.stringify({
        ui_title: 'Blazers @ Bucks Breakdown',
        pass: true,
        summary: 'Bottom-line call: Portland was a -10.5 favorite in Milwaukee.',
        picks: [{ row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers -10.5', market: 'spread', confidence: 71 }],
        components: []
      });
    });

    try {
      const res = await executeSwarmWorkflow({
        task: 'Analyze Blazers @ Bucks spread and side.',
        data: slate,
        originApp: 'duelodds',
        enableDeepAnalysis: true,
        forceFullSwarm: true,
        bypassCache: true,
        disableMemoryRetrieval: true,
        tools: registry,
        settings: {
          openRouterApiKey: 'sk-or-v1-mock',
          groqApiKey: 'gsk_mock',
          agents: [
            { id: 'a1', role: 'Quant Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a1' },
            { id: 'a2', role: 'Market Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a2' },
            { id: 'critic', role: 'Risk Critic', provider: 'groq', apiKey: 'gsk_mock', modelName: 'mock-critic' },
            { id: 'manager', role: 'Manager Node', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-manager' }
          ]
        } as any
      });

      expect(managerAttempts).toBe(1);
      expect(res.finalAnalysis.verified).toBe(true);
      expect(res.finalAnalysis.picks).toHaveLength(1);
      expect(res.finalAnalysis.picks[0]).toMatchObject({ row: 'R1', side: 'Portland Trail Blazers +10.5' });
      expect(res.finalAnalysis.summary).toContain('Portland Trail Blazers +10.5');
      expect(res.finalAnalysis.summary).toContain('underdog');
      expect(res.finalAnalysis.summary).toContain('Milwaukee Bucks -10.5');
      expect(res.finalAnalysis.summary).toContain('favored');
      expect(JSON.stringify(res.finalAnalysis)).not.toMatch(/\b(?:Portland|Trail Blazers|Blazers)\b[^".!?};]{0,25}\(?-10\.5/i);
    } finally {
      runSpy.mockRestore();
    }
  });

  it('(5) If retries are exhausted with a stubborn spread-sign flip on Blazers @ Bucks, sanitizer fixes/strips it from final output', async () => {
    const slate =
      'event_id=nba-por-mil | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-19T23:00:00Z | options: R1 Portland Trail Blazers +10.5 (-110), R2 Milwaukee Bucks -10.5 (-110)';

    const fetchFn: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-por-mil',
          bookmaker: 'fanduel',
          opening: { spread: 10.5, total: 224.5, ml_home: -450, ml_away: 350, price: -110 },
          latest: { spread: 10.5, total: 225.0, ml_home: -460, ml_away: 360, price: -110 },
          line_snapshots: [
            { spread: 10.5, total: 224.5, ml_home: -450, ml_away: 350, captured_at: '2026-11-19T14:00:00Z' },
            { spread: 10.5, total: 225.0, ml_home: -460, ml_away: 360, captured_at: '2026-11-19T18:00:00Z' }
          ]
        }),
        { status: 200 }
      )
    );

    const registry = new ToolRegistry([
      { ...getMarketMovementTool, execute: (args: any, ctx?: any) => getMarketMovementTool.execute(args, { ...ctx, fetchFn, env }) } as any,
      {
        name: 'get_injury_and_roster_delta',
        description: 'injuries',
        parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => ({ success: true, summary: `[INJURY & ROSTER DELTA: ${game_id}] Lineups intact.` }))
      } as any,
      {
        name: 'get_matchup_fundamentals',
        description: 'fundamentals',
        parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => ({ success: true, summary: `[MATCHUP FUNDAMENTALS: ${game_id}] Milwaukee holds home edge.` }))
      } as any
    ]);

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('a2')) {
        return JSON.stringify({
          analysis: 'Milwaukee Bucks -10.5 favorite at home against Portland Trail Blazers +10.5.',
          picks: [{ row: 'R2', event_id: 'nba-por-mil', side: 'Milwaukee Bucks -10.5', market: 'spread', confidence: 72 }],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({ pass: true, feedback: 'Ok.' });
      }
      return JSON.stringify({
        ui_title: 'Blazers @ Bucks',
        pass: true,
        summary: 'Portland was a -10.5 favorite in this matchup. Home Milwaukee Bucks -10.5 remain the right side.',
        picks: [
          { row: 'R1', event_id: 'nba-por-mil', side: 'Portland Trail Blazers -10.5', market: 'spread', confidence: 60 },
          { row: 'R2', event_id: 'nba-por-mil', side: 'Milwaukee Bucks -10.5', market: 'spread', confidence: 72 }
        ],
        components: []
      });
    });

    try {
      const res = await executeSwarmWorkflow({
        task: 'Analyze Blazers @ Bucks.',
        data: slate,
        originApp: 'duelodds',
        enableDeepAnalysis: true,
        forceFullSwarm: true,
        bypassCache: true,
        disableMemoryRetrieval: true,
        tools: registry,
        settings: {
          openRouterApiKey: 'sk-or-v1-mock',
          groqApiKey: 'gsk_mock',
          agents: [
            { id: 'a1', role: 'Quant Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a1' },
            { id: 'a2', role: 'Market Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a2' },
            { id: 'critic', role: 'Risk Critic', provider: 'groq', apiKey: 'gsk_mock', modelName: 'mock-critic' },
            { id: 'manager', role: 'Manager Node', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-manager' }
          ]
        } as any
      });

      const serialized = JSON.stringify(res.finalAnalysis);
      expect(serialized).not.toMatch(/Portland[^"}]*-10\.5/i);
      expect(res.finalAnalysis.picks.some((p: any) => /Portland.*-10\.5/i.test(String(p.side || '')))).toBe(false);
    } finally {
      runSpy.mockRestore();
    }
  });
});
