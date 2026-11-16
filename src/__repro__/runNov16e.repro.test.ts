import { describe, it, expect, vi } from 'vitest';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { CRITIC_VERDICT_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { guardAnalystResponse } from '../swarm/parser/responseGuards.ts';

describe('runNov16e repro (S1-S5)', () => {
  it('S1: compileSynthesisPrompt produces per-seat digest without toolEvidence or raw JSON blocks', () => {
    const ctx = new SwarmContext();
    const analysts: any[] = [
      { id: 'a1', role: 'Quant', provider: 'openrouter' },
      { id: 'a2', role: 'Market', provider: 'openrouter' }
    ];
    const manager: any = { id: 'mgr', role: 'Manager', provider: 'groq', setSystemInstruction: vi.fn() };
    const res = compileSynthesisPrompt({
      task: 'Analyze NBA slate',
      rawInput: 'event_id=nba-1 | sport=nba | BOS @ NYK',
      analysts,
      managerAgent: manager,
      allAnalystReports: [
        [{ summary: 'BOS edge', insights: ['BOS -4.5'], anomalies: [], toolEvidence: 'RAW_TOOL_EV', toolEvidenceItems: [{ tool: 't', eventId: 'nba-1', summary: 'x' }] }],
        [{ summary: 'Line moved', insights: ['Sharp action BOS'], anomalies: ['a2 steam anomaly'], toolEvidence: 'MKT_EV' }]
      ],
      clusterDigests: {},
      historicalContext: '',
      context: ctx,
      params: { task: 'Analyze NBA slate' } as any,
      bypassCache: true
    });

    expect(res.effectiveCompiledReports).toContain('[Quant] BOS edge | BOS -4.5');
    expect(res.effectiveCompiledReports).toContain('[Market] Line moved | Sharp action BOS | a2 steam anomaly');
    expect(res.effectiveCompiledReports).not.toContain('toolEvidence');
    expect(res.effectiveCompiledReports).not.toContain('{');
  });

  it('S1b: lifecycle reserves digest budget before evidence so a2 anomaly survives at CAP 5600 with 6-game evidence', async () => {
    let verifyPrompt = '';
    const proposer: any = {
      role: 'Manager',
      modelName: 'm',
      provider: 'openrouter',
      run: vi.fn(async () => JSON.stringify({ summary: 'BOS -4.5', picks: [] }))
    };
    const critic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi.fn(async (p: string) => {
        verifyPrompt = p;
        return JSON.stringify({ pass: true, feedback: 'ok' });
      })
    };
    const sixGameEvidence = Array.from({ length: 6 }, (_, i) =>
      `EVENT nba-${401909990 + i} AWAY @ HOME\nINJ: Player ${i}: OUT\nFUND: L10 net +4.5, pace 99.1, ORtg 115.2, DRtg 110.7, rest 2d, home 12-4\nMKT: FanDuel -4.5 / 224.5`
    ).join('\n\n') + '\n' + 'extra '.repeat(350);

    await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
      {
        analystReports: '[Quant] BOS -4.5\n[Market] Line moved | a2 steam anomaly on BOS',
        toolResults: sixGameEvidence
      },
      new SwarmContext(),
      'Compile',
      'Verify'
    );

    expect(verifyPrompt.length).toBeLessThanOrEqual(5600);
    expect(verifyPrompt).toContain('a2 steam anomaly on BOS');
  });

  it('S2 & S5: manager prompt uses union verifierEvidence (Jackson + Banchero OUT) under groq budget and logs telemetry', () => {
    const ctx = new SwarmContext();
    const analysts: any[] = [
      { id: 'a1', role: 'Quant', provider: 'openrouter' },
      { id: 'a2', role: 'Market', provider: 'openrouter' }
    ];
    const manager: any = { id: 'mgr', role: 'Manager', modelName: 'openai/gpt-oss-120b', provider: 'groq', setSystemInstruction: vi.fn() };
    const unionEv = [
      'EVENT nfl-401873065 LAC @ BAL\nINJ: BAL: Lamar Jackson (QB): OUT',
      'EVENT nba-401909994 ORL @ BOS\nINJ: ORL: Paolo Banchero: OUT'
    ].join('\n\n');

    const res = compileSynthesisPrompt({
      task: 'Best parlay today',
      rawInput: 'event_id=nfl-401873065 | sport=nfl | LAC @ BAL\nevent_id=nba-401909994 | sport=nba | ORL @ BOS',
      analysts,
      managerAgent: manager,
      allAnalystReports: [
        [{ summary: 'BAL lean', insights: ['BAL -4.5'], anomalies: [], toolEvidence: 'PER_SEAT_SHOULD_BE_DROPPED' }],
        [{ summary: 'BOS lean', insights: ['BOS -8.5'], anomalies: [], toolEvidence: 'PER_SEAT_MKT' }]
      ],
      clusterDigests: {},
      historicalContext: '',
      context: ctx,
      params: { task: 'Best parlay today', callerAppId: 'duelodds' } as any,
      bypassCache: true,
      verifierEvidence: unionEv
    });

    expect(res.effectiveDynamicPrompt).toContain('Cite only facts present in Game Slate, Tool evidence, or seat summaries.');
    expect(res.effectiveDynamicPrompt).toContain('Lamar Jackson (QB): OUT');
    expect(res.effectiveDynamicPrompt).toContain('Paolo Banchero: OUT');
    expect(res.effectiveDynamicPrompt).not.toContain('PER_SEAT_SHOULD_BE_DROPPED');

    const telemetryEvent = ctx.events.find((e: any) => e.action === 'Manager Synthesis Context');
    expect(telemetryEvent).toBeDefined();
    expect(telemetryEvent?.output).toMatchObject({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      promptChars: res.effectiveDynamicPrompt.length,
      evidenceChars: unionEv.length,
      evidenceDropped: false
    });
  });

  it('S3: critic instruction reviews other seats picks in scope and omits Never propose', () => {
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).not.toMatch(/Never propose/i);
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('proposed picks');
  });

  it('S4: guardAnalystResponse handles single pick-shaped object cleanly without placeholder or "odds":,', () => {
    const raw = JSON.stringify({ event_id: 'nba-401909994', market: 'spreads', selection: 'Boston Celtics -8.5', odds: -106, stake: 0 });
    const g: any = guardAnalystResponse(raw, 'Quant');
    expect(g.picks).toHaveLength(1);
    expect(g.picks[0].odds).toBeUndefined();
    expect(g.picks[0].stake).toBeUndefined();
    expect(g._placeholder).toBeUndefined();
    expect(JSON.stringify(g)).not.toContain('"odds":,');
    expect(g.insights[0]).toContain('Boston Celtics -8.5');
  });
});
