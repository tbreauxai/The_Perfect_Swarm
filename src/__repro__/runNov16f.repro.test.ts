import { describe, it, expect, vi, afterEach } from 'vitest';
import { NvidiaAdapter } from '../swarm/providers/nvidia.ts';
import { extractFuzzyFields } from '../swarm/parser/repairJson.ts';
import { guardAnalystResponse } from '../swarm/parser/responseGuards.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { CRITIC_VERDICT_SYSTEM_INSTRUCTION, MANAGER_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { getMarketMovementTool } from '../swarm/tools/dueloddsRpcTools.ts';

describe('runNov16f repro (S1-S4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('S1: nvidia adapter sends reasoning_effort and response_format for Nemotron Ultra JSON seat', async () => {
    let capturedBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ insights: ['ok'], anomalies: [], summary: 'ok' }) } }]
      }), { status: 200 });
    }));

    const adapter = new NvidiaAdapter();
    await adapter.call({
      apiKey: 'nvapi-test-key',
      modelName: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      prompt: 'Analyze slate',
      config: { responseMimeType: 'application/json' }
    });

    expect(capturedBody.reasoning_effort).toBe('none');
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  it('S2: prose response preserves BOS/BAL/PHI text in guard and verifier digest without unparsed output', () => {
    const prose = 'BOS -8.5, BAL -4.5, PHI -5.5 based on injury edge.';
    expect(extractFuzzyFields(prose)).toBeNull();

    const guarded: any = guardAnalystResponse(prose, 'Quant Proposer');
    expect(guarded.insights[0]).toContain('[Quant Proposer] prose:');
    expect(guarded.insights[0]).toContain('BOS -8.5, BAL -4.5, PHI -5.5');
    expect(guarded.insights[0]).not.toContain('unparsed output');

    const ctx = new SwarmContext();
    const res = compileSynthesisPrompt({
      task: 'Parlay',
      rawInput: 'event_id=nba-1 | sport=nba | ORL @ BOS',
      analysts: [{ id: 'a1', role: 'Quant Proposer', provider: 'gemini' } as any],
      managerAgent: { id: 'mgr', role: 'Manager', provider: 'groq', setSystemInstruction: vi.fn() } as any,
      allAnalystReports: [[prose]],
      clusterDigests: {},
      historicalContext: '',
      context: ctx,
      params: { task: 'Parlay', callerAppId: 'duelodds' } as any,
      bypassCache: true
    });

    expect(res.effectiveCompiledReports).toContain('[Quant Proposer] prose: BOS -8.5, BAL -4.5, PHI -5.5');
    expect(res.effectiveCompiledReports).not.toContain('unparsed output');
  });

  it('S3 & S3b: MANAGER_SYSTEM_INSTRUCTION has no invented figures and App-computed counts appears in manager + verify prompts', async () => {
    expect(MANAGER_SYSTEM_INSTRUCTION).not.toContain('1,420');
    expect(MANAGER_SYSTEM_INSTRUCTION).not.toContain('64.2%');
    expect(MANAGER_SYSTEM_INSTRUCTION).toContain('App-computed counts');

    const ctx = new SwarmContext();
    const res = compileSynthesisPrompt({
      task: 'Best bets',
      rawInput: 'event_id=nba-1 | sport=nba | ORL @ BOS\nevent_id=nba-2 | sport=nba | PHI @ IND',
      analysts: [
        { id: 'a1', role: 'Quant', provider: 'openrouter' } as any,
        { id: 'a2', role: 'Market', provider: 'openrouter' } as any
      ],
      managerAgent: { id: 'mgr', role: 'Manager', provider: 'groq', setSystemInstruction: vi.fn() } as any,
      allAnalystReports: [
        [{ summary: 'BOS edge', insights: ['BOS -8.5'], anomalies: [], coveredEventIds: ['nba-1'], picks: [{ pick: 'BOS -8.5' }] }],
        [{ summary: 'PHI edge', insights: ['PHI -5.5'], anomalies: [], coveredEventIds: ['nba-2'], picks: [{ pick: 'PHI -5.5' }] }]
      ],
      clusterDigests: {},
      historicalContext: '',
      context: ctx,
      params: { task: 'Best bets', callerAppId: 'duelodds' } as any,
      bypassCache: true
    });

    const expectedCounts = 'App-computed counts: games=2, covered=2, picks=2, seats_parsed=2/2';
    expect(res.effectiveDynamicPrompt).toContain(expectedCounts);
    expect(res.appComputedCounts).toBe(expectedCounts);

    let verifyPrompt = '';
    const proposer: any = { role: 'Manager', modelName: 'm', provider: 'openrouter', run: vi.fn(async () => JSON.stringify({ summary: 'ok', picks: [] })) };
    const critic: any = { role: 'Risk Critic', modelName: 'c', provider: 'groq', run: vi.fn(async (p: string) => { verifyPrompt = p; return JSON.stringify({ pass: true, feedback: 'ok' }); }) };
    await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
      { analystReports: res.effectiveCompiledReports, appComputedCounts: res.appComputedCounts },
      new SwarmContext(),
      'Compile',
      'Verify'
    );
    expect(verifyPrompt).toContain(expectedCounts);
    expect(verifyPrompt.length).toBeLessThanOrEqual(5600);
  });

  it('S4: get_market_movement prints home <HOME> +5.5 / away <AWAY> -5.5 without putting +5.5 on away team', async () => {
    const fetchFn: any = vi.fn(async () => new Response(JSON.stringify({
      snapshots_tracked: 1,
      home_team: 'Indiana Pacers',
      away_team: 'Philadelphia 76ers',
      latest: { spread_home: 5.5, price: -110 }
    }), { status: 200 }));
    const res: any = await getMarketMovementTool.execute(
      { game_id: 'nba-401909997', market_type: 'spread' },
      { fetchFn, env: { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon' } }
    );
    expect(res.success).toBe(true);
    expect(res.summary).toContain('home Indiana Pacers +5.5 / away Philadelphia 76ers -5.5');
    expect(res.summary).not.toContain('Philadelphia 76ers +5.5');
  });
});
