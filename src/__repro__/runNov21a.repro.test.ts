import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { isCanonicalOrHexId, getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { proposerHeaderBudget } from '../swarm/engine/analystExecution.ts';
import { handleSwarmSse } from '../swarm/server/streaming.ts';

describe('runNov21a repros (wf-1795244009898)', () => {
  const origUrl = process.env.SUPABASE_URL;
  const origPub = process.env.SUPABASE_PUBLISHABLE_KEY;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'anon-pub-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origPub === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = origPub;
  });

  it('A: isCanonicalOrHexId accepts multi-segment college-* IDs and 32-hex IDs', () => {
    expect(isCanonicalOrHexId('college-football-401871101')).toBe(true);
    expect(isCanonicalOrHexId('college-basketball-401900123')).toBe(true);
    expect(isCanonicalOrHexId('nba-401909306')).toBe(true);
    expect(isCanonicalOrHexId('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isCanonicalOrHexId('not-a-game-id')).toBe(false);
  });

  it('A2: getInjuryAndRosterDeltaTool returns success/empty (not unresolved_game_id) for empty college-football feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ injuries: [], source: 'empty', empty: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));

    const res: any = await getInjuryAndRosterDeltaTool.execute({ game_id: 'college-football-401871101' });
    expect(res.success).toBe(true);
    expect(res.error).not.toBe('unresolved_game_id');
  });

  it('B: seatToolLoop executeCalls limits concurrent in-flight tool calls via 4-worker pool', async () => {
    const gameIds = Array.from({ length: 17 }, (_, i) => `college-football-4018711${String(i).padStart(2, '0')}`);
    let inFlight = 0;
    let maxInFlight = 0;

    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'fund',
        parameters: { game_id: { type: 'string', description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise(r => setTimeout(r, 15));
          inFlight--;
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
      prompt: 'Analyze 17 CFB games',
      gameIds,
      registry
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThanOrEqual(1);
  });

  it('C: proposerHeaderBudget scales with provider-aware seatBudget while keeping groq at 1680', () => {
    expect(proposerHeaderBudget('openrouter')).toBe(6600);
    expect(proposerHeaderBudget('nvidia')).toBe(8400);
    expect(proposerHeaderBudget('groq')).toBe(1680);
  });

  it('D: handleSwarmSse emits swarm_started with workflowId before calling workflowExecutor', async () => {
    const app = new Hono();
    let seenContextId: string | undefined;

    app.post('/sse', async (c) => {
      return handleSwarmSse(c, {
        task: 'Test SSE',
        workflowExecutor: async (p: any) => {
          seenContextId = p.context?.id;
          return { workflowId: seenContextId, finalAnalysis: { summary: 'done' }, events: [] };
        }
      } as any);
    });

    const res = await app.request('/sse', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('event: swarm_started');
    expect(seenContextId).toMatch(/^wf-\d+$/);
    expect(body).toContain(seenContextId!);
  });
});
