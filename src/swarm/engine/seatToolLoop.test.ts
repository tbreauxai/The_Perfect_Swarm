import { describe, it, expect, vi } from 'vitest';
import { runSeatWithTools, getRoleToolNames } from './seatToolLoop.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { SwarmTool } from '../tools/types.ts';

function createMockTool(name: string, summary: string = `[${name} summary]`): SwarmTool {
  return {
    name,
    description: `Mock tool ${name}`,
    parameters: {
      game_id: { type: 'string', description: 'Game ID', required: true }
    },
    execute: vi.fn(async () => ({ success: true, summary }))
  };
}

describe('Seat Tool Loop (PS2 Role-Scoped 2-Round Execution)', () => {
  it('correctly maps seat roles to tools', () => {
    expect(getRoleToolNames('a1')).toEqual(['get_matchup_fundamentals', 'get_player_prop_splits']);
    expect(getRoleToolNames('a2')).toEqual(['get_market_movement']);
    expect(getRoleToolNames('critic')).toEqual(['get_injury_and_roster_delta', 'get_environment_and_weather']);
  });

  it('completes in 1 round when Round 1 emits no tool calls', async () => {
    const registry = new ToolRegistry([createMockTool('get_matchup_fundamentals')]);
    const mockAgent: any = {
      provider: 'groq',
      run: vi.fn(async () => 'Final report without tool calls.')
    };

    const res = await runSeatWithTools({
      agent: mockAgent,
      seat: 'a1',
      prompt: 'Analyze KC vs BUF',
      registry
    });

    expect(res.rounds).toBe(1);
    expect(res.report).toBe('Final report without tool calls.');
    expect(res.toolCallsExecuted).toHaveLength(0);
    expect(mockAgent.run).toHaveBeenCalledTimes(1);
  });

  it('executes tools and feeds results into Round 2 (2 rounds max)', async () => {
    const registry = new ToolRegistry([createMockTool('get_market_movement', 'Market delta: -1.0')]);
    const mockAgent: any = {
      provider: 'groq',
      run: vi
        .fn()
        .mockResolvedValueOnce('[TOOL_CALL:{"tool":"get_market_movement","parameters":{"game_id":"nfl-123"}}]')
        .mockResolvedValueOnce('Analysis based on market movement: Home steam detected.')
    };

    const events: string[] = [];
    const mockContext: any = {
      addEvent: (evt: string) => events.push(evt)
    };

    const res = await runSeatWithTools({
      agent: mockAgent,
      seat: 'a2',
      prompt: 'Check market movement for nfl-123',
      registry,
      context: mockContext
    });

    expect(res.rounds).toBe(2);
    expect(res.report).toContain('Analysis based on market movement');
    expect(res.toolCallsExecuted).toEqual(['get_market_movement']);
    expect(events).toContain('Executed Tool: get_market_movement');
    expect(mockAgent.run).toHaveBeenCalledTimes(2);

    // Verify round 2 call received tool results
    const secondCallPrompt = mockAgent.run.mock.calls[1][0];
    expect(secondCallPrompt).toContain('Tool results:');
    expect(secondCallPrompt).toContain('Market delta: -1.0');
  });

  it('falls back to prefetch on Groq native tool 400 rejection', async () => {
    const registry = new ToolRegistry([createMockTool('get_market_movement', 'Prefetched movement: -2.5')]);
    const mockAgent: any = {
      provider: 'groq',
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('Groq 400 Bad Request: tool_use_failed'))
        .mockResolvedValueOnce('Report using prefetched tool results.')
    };

    const res = await runSeatWithTools({
      agent: mockAgent,
      seat: 'custom_analyst',
      prompt: 'Check market movement for nfl-123',
      gameId: 'nfl-123',
      registry
    });

    expect(res.rounds).toBe(1);
    expect(res.report).toBe('Report using prefetched tool results.');
    expect(res.toolCallsExecuted).toEqual(['get_market_movement']);

    const fallbackPrompt = mockAgent.run.mock.calls[1][0];
    expect(fallbackPrompt).toContain('Prefetched movement: -2.5');
  });

  it('returns toolEvidenceItems for successful calls only and omits errors', async () => {
    const registry = new ToolRegistry([
      {
        name: 'get_injury_and_roster_delta',
        description: 'inj',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => ({ success: true, summary: `inj:${game_id}` }))
      },
      {
        name: 'get_matchup_fundamentals',
        description: 'fund',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: vi.fn(async () => ({ success: false, error: 'timeout', summary: 'Error: timeout' }))
      }
    ]);
    const mockAgent: any = {
      id: 'a1',
      role: 'a1',
      provider: 'openrouter',
      run: vi.fn(async () => JSON.stringify({ insights: ['ok'], summary: 'ok' }))
    };

    const res = await runSeatWithTools({
      agent: mockAgent,
      seat: 'critic',
      prompt: 'Analyze',
      gameIds: ['nba-1', 'nba-2'],
      registry
    });

    expect(res.toolEvidenceItems).toEqual([
      { tool: 'get_injury_and_roster_delta', eventId: 'nba-1', summary: 'inj:nba-1' },
      { tool: 'get_injury_and_roster_delta', eventId: 'nba-2', summary: 'inj:nba-2' }
    ]);
  });
});
