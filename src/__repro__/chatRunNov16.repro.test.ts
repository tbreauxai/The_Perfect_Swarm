import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { guardAnalystResponse } from '../swarm/parser/responseGuards.ts';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import { SwarmContext } from '../swarm/context.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { seatBudget } from '../swarm/context/promptBudget.ts';

describe('chatRunNov16 repro (inverted post-fix S1-S5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(S1) returns toolEvidence with 49.5, drops Discard raw values, and passes toolEvidence to manager and verifier', async () => {
    expect(ANALYST_SYSTEM_INSTRUCTION).not.toContain('Discard raw values');

    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'Matchup fundamentals',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: vi.fn(async () => ({
          success: true,
          summary: 'Projected total 49.5; pace +2.1'
        }))
      }
    ]);

    const mockAgent: any = {
      id: 'quant-1',
      role: 'a1',
      provider: 'openrouter',
      run: vi.fn(async () =>
        JSON.stringify({
          insights: ['Total leans over based on 49.5 projection'],
          anomalies: [],
          summary: 'Quant favors over at 49.5.'
        })
      )
    };

    const seatRes = await runSeatWithTools({
      agent: mockAgent,
      seat: 'a1',
      prompt: 'Analyze game-1',
      gameIds: ['game-1'],
      registry
    });

    expect(seatRes.toolEvidence).toContain('49.5');

    const context = new SwarmContext();
    const mockManager: any = {
      id: 'mgr',
      role: 'Manager Node',
      provider: 'openrouter',
      setSystemInstruction: vi.fn(),
      run: vi.fn()
    };
    const analysts: any[] = [{ id: 'quant-1', role: 'a1', provider: 'openrouter' }];
    const synthesis = compileSynthesisPrompt({
      task: 'Analyze game-1',
      rawInput: 'event_id=game-1 | sport=nfl | KC @ BUF',
      analysts,
      managerAgent: mockManager,
      allAnalystReports: [[{
        insights: ['Over 49.5'],
        anomalies: [],
        summary: 'Quant favors over.',
        toolEvidence: seatRes.toolEvidence
      }]],
      clusterDigests: {},
      historicalContext: '',
      context,
      params: { task: 'Analyze game-1', data: 'event_id=game-1 | sport=nfl | KC @ BUF', appId: 'duelodds' } as any,
      bypassCache: true
    });

    expect(synthesis.effectiveDynamicPrompt).toContain('Tool evidence:');
    expect(synthesis.effectiveDynamicPrompt).toContain('49.5');
    expect(synthesis.effectiveDynamicPrompt.length).toBeLessThanOrEqual(seatBudget('openrouter').maxPromptChars);

    const execSpy = vi.spyOn(AnalysisLifecycle.prototype, 'executeAndVerify').mockResolvedValue({
      finalProposal: { ui_title: 'Verified', summary: 'Verified total 49.5', components: [], picks: [] },
      success: true,
      attempts: 1,
      computedRating: 9
    } as any);

    const mockCritic: any = {
      id: 'critic',
      role: 'critic',
      provider: 'openrouter',
      setSystemInstruction: vi.fn(),
      run: vi.fn()
    };

    await runDeepAnalysisVerification({
      task: 'Analyze game-1',
      rawInput: 'event_id=game-1 | sport=nfl | KC @ BUF',
      effectiveDynamicPrompt: synthesis.effectiveDynamicPrompt,
      effectiveCompiledReports: synthesis.effectiveCompiledReports,
      effectiveHistoricalContext: '',
      managerAgent: mockManager,
      analysts,
      dedicatedCriticAgent: mockCritic,
      context,
      toolResults: seatRes.toolEvidence
    });

    expect(execSpy).toHaveBeenCalledTimes(1);
    const passedRawData = execSpy.mock.calls[0][0] as any;
    expect(passedRawData.toolResults).toContain('49.5');
  });

  it('(S2) omits get_historical_lessons and get_game_context, and prefetches all 3 games for a1/a2 on OpenRouter', async () => {
    expect(ANALYST_SYSTEM_INSTRUCTION).not.toContain('get_game_context');
    expect(RED_TEAM_ANALYST_SYSTEM_INSTRUCTION).not.toContain('get_game_context');
    expect(MANAGER_SYSTEM_INSTRUCTION).not.toContain('get_game_context');

    const histSpy = vi.fn(async () => ({ success: true, summary: 'lesson' }));
    const fundSpy = vi.fn(async ({ game_id }: any) => ({ success: true, summary: `fund:${game_id}` }));
    const propSpy = vi.fn(async ({ game_id }: any) => ({ success: true, summary: `prop:${game_id}` }));
    const mktSpy = vi.fn(async ({ game_id }: any) => ({ success: true, summary: `mkt:${game_id}` }));

    const registry = new ToolRegistry([
      {
        name: 'get_historical_lessons',
        description: 'Lessons',
        parameters: {},
        execute: histSpy
      },
      {
        name: 'get_matchup_fundamentals',
        description: 'Fundamentals',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: fundSpy
      },
      {
        name: 'get_player_prop_splits',
        description: 'Prop splits',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: propSpy
      },
      {
        name: 'get_market_movement',
        description: 'Market movement',
        parameters: { game_id: { type: 'string', description: 'Game ID', required: true } },
        execute: mktSpy
      }
    ]);

    const games = ['GAME-1', 'GAME-2', 'GAME-3'];

    const a1Agent: any = {
      id: 'quant',
      role: 'a1',
      provider: 'openrouter',
      run: vi.fn(async () => 'Quant done')
    };
    const a1Res = await runSeatWithTools({
      agent: a1Agent,
      seat: 'a1',
      prompt: 'Analyze 3 games',
      gameIds: games,
      registry
    });
    expect(histSpy).not.toHaveBeenCalled();
    expect(a1Res.toolCallsExecuted).not.toContain('get_historical_lessons');
    expect(a1Res.coveredEventIds).toEqual(games);

    const a2Agent: any = {
      id: 'market',
      role: 'a2',
      provider: 'openrouter',
      run: vi.fn(async () => 'Market done')
    };
    const a2Res = await runSeatWithTools({
      agent: a2Agent,
      seat: 'a2',
      prompt: 'Analyze 3 games',
      gameIds: games,
      registry
    });
    expect(histSpy).not.toHaveBeenCalled();
    expect(a2Res.coveredEventIds).toEqual(games);
    expect(mktSpy).toHaveBeenCalledTimes(3);
  });

  it('(S3) rejects critic parlay arrays with no picks and accepts {pass, verdict, flags}', () => {
    const parlayArray = JSON.stringify([{ pick: 'HOU ML', odds: -150, stake: 2 }]);
    const rejected = guardAnalystResponse(parlayArray, 'Risk Critic');

    expect(rejected.picks).toBeUndefined();
    expect(rejected._placeholder).toBe(true);
    expect(rejected.pass).toBe(false);
    expect(rejected.verdict).toBe('contract_violation');

    const missingPass = JSON.stringify({ verdict: 'Looks good', flags: [] });
    const rejectedMissingPass = guardAnalystResponse(missingPass, 'Risk Critic');
    expect(rejectedMissingPass._placeholder).toBe(true);
    expect(rejectedMissingPass.pass).toBe(false);

    const validVerdict = JSON.stringify({
      pass: true,
      verdict: 'Slate risk acceptable; no missing starters',
      flags: ['b2b_away']
    });
    const accepted = guardAnalystResponse(validVerdict, 'Risk Critic');
    expect(accepted._placeholder).toBeUndefined();
    expect(accepted.picks).toBeUndefined();
    expect(accepted.pass).toBe(true);
    expect(accepted.verdict).toBe('Slate risk acceptable; no missing starters');
    expect(accepted.flags).toEqual(['b2b_away']);
  });

  it('(S4) keeps Utah Mammoth verbatim in Game Slate and includes authoritative-names instruction', () => {
    const slate = 'event_id=nhl-utah | sport=icehockey_nhl | Utah Mammoth @ Colorado Avalanche | options: R1 Utah Mammoth ML';
    const headers = parseGameHeaders(slate);
    expect(headers).toHaveLength(1);
    expect(headers[0].away).toBe('Utah Mammoth');
    expect(renderHeaders(headers, 1600)).toContain('Utah Mammoth');

    const authLine = 'Team names in Game Slate are authoritative; never rename or flag them.';
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain(authLine);
    expect(RED_TEAM_ANALYST_SYSTEM_INSTRUCTION).toContain(authLine);
  });

  it('(S5) failed verification marks verified:false, verification.success:false, clears picks/components, and marks summary unverified', async () => {
    const context = new SwarmContext();
    const mockManager: any = {
      id: 'mgr',
      role: 'Manager Node',
      provider: 'openrouter',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () =>
        JSON.stringify({
          ui_title: 'Parlay Slate',
          summary: 'Utah ML -345 is strong.',
          components: [{ id: 'c1', type: 'MetricCard', props: { title: 'Edge', value: '5%' } }],
          picks: [{ event_id: 'nhl-utah', selection: 'Utah ML -345' }]
        })
      )
    };
    const mockCritic: any = {
      id: 'critic',
      role: 'critic',
      provider: 'openrouter',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () =>
        JSON.stringify({
          pass: false,
          feedback: 'Rejected: missing injury proof'
        })
      )
    };

    const { finalAnalysis } = await runDeepAnalysisVerification({
      task: 'Evaluate Utah Mammoth',
      rawInput: 'event_id=nhl-utah | sport=icehockey_nhl | Utah Mammoth @ Colorado Avalanche',
      effectiveDynamicPrompt: 'Evaluate Utah Mammoth',
      effectiveCompiledReports: 'Quant: Utah ML',
      effectiveHistoricalContext: '',
      managerAgent: mockManager,
      analysts: [{ id: 'a1', role: 'a1', provider: 'openrouter' } as any],
      dedicatedCriticAgent: mockCritic,
      context
    });

    expect(mockCritic.setSystemInstruction).toHaveBeenCalledWith(
      expect.stringContaining('Team names in Game Slate are authoritative; never rename or flag them.')
    );
    expect(finalAnalysis.verified).toBe(false);
    expect(finalAnalysis.verification).toBeDefined();
    expect(finalAnalysis.verification.success).toBe(false);
    expect(finalAnalysis.picks).toEqual([]);
    expect(finalAnalysis.components).toEqual([]);
    expect(finalAnalysis.summary).toContain('[UNVERIFIED]');
    expect(finalAnalysis.summary).toContain('Utah ML -345');
  });
});
