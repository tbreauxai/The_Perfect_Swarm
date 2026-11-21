import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { auditPullBeforePass, sanitizePullBeforePassClaims } from '../swarm/tools/pullBeforePass.ts';
import {
  clearRunDebugRecords,
  getRunDebugRecord,
  recordRunDebugSeat
} from '../swarm/engine/runDebugRecord.ts';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';

describe('runNov20i repros (wf-1795218684791)', () => {
  const origDebug = process.env.SWARM_RUN_DEBUG;

  beforeEach(() => {
    clearRunDebugRecords();
    delete process.env.SWARM_RUN_DEBUG;
  });

  afterEach(() => {
    clearRunDebugRecords();
    if (origDebug === undefined) delete process.env.SWARM_RUN_DEBUG;
    else process.env.SWARM_RUN_DEBUG = origDebug;
  });

  it('Q: pullBeforePass matches fetched/pulled/retrieved in FUNDAMENTALS_MOD and MARKET_MOD', () => {
    const board = 'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: Orlando Magic ML -210';
    const headers = parseGameHeaders(board);
    const trace: any[] = [
      { tool: 'get_matchup_fundamentals', eventId: 'nba-401909306', status: 'data', summary: 'form ok' },
      { tool: 'get_market_movement', eventId: 'nba-401909306', status: 'data', summary: 'ml_home=175, ml_away=-210' }
    ];

    const res = auditPullBeforePass(
      { summary: 'Passing on Orlando Magic @ Brooklyn Nets because there is no fetched market data and no pulled fundamentals.' },
      'form ok | ml_home=175, ml_away=-210',
      board,
      { headers, toolCallTrace: trace }
    );
    expect(res.pass).toBe(false);

    const report = {
      summary: 'Magic look strong, without retrieved market movement.'
    };
    sanitizePullBeforePassClaims(report, 'form ok | ml_home=175, ml_away=-210', board, { headers, toolCallTrace: trace });
    expect(report.summary).not.toMatch(/retrieved market movement/i);
  });

  it('R: recordRunDebugSeat stores headerChars, headerBudget, and pricedHeaders', () => {
    process.env.SWARM_RUN_DEBUG = '1';
    recordRunDebugSeat('wf-r', 'a1', {
      role: 'Quant Proposer',
      provider: 'nvidia',
      promptChars: 3200,
      limitChars: 14000,
      headerChars: 2100,
      headerBudget: 2400,
      pricedHeaders: 12
    });
    const rec = getRunDebugRecord('wf-r');
    expect((rec?.seats.a1 as any)?.headerChars).toBe(2100);
    expect((rec?.seats.a1 as any)?.headerBudget).toBe(2400);
    expect((rec?.seats.a1 as any)?.pricedHeaders).toBe(12);
  });

  it('S1: non-groq Quant frontrunner prefetches all 15 games on a 15-game slate', async () => {
    const gameIds = Array.from({ length: 15 }, (_, i) => `nba-${i + 1}`);
    const fundCalls: string[] = [];
    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'fund',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          fundCalls.push(game_id);
          return { success: true, summary: `fund:${game_id}` };
        })
      }
    ]);
    const agent: any = {
      id: 'a1',
      role: 'Quant Proposer',
      provider: 'nvidia',
      run: vi.fn(async () => JSON.stringify({ summary: 'ok', picks: [] }))
    };

    await runSeatWithTools({
      agent,
      seat: 'a1',
      prompt: 'Analyze slate',
      gameIds,
      registry
    });

    expect(fundCalls).toHaveLength(15);
  });

  it('S2: non-groq Market frontrunner prefetches all 15 games on a 15-game slate', async () => {
    const gameIds = Array.from({ length: 15 }, (_, i) => `nba-${i + 1}`);
    const mktCalls: string[] = [];
    const registry = new ToolRegistry([
      {
        name: 'get_market_movement',
        description: 'mkt',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          mktCalls.push(game_id);
          return { success: true, summary: `mkt:${game_id}` };
        })
      }
    ]);
    const agent: any = {
      id: 'a2',
      role: 'Market Proposer',
      provider: 'cloudflare',
      run: vi.fn(async () => JSON.stringify({ summary: 'ok', picks: [] }))
    };

    await runSeatWithTools({
      agent,
      seat: 'a2',
      prompt: 'Analyze slate',
      gameIds,
      registry
    });

    expect(mktCalls).toHaveLength(15);
  });

  it('S3: groq seats still respect groq maxToolCalls=6 cap', async () => {
    const gameIds = Array.from({ length: 15 }, (_, i) => `nba-${i + 1}`);
    const fundCalls: string[] = [];
    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'fund',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          fundCalls.push(game_id);
          return { success: true, summary: `fund:${game_id}` };
        })
      }
    ]);
    const agent: any = {
      id: 'a1',
      role: 'Quant Proposer',
      provider: 'groq',
      run: vi.fn(async () => JSON.stringify({ summary: 'ok', picks: [] }))
    };

    await runSeatWithTools({
      agent,
      seat: 'a1',
      prompt: 'Analyze slate',
      gameIds,
      registry
    });

    expect(fundCalls).toHaveLength(6);
  });
});
