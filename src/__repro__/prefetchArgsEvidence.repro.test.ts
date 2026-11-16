import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { createAnalystExecutor } from '../swarm/engine/analystExecution.ts';
import { SwarmContext } from '../swarm/context.ts';
import { guardAnalystResponse, guardManagerResponse } from '../swarm/parser/responseGuards.ts';

describe('prefetchArgsEvidence repro (A-D)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(A) Market prefetch always passes market_type across a 6-game slate and does not return invalid_market_type', async () => {
    const marketCalls: Array<{ game_id?: string; market_type?: string }> = [];
    const mktTool = {
      name: 'get_market_movement',
      description: 'Market movement',
      parameters: {
        game_id: { type: 'string' as const, description: 'Game ID', required: true },
        market_type: { type: 'string' as const, description: 'Market type', required: true }
      },
      execute: vi.fn(async (args: any) => {
        if (!args?.market_type) {
          return { success: false, error: 'invalid_market_type', summary: 'Error: Missing market_type' };
        }
        marketCalls.push({ game_id: args.game_id, market_type: args.market_type });
        return { success: true, summary: `FanDuel ${args.game_id} (${args.market_type}): -110 / +150` };
      })
    };
    const registry = new ToolRegistry([mktTool]);
    const games = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];

    const mockMarketAgent: any = {
      id: 'a2',
      role: 'a2',
      provider: 'openrouter',
      run: vi.fn(async () => JSON.stringify({ insights: ['Market line moved'], anomalies: [], summary: 'Market done' }))
    };

    const res = await runSeatWithTools({
      agent: mockMarketAgent,
      seat: 'a2',
      prompt: 'Check 6-game market movement',
      gameIds: games,
      marketType: 'spreads',
      registry
    });

    expect(marketCalls).toHaveLength(6);
    expect(marketCalls.every(c => c.market_type === 'spread')).toBe(true);
    expect(res.coveredEventIds).toEqual(games);
    expect(res.toolEvidence).toContain('FanDuel G1 (spread): -110 / +150');

    // Default fallback to 'all' when no marketType provided
    marketCalls.length = 0;
    await runSeatWithTools({
      agent: mockMarketAgent,
      seat: 'a2',
      prompt: 'Check 1-game market movement',
      gameIds: ['G1'],
      registry
    });
    expect(marketCalls).toEqual([{ game_id: 'G1', market_type: 'all' }]);
  });

  it('(B) 6-game game-line Quant prefetch skips prop splits, covers all 6 fundamentals, and uses real prop keys when provided', async () => {
    const fundCalls: string[] = [];
    const propCalls: any[] = [];
    const injuryCalls: string[] = [];

    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'Fundamentals',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          fundCalls.push(game_id);
          return { success: true, summary: `fund:${game_id}` };
        })
      },
      {
        name: 'get_player_prop_splits',
        description: 'Prop splits',
        parameters: {
          game_id: { type: 'string', description: 'Game ID', required: true },
          player_id: { type: 'string', description: 'Player ID', required: true },
          stat_category: { type: 'string', description: 'Stat category', required: true }
        },
        execute: vi.fn(async (args: any) => {
          if (!args?.player_id) {
            return { success: false, error: 'invalid_player_id', summary: 'Error: Missing player_id' };
          }
          propCalls.push(args);
          return { success: true, summary: `prop:${args.player_id}:${args.stat_category}` };
        })
      },
      {
        name: 'get_injury_and_roster_delta',
        description: 'Injuries',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          injuryCalls.push(game_id);
          return { success: true, summary: `inj:${game_id}` };
        })
      }
    ]);

    const games = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
    const mockQuantAgent: any = {
      id: 'a1',
      role: 'a1',
      provider: 'openrouter', // maxToolCalls = 8
      run: vi.fn(async () => JSON.stringify({ insights: ['Quant done'], anomalies: [], summary: 'Quant done' }))
    };

    const res = await runSeatWithTools({
      agent: mockQuantAgent,
      seat: 'a1',
      prompt: 'Analyze 6 games',
      gameIds: games,
      registry
    });

    expect(propCalls).toHaveLength(0);
    expect(injuryCalls).toEqual([]);
    expect(fundCalls).toEqual(games);
    expect(res.coveredEventIds).toEqual(games);

    // When real player_id + stat_category are known from slate prop rows, prop splits may be prefetched
    fundCalls.length = 0;
    propCalls.length = 0;
    injuryCalls.length = 0;

    await runSeatWithTools({
      agent: mockQuantAgent,
      seat: 'a1',
      prompt: 'Analyze prop',
      gameIds: ['G1'],
      propParamsByGame: {
        G1: [{ player_id: 'lamar-jackson-8', stat_category: 'passing_yards' }]
      },
      registry
    });

    expect(injuryCalls).toEqual([]);
    expect(fundCalls).toEqual(['G1']);
    expect(propCalls).toEqual([{ game_id: 'G1', player_id: 'lamar-jackson-8', stat_category: 'passing_yards' }]);
  });

  it('(C) Betting-seat prompt includes shared short injury line without raw board', async () => {
    const injuryExecute = vi.fn(async ({ game_id }: any) => ({
      success: true,
      summary: `${game_id}: Lamar Jackson OUT (ankle)`
    }));
    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'Fundamentals',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async ({ game_id }: any) => ({ success: true, summary: `fund:${game_id}` }))
      },
      {
        name: 'get_market_movement',
        description: 'Market movement',
        parameters: {
          game_id: { type: 'string', description: 'Game ID', required: true },
          market_type: { type: 'string', description: 'Market type', required: true }
        },
        execute: vi.fn(async ({ game_id }: any) => ({ success: true, summary: `mkt:${game_id}` }))
      },
      {
        name: 'get_injury_and_roster_delta',
        description: 'Injuries',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: injuryExecute
      }
    ]);

    const slateWithRawBoard = [
      'event_id=BAL@CIN | sport=americanfootball_nfl | BAL @ CIN | options: R1 BAL -4.5 (-110)',
      'RAW ACTIONABLE ODDS TABLE',
      '| id | game | market |',
      '| R1 | BAL@CIN | BAL -4.5 |'
    ].join('\n');

    const capturedPrompts: Record<string, string> = {};
    const makeAnalyst = (id: string, role: string): any => ({
      id,
      role,
      provider: 'groq',
      modelName: 'test-model',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async (prompt: string) => {
        capturedPrompts[id] = prompt;
        return JSON.stringify({ insights: [`${id} insight`], anomalies: [], summary: `${id} summary` });
      })
    });

    const quant = makeAnalyst('a1', 'a1');
    const market = makeAnalyst('a2', 'a2');
    const context = new SwarmContext();

    const executeAnalyst = createAnalystExecutor({
      task: 'Analyze BAL @ CIN',
      chunks: [slateWithRawBoard],
      profile: {},
      historicalContext: '',
      targetAppId: 'duelodds',
      context,
      toolRegistry: registry,
      analystClusterMap: new Map(),
      bypassCache: true
    });

    await Promise.all([
      executeAnalyst(quant, slateWithRawBoard, 0),
      executeAnalyst(market, slateWithRawBoard, 0)
    ]);

    // Shared pre-seat prefetch + GameQueryCache prevents duplicate injury calls across seats
    expect(injuryExecute).toHaveBeenCalledTimes(1);

    for (const seatId of ['a1', 'a2']) {
      expect(capturedPrompts[seatId]).toContain('Injury evidence:');
      expect(capturedPrompts[seatId]).toContain('Lamar Jackson OUT (ankle)');
      expect(capturedPrompts[seatId]).not.toContain('RAW ACTIONABLE ODDS TABLE');
    }
  });

  it('(D) guardAnalystResponse and guardManagerResponse strip ~65% and ~+650 while keeping real toolEvidence', () => {
    const guardedAnalyst = guardAnalystResponse(
      JSON.stringify({
        insights: ['Ravens -4.5 (~65%, ~+650) vs Bengals', 'Market payout about +650 with ~= 65% edge'],
        anomalies: ['Approximate ~= +650 outlier'],
        summary: 'Pick Ravens -4.5 (~65%, ~+650) based on pace.'
      }),
      'Quant'
    );

    expect(guardedAnalyst.insights[0]).not.toContain('~65%');
    expect(guardedAnalyst.insights[0]).not.toContain('~+650');
    expect(guardedAnalyst.insights[0]).not.toContain('-110');
    expect(guardedAnalyst.insights[1]).not.toContain('about +650');
    expect(guardedAnalyst.insights[1]).not.toContain('~=');
    expect(guardedAnalyst.summary).not.toContain('~65%');
    expect(guardedAnalyst.summary).not.toContain('~+650');
    expect(guardedAnalyst.summary).toContain('Ravens -4.5');

    const guardedManager = guardManagerResponse(
      JSON.stringify({
        ui_title: 'Slate Summary',
        summary: 'Lean Ravens -4.5 (~65%, ~+650); real FanDuel -110 / +150 confirmed.',
        components: [
          {
            id: 'ins-1',
            type: 'InsightList',
            props: {
              title: 'Findings',
              insights: [{ type: 'info', message: 'Edge ~65% at about +650' }]
            }
          }
        ]
      }),
      'Manager'
    );

    expect(guardedManager.summary).not.toContain('~65%');
    expect(guardedManager.summary).not.toContain('~+650');
    expect(guardedManager.summary).toContain('FanDuel -110 / +150');
    const insComp = guardedManager.components[0] as any;
    expect(insComp.props.insights[0].message).not.toContain('~65%');
    expect(insComp.props.insights[0].message).not.toContain('about +650');
  });
});
