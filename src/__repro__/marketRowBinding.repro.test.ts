import { describe, it, expect, vi } from 'vitest';
import { getMarketMovementTool } from '../swarm/tools/dueloddsRpcTools.ts';
import {
  MARKET_AND_ROW_RULES,
  auditMarketCoverageAndRowBinding,
  checkRowSideBinding,
  extractRowOptions
} from '../swarm/tools/marketRowBinding.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { buildVerifierEvidence } from '../swarm/engine/verifierEvidence.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { Agent } from '../swarm/agent.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

describe('Moneyline coverage + row side mismatch', () => {
  it('(1) MARKET_AND_ROW_RULES is included in all swarm system instructions', () => {
    for (const instr of [
      ANALYST_SYSTEM_INSTRUCTION,
      RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      MANAGER_SYSTEM_INSTRUCTION
    ]) {
      expect(instr).toContain('MARKET AND ROW RULES:');
      expect(instr).toContain('- A moneyline is covered when the tool or board has ml_home or ml_away for that game.');
      expect(instr).toContain('- Do not reject a ML leg solely because a spread is also present.');
      expect(instr).toContain('- Cite the row ID for the exact side you are picking.');
      expect(instr).toContain('- Never assign a row to the opposite team or the opposite side of the line.');
    }
    expect(MARKET_AND_ROW_RULES).toContain('ml_home or ml_away');
  });

  it('(2) get_market_movement (market_type: all) preserves ml_home (-166), total (6.5), and spread (-1.5) through compact verifier evidence', async () => {
    const fetchFn: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nhl-401892752',
          bookmaker: 'fanduel',
          opening: { total: 6.5, spread: -1.5, ml_home: -170 },
          latest: { total: 6.5, spread: -1.5, ml_home: -166 },
          line_snapshots: [
            { total: 6.5, spread: -1.5, ml_home: -170, captured_at: '2026-11-18T14:00:00Z' },
            { total: 6.5, spread: -1.5, ml_home: -166, captured_at: '2026-11-18T18:00:00Z' }
          ]
        }),
        { status: 200 }
      )
    );

    const res: any = await getMarketMovementTool.execute(
      { game_id: 'nhl-401892752', market_type: 'all' },
      {
        fetchFn,
        env,
        game: {
          event_id: 'nhl-401892752',
          sport: 'icehockey_nhl',
          away_team: 'Utah Mammoth',
          home_team: 'Seattle Kraken'
        }
      } as any
    );

    expect(res.success).toBe(true);
    expect(res.markets_covered).toEqual(expect.arrayContaining(['spread', 'total', 'ml']));
    expect(res.summary).toContain('ml_home Seattle Kraken -166');
    expect(res.summary).toContain('Total: 6.5');

    const digest = buildVerifierEvidence(
      [
        {
          toolEvidenceItems: [
            {
              tool: 'get_market_movement',
              eventId: 'nhl-401892752',
              summary: res.summary
            }
          ]
        }
      ],
      'event_id=nhl-401892752 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | options: R4 Seattle Kraken ML (-166)'
    );

    expect(digest).toContain('EVENT nhl-401892752');
    expect(digest).toContain('ml_home Seattle Kraken -166');
  });

  it('(3) checkRowSideBinding and auditMarketCoverageAndRowBinding reject Anaheim Ducks +1.5 on R48 (Colorado Avalanche -1.5) and true missing ML', () => {
    const board = [
      'event_id=nhl-401892752 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R3 Seattle Kraken -1.5 (+150), R4 Seattle Kraken ML (-166)',
      'event_id=nhl-401892760 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-19T02:00:00Z | options: R47 Anaheim Ducks +1.5 (-130), R48 Colorado Avalanche -1.5 (+110)'
    ].join('\n');

    const rowMap = extractRowOptions([board]);
    const r48 = rowMap.get('R48');
    expect(r48).toBeDefined();
    expect(checkRowSideBinding('R48', 'Anaheim Ducks +1.5', r48!).valid).toBe(false);
    expect(checkRowSideBinding('R48', 'Colorado Avalanche -1.5', r48!).valid).toBe(true);
    expect(checkRowSideBinding('R48', 'Colorado Avalanche +1.5', r48!).valid).toBe(false);

    // Misassigned R48 fails audit
    const mismatchAudit = auditMarketCoverageAndRowBinding(
      {
        picks: [
          { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml' },
          { row: 'R48', event_id: 'nhl-401892760', side: 'Anaheim Ducks +1.5', market: 'spread' }
        ]
      },
      '',
      board,
      undefined,
      [
        {
          tool: 'get_market_movement',
          eventId: 'nhl-401892752',
          data: { latest: { total: 6.5, spread: -1.5, ml_home: -166 } },
          markets_covered: ['spread', 'total', 'ml']
        }
      ]
    );
    expect(mismatchAudit.pass).toBe(false);
    expect(mismatchAudit.flags).toContain('row_side_mismatch');
    expect(mismatchAudit.feedback).toContain('R48');
    expect(mismatchAudit.feedback).toContain('Colorado Avalanche -1.5');

    // True missing moneyline fails audit when neither tool nor board has ML
    const noMlBoard =
      'event_id=nhl-999 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | options: R3 Seattle Kraken -1.5 (+150)';
    const missingMlAudit = auditMarketCoverageAndRowBinding(
      {
        picks: [{ row: 'R3', event_id: 'nhl-999', side: 'Seattle Kraken ML', market: 'ml' }]
      },
      '[MARKET MOVEMENT: nhl-999] spread home -1.5 | Total: 6.5',
      noMlBoard,
      undefined,
      [
        {
          tool: 'get_market_movement',
          eventId: 'nhl-999',
          data: { latest: { total: 6.5, spread: -1.5, ml_home: null, ml_away: null } },
          markets_covered: ['spread', 'total']
        }
      ]
    );
    expect(missingMlAudit.pass).toBe(false);
  });

  it('(4) Lifecycle verification fails row mismatch R48=Anaheim +1.5 and recovers false-negative ML rejection when ml_home (-166) is returned', async () => {
    const board = [
      'event_id=nhl-401892752 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R3 Seattle Kraken -1.5 (+150), R4 Seattle Kraken ML (-166)',
      'event_id=nhl-401892760 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-19T02:00:00Z | options: R47 Anaheim Ducks +1.5 (-130), R48 Colorado Avalanche -1.5 (+110)'
    ].join('\n');

    const fetchFn: any = vi.fn(async (_url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.game_id || body.p_game_id;
      if (gId === 'nhl-401892752') {
        return new Response(
          JSON.stringify({
            game_id: 'nhl-401892752',
            opening: { total: 6.5, spread: -1.5, ml_home: -170 },
            latest: { total: 6.5, spread: -1.5, ml_home: -166 },
            line_snapshots: [{ ml_home: -170, spread: -1.5, total: 6.5 }]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          game_id: 'nhl-401892760',
          opening: { total: 6.5, spread: -1.5, ml_home: -220 },
          latest: { total: 6.5, spread: -1.5, ml_home: -215 }
        }),
        { status: 200 }
      );
    });

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
        summary: `[INJURY & ROSTER DELTA: ${game_id}] No major injuries reported.`
      }))
    };
    const registry = new ToolRegistry([marketTool as any, injuryTool as any]);

    // A: Seattle Kraken ML (R4) survives even if LLM Critic falsely claims "only shows a spread market for the game"
    const mlProposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async () =>
        JSON.stringify({
          summary: '2-leg NHL parlay: Seattle Kraken ML (R4) paired with Colorado Avalanche -1.5 (R48).',
          picks: [
            { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', reason: 'ml_home -166 value' },
            { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', reason: 'Puckline -1.5' }
          ]
        })
      )
    };
    const buggyMlCritic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi.fn(async () =>
        JSON.stringify({
          pass: false,
          feedback: 'Seattle Kraken ML (R4) failed: tool output only shows a spread market for the game nhl-401892752.'
        })
      )
    };

    const okLifecycle = await new AnalysisLifecycle(mlProposer, buggyMlCritic, 1, {
      toolRegistry: registry,
      queryCache: new GameQueryCache()
    }).executeAndVerify(
      { rawBoard: board, fullBoard: board, analystReports: '[Market] Seattle ML (R4) & Colorado -1.5 (R48)' },
      new SwarmContext(),
      'Compile 2-leg NHL parlay',
      'Verify 2-leg NHL parlay'
    );
    expect(okLifecycle.success).toBe(true);
    expect(okLifecycle.finalProposal.picks).toHaveLength(2);

    // B: Mismatched row (R48 assigned to Anaheim Ducks +1.5) fails even if LLM Critic approves
    const badRowProposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async () =>
        JSON.stringify({
          summary: '2-leg NHL parlay: Seattle Kraken ML (R4) and Anaheim Ducks +1.5 (R48).',
          picks: [
            { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml' },
            { row: 'R48', event_id: 'nhl-401892760', side: 'Anaheim Ducks +1.5', market: 'spread' }
          ]
        })
      )
    };
    const permissiveCritic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'Looks fine.' }))
    };

    const badLifecycle = await new AnalysisLifecycle(badRowProposer, permissiveCritic, 1, {
      toolRegistry: registry,
      queryCache: new GameQueryCache()
    }).executeAndVerify(
      { rawBoard: board, fullBoard: board, analystReports: '[Quant] Seattle ML (R4), Anaheim +1.5 (R48)' },
      new SwarmContext(),
      'Compile 2-leg NHL parlay',
      'Verify 2-leg NHL parlay'
    );
    expect(badLifecycle.success).toBe(false);
    expect(badLifecycle.criticFeedback).toContain('R48');
    expect(badLifecycle.criticFeedback).toContain('Colorado Avalanche -1.5');
  });

  it('(5) End-to-end parlay workflow with NHL ML (R4) + spread (R48) passes when ml_home is present and row IDs match sides', async () => {
    const slate = [
      'event_id=nhl-401892752 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R3 Seattle Kraken -1.5 (+150), R4 Seattle Kraken ML (-166)',
      'event_id=nhl-401892760 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-19T02:00:00Z | options: R47 Anaheim Ducks +1.5 (-130), R48 Colorado Avalanche -1.5 (+110)'
    ].join('\n');

    const fetchFn: any = vi.fn(async (_url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.game_id || body.p_game_id;
      if (gId === 'nhl-401892752') {
        return new Response(
          JSON.stringify({
            game_id: 'nhl-401892752',
            opening: { total: 6.5, spread: -1.5, ml_home: -170 },
            latest: { total: 6.5, spread: -1.5, ml_home: -166 },
            line_snapshots: [{ ml_home: -170, spread: -1.5, total: 6.5 }]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          game_id: 'nhl-401892760',
          opening: { total: 6.5, spread: -1.5, ml_home: -220 },
          latest: { total: 6.5, spread: -1.5, ml_home: -215 }
        }),
        { status: 200 }
      );
    });

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
        summary: `[MATCHUP FUNDAMENTALS: ${game_id}] Home side holds 5v5 xGF% edge.`
      }))
    };

    const registry = new ToolRegistry([marketTool as any, injuryTool as any, fundamentalsTool as any]);
    let marketPrompt = '';
    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis: 'Quant backs R4 Seattle Kraken ML and R48 Colorado Avalanche -1.5.',
          picks: [
            { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', confidence: 71 },
            { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', confidence: 69 }
          ],
          scorecards: []
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        marketPrompt = prompt;
        return JSON.stringify({
          analysis: 'Market confirms ml_home -166 for R4 Seattle Kraken ML and R48 Colorado Avalanche -1.5.',
          picks: [
            { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', confidence: 72 },
            { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', confidence: 68 }
          ],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({
          pass: true,
          feedback: 'Verified: Seattle Kraken ML covered by ml_home -166 and R48 matches Colorado Avalanche -1.5.',
          verdict: 'Verified',
          flags: []
        });
      }
      return JSON.stringify({
        ui_title: '2-Leg NHL Parlay',
        pass: true,
        summary:
          'Bottom-line call: back R4 Seattle Kraken ML (-166) and R48 Colorado Avalanche -1.5 (+110). Both specialists align on Seattle ML with ml_home -166 supported by 5v5 xGF% and Colorado -1.5 puckline. The call flips if Seattle drops a top-six forward.',
        picks: [
          { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML', market: 'ml', confidence: 72 },
          { row: 'R48', event_id: 'nhl-401892760', side: 'Colorado Avalanche -1.5', market: 'spread', confidence: 69 }
        ],
        components: []
      });
    });

    try {
      const res = await executeSwarmWorkflow({
        task: 'Build a 2-leg NHL parlay with a moneyline and a spread.',
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

      expect(marketPrompt).toContain('ml_home Seattle Kraken -166');
      expect(res.finalAnalysis.verified).toBe(true);
      expect(res.finalAnalysis.pass).toBe(true);
      expect(res.finalAnalysis.picks).toHaveLength(2);
      expect(res.finalAnalysis.picks[0]).toMatchObject({ row: 'R4', side: 'Seattle Kraken ML' });
      expect(res.finalAnalysis.picks[1]).toMatchObject({ row: 'R48', side: 'Colorado Avalanche -1.5' });
    } finally {
      runSpy.mockRestore();
    }
  });
});
