import { describe, it, expect, vi, afterEach } from 'vitest';
import { guardAnalystResponse, isDataRequest } from '../swarm/parser/responseGuards.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';

/**
 * Repro tests for wf-1794798837772 (chat empty output):
 * (A) Bare pick array [{pick:'HOU ML', odds:-150, stake:2}] wraps into a real report with picks and no odds/stake.
 * (B) Llama {type:'function', name, parameters} function-call JSON parses via parseToolCalls and executes tools.
 * (C) Critic "no parlay, insufficient data" remains isDataRequest, and early-exit surfaces critic summary + verdict.
 *
 * Documentation note: Groq 1500 cap in src/swarm/providers/limiter.ts is intentionally left untouched.
 */
describe('chatEmptyOutput repro (inverted post-fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(A) wraps bare pick array into non-placeholder report with picks and strips odds/stake', () => {
    const raw = JSON.stringify([{ pick: 'HOU ML', odds: -150, stake: 2 }]);
    const report = guardAnalystResponse(raw, 'Quant');

    expect((report as any)._placeholder).not.toBe(true);
    expect(report._repaired).toBe(true);
    expect(Array.isArray(report.picks)).toBe(true);
    expect(report.picks).toHaveLength(1);
    expect(report.picks![0]).toEqual({ pick: 'HOU ML' });
    expect('odds' in report.picks![0]).toBe(false);
    expect('stake' in report.picks![0]).toBe(false);
    expect(report.analysis).toContain('HOU ML');
    expect(report.insights.length).toBeGreaterThan(0);
    expect(report.summary).toContain('HOU ML');
    expect(Array.isArray(report.scorecards)).toBe(true);
  });

  it('(B) parses Llama function-call JSON (and _v1 RPC suffix, ignoring "json") and runs tools without placeholdering', async () => {
    const registry = new ToolRegistry([
      {
        name: 'get_market_movement',
        description: 'Fetch market line movement',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async ({ game_id }: { game_id: string }) => ({
          success: true,
          summary: `Market delta for ${game_id}: -1.5 steam`
        }))
      }
    ]);

    const llamaCall = JSON.stringify({
      type: 'function',
      name: 'get_market_movement',
      parameters: { game_id: 'DAL@BOS' }
    });
    const parsed = registry.parseToolCalls(llamaCall);
    expect(parsed).toEqual([
      { tool: 'get_market_movement', parameters: { game_id: 'DAL@BOS' } }
    ]);

    const v1Call = JSON.stringify({
      function: { name: 'get_market_movement_v1', arguments: '{"game_id":"NYK@TOR"}' }
    });
    expect(registry.parseToolCalls(v1Call)).toEqual([
      { tool: 'get_market_movement', parameters: { game_id: 'NYK@TOR' } }
    ]);

    const inventedJsonCall = JSON.stringify({
      type: 'function',
      name: 'json',
      parameters: { summary: 'ignored' }
    });
    expect(registry.parseToolCalls(inventedJsonCall)).toEqual([]);

    const mockAgent: any = {
      id: 'market-1',
      role: 'a2',
      provider: 'groq',
      run: vi
        .fn()
        .mockResolvedValueOnce(llamaCall)
        .mockResolvedValueOnce(
          JSON.stringify({
            insights: ['DAL@BOS line moved -1.5 toward BOS'],
            anomalies: [],
            summary: 'Market steam detected on BOS.'
          })
        )
    };

    const res = await runSeatWithTools({
      agent: mockAgent,
      seat: 'a2',
      prompt: 'Check market movement for DAL@BOS',
      registry
    });

    expect(res.toolCallsExecuted).toEqual(['get_market_movement']);
    const guarded = guardAnalystResponse(res.report, 'Market');
    expect((guarded as any)._placeholder).not.toBe(true);
    expect(guarded.insights[0]).toContain('DAL@BOS');
  });

  it('(C) keeps critic "no parlay, insufficient data" as isDataRequest and surfaces it on early-exit', async () => {
    const criticPayload = {
      insights: ['No parlay: insufficient data on starting lineups'],
      anomalies: [],
      summary: 'No parlay — insufficient data due to missing injury confirmation.',
      verdict: 'no_play'
    };
    expect(isDataRequest(criticPayload)).toBe(true);

    const mockProvider = 'chat-empty-mock';
    ProviderRegistry.register({
      providerName: mockProvider as any,
      call: vi.fn(async ({ role, prompt }: any) => {
        const r = String(role || '').toLowerCase();
        if (r.includes('critic') || r.includes('risk') || prompt.includes('Critic')) {
          return JSON.stringify(criticPayload);
        }
        // Other analyst seats return insufficient-data requests so non-critic seats are empty
        return JSON.stringify({
          insights: ['Need more data for matchup'],
          anomalies: [],
          summary: 'Insufficient data to evaluate.'
        });
      })
    });

    const result = await executeSwarmWorkflow({
      task: 'Evaluate tonight slate for a parlay',
      data: 'event_id=DAL@BOS | sport=basketball_nba | DAL @ BOS',
      forceFullSwarm: true,
      bypassCache: true,
      settings: {
        appId: 'chat-empty-repro',
        agents: [
          { id: 'quant', role: 'Quant Analyst', provider: mockProvider, apiKey: 'k1', modelName: 'm1' },
          { id: 'critic', role: 'Risk Critic', provider: mockProvider, apiKey: 'k2', modelName: 'm2' },
          { id: 'manager', role: 'Manager Node', provider: mockProvider, apiKey: 'k3', modelName: 'm3' }
        ]
      }
    } as any);

    expect(result.finalAnalysis).toBeDefined();
    expect(result.finalAnalysis.ui_title).toBe('Insufficient data');
    expect(result.finalAnalysis.picks).toEqual([]);
    expect(String(result.finalAnalysis.summary || '').toLowerCase()).toContain('no parlay');
    expect(String(result.finalAnalysis.analysis || '').toLowerCase()).toContain('no parlay');
    expect(result.finalAnalysis.critic).toBe('no_play');
  });
});
