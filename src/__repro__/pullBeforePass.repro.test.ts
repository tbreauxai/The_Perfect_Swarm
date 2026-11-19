import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PULL_BEFORE_PASS_RULE,
  auditPullBeforePass,
  sanitizePullBeforePassClaims
} from '../swarm/tools/pullBeforePass.ts';
import {
  GROUNDING_RULE,
  auditClaimGrounding,
  sanitizeUngroundedClaims
} from '../swarm/tools/claimGrounding.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { runSeatWithTools } from '../swarm/engine/seatToolLoop.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { Agent } from '../swarm/agent.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import {
  getMatchupFundamentalsTool,
  getMarketMovementTool,
  getInjuryAndRosterDeltaTool
} from '../swarm/tools/dueloddsRpcTools.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

const SIX_GAME_SLATE = [
  'event_id=nba-401910101 | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-19T01:00:00Z | options: R1 Portland Trail Blazers +5.5 (-110), R2 Milwaukee Bucks -5.5 (-110), R3 Over 228.5 (-110)',
  'event_id=nhl-401892801 | sport=icehockey_nhl | Vancouver Canucks @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R4 Vancouver Canucks ML (+115), R5 Seattle Kraken ML (-135)',
  'event_id=nhl-401892802 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-19T02:00:00Z | options: R6 Anaheim Ducks +1.5 (-125), R7 Colorado Avalanche -1.5 (+105)',
  'event_id=nba-401910102 | sport=basketball_nba | Boston Celtics @ New York Knicks | commence=2026-11-19T00:30:00Z | options: R8 Boston Celtics -3.5 (-110), R9 New York Knicks +3.5 (-110)',
  'event_id=nba-401910103 | sport=basketball_nba | Los Angeles Lakers @ Golden State Warriors | commence=2026-11-19T03:30:00Z | options: R10 Los Angeles Lakers +2.5 (-110), R11 Golden State Warriors -2.5 (-110)',
  'event_id=nba-401910104 | sport=basketball_nba | Phoenix Suns @ Denver Nuggets | commence=2026-11-19T02:30:00Z | options: R12 Phoenix Suns +4.5 (-110), R13 Denver Nuggets -4.5 (-110)'
].join('\n');

const SIX_GAME_IDS = [
  'nba-401910101',
  'nhl-401892801',
  'nhl-401892802',
  'nba-401910102',
  'nba-401910103',
  'nba-401910104'
];

describe('Swarm Fix: Pull tools before passing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(1) injects verbatim PULL_BEFORE_PASS_RULE in all system instructions, Verification Critic prompts, and CRITICAL RETRY RULES without altering GROUNDING_RULE', async () => {
    const expectedPullLines = [
      'PULL BEFORE PASS:',
      '- Before saying a game has no fundamentals, injuries, or market data, call the tool for that game.',
      '- If the tool returns data, use it. Do not say it was not fetched.',
      '- If the tool returns empty or errors, then you may say that game has no data.',
      '- Do not cite a record, score, or L5 form unless it is in a successful tool result.',
      '- A pass is allowed only after the relevant tools were called, or the tool result was empty.'
    ];
    expect(PULL_BEFORE_PASS_RULE).toBe(expectedPullLines.join('\n'));
    expect(GROUNDING_RULE).toBe(
      [
        'GROUNDING:',
        '- Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result.',
        '- If key players on that team are OUT, do not call the team relatively healthy.',
        '- A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.'
      ].join('\n')
    );

    for (const instr of [
      ANALYST_SYSTEM_INSTRUCTION,
      RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      MANAGER_SYSTEM_INSTRUCTION
    ]) {
      for (const line of expectedPullLines) {
        expect(instr).toContain(line);
      }
    }

    for (const responseSchema of [undefined, 'morning_judge']) {
      const captured: string[] = [];
      const mockManager: any = {
        role: 'Manager',
        provider: 'openrouter',
        modelName: 'mock-m',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () => JSON.stringify({ summary: 'Verified.', picks: [], components: [] }))
      };
      const mockCritic: any = {
        role: 'Verification Critic',
        provider: 'groq',
        modelName: 'mock-c',
        setSystemInstruction: vi.fn((s: string) => captured.push(s)),
        run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'ok' }))
      };

      await runDeepAnalysisVerification({
        task: 'Verify slate',
        rawInput: SIX_GAME_SLATE,
        effectiveDynamicPrompt: 'Compile',
        effectiveCompiledReports: 'Reports',
        effectiveHistoricalContext: '',
        managerAgent: mockManager,
        analysts: [],
        dedicatedCriticAgent: mockCritic,
        context: new SwarmContext(),
        settings: responseSchema ? ({ responseSchema } as any) : undefined
      });

      expect(captured[0]).toBeDefined();
      for (const line of expectedPullLines) {
        expect(captured[0]).toContain(line);
      }
    }

    const proposerPrompts: string[] = [];
    const retryProposer: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      run: vi.fn(async (p: string) => {
        proposerPrompts.push(p);
        return JSON.stringify({ summary: 'Clean pass after review.', picks: [] });
      })
    };
    let criticCalls = 0;
    const retryCritic: any = {
      role: 'Critic',
      provider: 'groq',
      modelName: 'mock-c',
      run: vi.fn(async () => {
        criticCalls++;
        return criticCalls === 1
          ? JSON.stringify({ pass: false, feedback: 'Pull tools first.' })
          : JSON.stringify({ pass: true, feedback: 'Verified.' });
      })
    };

    const res = await new AnalysisLifecycle(retryProposer, retryCritic, 2).executeAndVerify(
      { rawBoard: SIX_GAME_SLATE },
      new SwarmContext(),
      'Compile',
      'Verify'
    );
    expect(res.success).toBe(true);
    expect(proposerPrompts).toHaveLength(2);
    expect(proposerPrompts[1]).toContain('7. PULL BEFORE PASS:');
    expect(proposerPrompts[1]).toContain(
      'Before saying a game has no fundamentals, injuries, or market data, call the tool for that game.'
    );
  });

  it('(2) Acceptance 1: rejects and strips "No market movement or prop data was fetched" when get_market_movement returned POR @ MIL data, while allowing prop-only note', async () => {
    const fetchFn: any = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910101',
          home_team_abbr: 'MIL',
          away_team_abbr: 'POR',
          opening: { spread: -4.5, total: 225.5, ml_home: -190, ml_away: 160 },
          latest: { spread: -5.5, total: 228.5, ml_home: -215, ml_away: 180 },
          line_delta: 1,
          line_snapshots: [
            { spread: -4.5, total: 225.5, ml_home: -190, ml_away: 160, snapshot_at: '2026-11-19T10:00:00Z' },
            { spread: -5.5, total: 228.5, ml_home: -215, ml_away: 180, snapshot_at: '2026-11-19T16:00:00Z' }
          ]
        }),
        { status: 200 }
      )
    );

    const mktRes: any = await getMarketMovementTool.execute(
      { game_id: 'nba-401910101', market_type: 'all' },
      { fetchFn, env }
    );
    expect(mktRes.success).toBe(true);
    expect(mktRes.summary).toContain('225.5 -> 228.5');
    expect(mktRes.summary).toContain('Delta: 1');

    const badProposal = {
      summary:
        'Pass on the 4-leg parlay. No market movement or prop data was fetched for this slate. Look to Milwaukee Bucks -5.5 later.',
      picks: []
    };

    const audit = auditPullBeforePass(badProposal, mktRes.summary, SIX_GAME_SLATE, {
      toolCallTrace: [{ tool: 'get_market_movement', eventId: 'nba-401910101', status: 'data', summary: mktRes.summary }],
      availableTools: ['get_market_movement']
    });
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('false_market_not_fetched');
    expect(audit.feedback).toContain('nba-401910101');

    const cleaned = sanitizePullBeforePassClaims(structuredClone(badProposal), mktRes.summary, SIX_GAME_SLATE, {
      toolCallTrace: [{ tool: 'get_market_movement', eventId: 'nba-401910101', status: 'data', summary: mktRes.summary }]
    });
    expect(cleaned.summary).not.toMatch(/no market movement/i);

    const validPropOnlyNote = {
      summary:
        'POR @ MIL total moved 225.5 -> 228.5 with spread delta +1. No player prop data was fetched on this game-line slate.',
      picks: [{ row: 'R3', event_id: 'nba-401910101', side: 'Over 228.5', market: 'total' }]
    };
    const propOnlyAudit = auditPullBeforePass(validPropOnlyNote, mktRes.summary, SIX_GAME_SLATE, {
      toolCallTrace: [{ tool: 'get_market_movement', eventId: 'nba-401910101', status: 'data', summary: mktRes.summary }],
      availableTools: ['get_market_movement']
    });
    expect(propOnlyAudit.pass).toBe(true);
  });

  it('(3) Acceptance 2: prefetches all 6 games fairly within Groq budget with zero [Not Fetched], supports role-named seats & Round-1 pass-claim fallback, and vetoes missing-data claims on unqueried games', async () => {
    const pad = ' | pace 99.4 | ORtg 115.2 | DRtg 111.8 | extra snapshot telemetry '.repeat(12);
    const fundCalls: string[] = [];
    const mktCalls: string[] = [];

    const registry = new ToolRegistry([
      {
        name: 'get_matchup_fundamentals',
        description: 'fundamentals',
        parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
        execute: vi.fn(async ({ game_id }: any) => {
          fundCalls.push(game_id);
          return {
            success: true,
            summary: `[MATCHUP FUNDAMENTALS: ${game_id} (L10)] Home: W-L 6-4 | Net +3.2${pad}`
          };
        })
      },
      {
        name: 'get_market_movement',
        description: 'market',
        parameters: {
          game_id: { type: 'string' as const, description: 'id', required: true },
          market_type: { type: 'string' as const, description: 'market', required: true }
        },
        execute: vi.fn(async ({ game_id }: any) => {
          mktCalls.push(game_id);
          return {
            success: true,
            summary: `[MARKET MOVEMENT: ${game_id} | all] Total: 225.5 -> 228.5 | Delta: +1`
          };
        })
      }
    ]);

    const quantPrompts: string[] = [];
    const quantProposer: any = {
      id: 'quant_proposer',
      role: 'Quant Proposer',
      provider: 'groq',
      run: vi.fn(async (p: string) => {
        quantPrompts.push(p);
        return JSON.stringify({ insights: ['All 6 games evaluated'], anomalies: [], summary: 'Done' });
      })
    };
    const marketProposer: any = {
      id: 'market_proposer',
      role: 'Market Proposer',
      provider: 'groq',
      run: vi.fn(async () => JSON.stringify({ insights: ['Market evaluated'], anomalies: [], summary: 'Done' }))
    };

    const quantRes = await runSeatWithTools({
      agent: quantProposer,
      seat: 'Quant Proposer',
      prompt: `Task: Analyze 6 games\n\nGame Slate:\n${SIX_GAME_SLATE}`,
      systemInstruction: ANALYST_SYSTEM_INSTRUCTION,
      gameIds: SIX_GAME_IDS,
      registry
    });
    expect(fundCalls).toEqual(SIX_GAME_IDS);
    expect(quantRes.coveredEventIds).toEqual(SIX_GAME_IDS);
    expect(quantRes.toolCallTrace).toHaveLength(6);
    expect(quantRes.toolCallTrace!.every(t => t.status === 'data')).toBe(true);
    expect(quantRes.toolEvidence).not.toContain('[Not Fetched]');
    for (const gId of SIX_GAME_IDS) {
      expect(quantRes.toolEvidence).toContain(gId);
    }
    expect(quantPrompts[0].length + ANALYST_SYSTEM_INSTRUCTION.length).toBeLessThanOrEqual(5600);

    const marketRes = await runSeatWithTools({
      agent: marketProposer,
      seat: 'Market Proposer',
      prompt: `Task: Analyze 6 games\n\nGame Slate:\n${SIX_GAME_SLATE}`,
      systemInstruction: ANALYST_SYSTEM_INSTRUCTION,
      gameIds: SIX_GAME_IDS,
      registry
    });
    expect(mktCalls).toEqual(SIX_GAME_IDS);
    expect(marketRes.coveredEventIds).toEqual(SIX_GAME_IDS);

    // Non-betting seat attempting a Round-1 pass/missing-data claim without calling tools triggers automatic prefetch
    fundCalls.length = 0;
    mktCalls.length = 0;
    const lazyAnalyst: any = {
      id: 'custom_lazy',
      role: 'Custom Analyst',
      provider: 'openrouter',
      run: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({
            summary: 'Pass on parlay because matchup fundamentals missing for 4 of 6 games.',
            picks: []
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            summary: 'Evaluated after prefetch.',
            picks: []
          })
        )
    };
    const lazyRes = await runSeatWithTools({
      agent: lazyAnalyst,
      seat: 'custom_lazy',
      prompt: `Analyze slate\n${SIX_GAME_SLATE}`,
      gameIds: SIX_GAME_IDS.slice(0, 3),
      registry
    });
    expect(lazyRes.rounds).toBe(2);
    expect(lazyRes.toolCallsExecuted.length).toBeGreaterThan(0);
    expect(lazyRes.coveredEventIds).toEqual(expect.arrayContaining(SIX_GAME_IDS.slice(0, 3)));

    // Audit flags unqueried games when proposal claims "Matchup fundamentals missing for 4 of 6 games"
    const onlyTwoQueriedTrace = [
      { tool: 'get_matchup_fundamentals', eventId: 'nba-401910101', status: 'data' as const },
      { tool: 'get_matchup_fundamentals', eventId: 'nhl-401892801', status: 'data' as const }
    ];
    const unqueriedAudit = auditPullBeforePass(
      { summary: 'Passing because matchup fundamentals missing for 4 of 6 games.', picks: [] },
      '[MATCHUP FUNDAMENTALS: nba-401910101]\n[MATCHUP FUNDAMENTALS: nhl-401892801]',
      SIX_GAME_SLATE,
      {
        toolCallTrace: onlyTwoQueriedTrace,
        availableTools: ['get_matchup_fundamentals', 'get_market_movement', 'get_injury_and_roster_delta']
      }
    );
    expect(unqueriedAudit.pass).toBe(false);
    expect(unqueriedAudit.flags).toContain('unqueried_missing_data_claim');
    expect(unqueriedAudit.unqueriedGameIds).toEqual(
      expect.arrayContaining(['nhl-401892802', 'nba-401910102', 'nba-401910103', 'nba-401910104'])
    );
  });

  it('(4) Acceptance 3: catches ungrounded VAN 2-3 L5, SEA 3-2 L5, COL lost 1-4 and team mismatches while allowing grounded records and H2H scores', () => {
    const cleanEvidence = [
      '[MATCHUP FUNDAMENTALS: nhl-401892801 (L10)]',
      'Home (SEA): W-L 6-4 | PF/PA 3.1 / 2.8 | Net Margin +0.3 | Recent W,W,L,W,L',
      'Away (VAN): W-L 4-1 | PF/PA 3.6 / 2.4 | Net Margin +1.2 | Recent W,W,W,L,W',
      '[MATCHUP FUNDAMENTALS: nhl-401892802 (L10)]',
      'Home (COL): W-L 7-3 | PF/PA 3.8 / 2.5 | Net Margin +1.3',
      'Away (ANA): W-L 3-7 | PF/PA 2.3 / 3.5 | Net Margin -1.2'
    ].join('\n');

    const ungrounded = {
      summary: 'Back SEA over VAN (VAN 2-3 L5, SEA 3-2 L5). Avoid COL after COL lost 1-4 and COL lost to ANA 1-4.',
      picks: []
    };
    const badAudit = auditClaimGrounding(ungrounded, cleanEvidence, SIX_GAME_SLATE);
    expect(badAudit.pass).toBe(false);
    expect(badAudit.flags).toContain('ungrounded_form_claim');

    const stripped = sanitizeUngroundedClaims(structuredClone(ungrounded), cleanEvidence, SIX_GAME_SLATE);
    expect(stripped.summary).not.toContain('VAN 2-3 L5');
    expect(stripped.summary).not.toContain('COL lost 1-4');

    // Note: SEA 3-2 L5 IS grounded by Recent W,W,L,W,L, whereas VAN 2-3 L5 fails (VAN is 4-1 in tool!)
    const teamMismatch = auditClaimGrounding(
      { summary: 'VAN 2-3 L5 struggles against SEA.' },
      [
        '[MATCHUP FUNDAMENTALS: nhl-401892801 (L10)]',
        'Home (VAN): W-L 4-1 | Recent W,W,L,W,W',
        'Away (SEA): W-L 2-3 | Recent L,L,W,L,W'
      ].join('\n'),
      SIX_GAME_SLATE
    );
    expect(teamMismatch.pass).toBe(false);
    expect(teamMismatch.flags).toContain('ungrounded_form_claim');

    // Grounded VAN 2-3 L5 + SEA 3-2 L5 + COL 1-4 H2H -> PASSES
    const groundedEvidence = [
      '[MATCHUP FUNDAMENTALS: nhl-401892801 (L10)]',
      'Away (VAN): W-L 2-3 | PF/PA 2.4 / 3.0 | Net Margin -0.6',
      'Home (SEA): W-L 6-4 | PF/PA 3.1 / 2.8 | Net Margin +0.3 | Recent W,W,L,W,L',
      '[MATCHUP FUNDAMENTALS: nhl-401892802 (L10)]',
      'Home (COL): W-L 6-4 | PF/PA 3.4 / 2.6 | Net Margin +0.8',
      'H2H: 2026-11-12: COL vs ANA 1-4 (L)'
    ].join('\n');
    const groundedAudit = auditClaimGrounding(
      { summary: 'VAN 2-3 L5 faces SEA 3-2 L5, and COL lost 1-4 in their previous H2H meeting.' },
      groundedEvidence,
      SIX_GAME_SLATE
    );
    expect(groundedAudit.pass).toBe(true);
  });

  it('(5) Acceptance 4: real pass is allowed when all relevant tools were called (empty RPCs + fatal OUT injuries) both in unit audit and end-to-end workflow', async () => {
    // Unit Case A: 4 empty + 2 fatal OUT injuries
    const emptyAndFatalTrace = SIX_GAME_IDS.flatMap((id, idx) => [
      { tool: 'get_matchup_fundamentals', eventId: id, status: idx < 4 ? ('empty' as const) : ('data' as const) },
      { tool: 'get_market_movement', eventId: id, status: idx < 4 ? ('empty' as const) : ('data' as const) },
      { tool: 'get_injury_and_roster_delta', eventId: id, status: 'data' as const }
    ]);
    const unitEmptyPassAudit = auditPullBeforePass(
      {
        summary:
          'Real pass on 4-leg parlay: matchup fundamentals missing for 4 games (no canonical game returned) and market movement returned 0 snapshots for 4 games, while MIL and VAN carry fatal star OUT injuries.',
        picks: []
      },
      [
        '[MATCHUP FUNDAMENTALS: nba-401910101 (L10)] no canonical game for nba-401910101',
        '[MARKET MOVEMENT: nba-401910101 | all] no FanDuel snapshots tracked (0 snapshots).',
        '[MATCHUP FUNDAMENTALS: nhl-401892801 (L10)] no canonical game for nhl-401892801',
        '[MATCHUP FUNDAMENTALS: nhl-401892802 (L10)] no canonical game for nhl-401892802',
        '[MATCHUP FUNDAMENTALS: nba-401910102 (L10)] no canonical game for nba-401910102'
      ].join('\n'),
      SIX_GAME_SLATE,
      {
        toolCallTrace: emptyAndFatalTrace,
        availableTools: ['get_matchup_fundamentals', 'get_market_movement', 'get_injury_and_roster_delta']
      }
    );
    expect(unitEmptyPassAudit.pass).toBe(true);

    // Unit Case B: all 6 returned real data, 4 have fatal OUT injuries + cites POR @ MIL movement
    const allDataTrace = SIX_GAME_IDS.flatMap(id => [
      { tool: 'get_matchup_fundamentals', eventId: id, status: 'data' as const },
      { tool: 'get_market_movement', eventId: id, status: 'data' as const },
      { tool: 'get_injury_and_roster_delta', eventId: id, status: 'data' as const }
    ]);
    const unitFatalInjuryPassAudit = auditPullBeforePass(
      {
        summary:
          'Passing on a 4-leg parlay today: POR @ MIL total moved 225.5 -> 228.5 (spread +1), and four slate games have fatal star OUT scratches that eliminate parlay value.',
        picks: []
      },
      '[MARKET MOVEMENT: nba-401910101 | all] Total: 225.5 -> 228.5 | Delta: 1',
      SIX_GAME_SLATE,
      {
        toolCallTrace: allDataTrace,
        availableTools: ['get_matchup_fundamentals', 'get_market_movement', 'get_injury_and_roster_delta']
      }
    );
    expect(unitFatalInjuryPassAudit.pass).toBe(true);

    // End-to-end real pass workflow: 4 empty games + 2 fatal injury games
    const emptySet = new Set(SIX_GAME_IDS.slice(2));
    const fetchFn: any = vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.p_game_id;
      if (url.includes('get_injury_and_roster_delta_v1')) {
        const injuries =
          gId === 'nba-401910101'
            ? [{ team_id: '15', player_name: 'Giannis Antetokounmpo', position: 'F', status: 'out' }]
            : gId === 'nhl-401892801'
              ? [{ team_id: '22', player_name: 'Quinn Hughes', position: 'D', status: 'out' }]
              : [];
        return new Response(JSON.stringify({ source: 'snapshot', game_id: gId, injuries }), { status: 200 });
      }
      if (url.includes('get_matchup_fundamentals_v1')) {
        if (emptySet.has(gId)) {
          return new Response(JSON.stringify({ source: 'empty', status: 'no_rows' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            home: { team: gId === 'nba-401910101' ? 'MIL' : 'SEA', wins: 6, losses: 4, points_for_avg: 114.0, points_against_avg: 111.0, net_margin: 3.0 },
            away: { team: gId === 'nba-401910101' ? 'POR' : 'VAN', wins: 5, losses: 5, points_for_avg: 110.5, points_against_avg: 110.0, net_margin: 0.5 }
          }),
          { status: 200 }
        );
      }
      if (emptySet.has(gId)) {
        return new Response(JSON.stringify({ snapshots_tracked: 0, line_snapshots: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          opening: { spread: -4.5, total: 225.5, ml_home: -190, ml_away: 160 },
          latest: { spread: -5.5, total: 228.5, ml_home: -215, ml_away: 180 },
          line_delta: 1,
          line_snapshots: [
            { spread: -4.5, total: 225.5, ml_home: -190, ml_away: 160, snapshot_at: '2026-11-19T10:00:00Z' },
            { spread: -5.5, total: 228.5, ml_home: -215, ml_away: 180, snapshot_at: '2026-11-19T16:00:00Z' }
          ]
        }),
        { status: 200 }
      );
    });

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn, env }) }
    ]);

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis: 'Pass recommended: 4 games returned empty canonical rows and MIL/VAN have fatal OUT injuries (Giannis Antetokounmpo OUT, Quinn Hughes OUT).',
          picks: [],
          scorecards: []
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        return JSON.stringify({
          analysis: 'Market check complete: 4 games have 0 FanDuel snapshots; POR @ MIL total moved 225.5 -> 228.5 (+1 spread delta). Pass.',
          picks: [],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        if (prompt.includes('OUTPUT CONTRACT (mandatory)')) {
          return JSON.stringify({ pass: true, feedback: 'Real pass verified after all tools checked.' });
        }
        return JSON.stringify({ pass: true, verdict: 'All 6 games checked; empty RPCs and OUT stars justify a pass.', flags: [] });
      }
      return JSON.stringify({
        ui_title: 'Pass on 4-Leg Parlay',
        pass: true,
        summary:
          'Bottom-line call: pass on a 4-leg parlay today. Quant and Market specialists queried all 6 games: 4 games returned no canonical fundamentals or 0 market snapshots, while POR @ MIL (total 225.5 -> 228.5) has Giannis Antetokounmpo OUT and VAN @ SEA has Quinn Hughes OUT.',
        picks: [],
        components: []
      });
    });

    try {
      const result = await executeSwarmWorkflow({
        task: 'Build a 4-leg parlay for today.\nPICK OUTPUT CONTRACT:\nReturn JSON with analysis, picks, scorecards.',
        data: SIX_GAME_SLATE,
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

      expect(result.finalAnalysis.verified).toBe(true);
      expect(result.finalAnalysis.picks).toEqual([]);
      expect(result.tools_called).toEqual(
        expect.arrayContaining(['get_matchup_fundamentals', 'get_market_movement', 'get_injury_and_roster_delta'])
      );
    } finally {
      runSpy.mockRestore();
    }
  });

  it('(6) User Test: 4-leg parlay workflow vetoes buggy premature pass + ungrounded form claims, pulls all games, and succeeds on Attempt 2 with grounded trace', async () => {
    const toolStatsById: Record<string, { home: string; away: string; hWl: string; aWl: string; hNet: number; aNet: number }> = {
      'nba-401910101': { home: 'MIL', away: 'POR', hWl: '6-4', aWl: '4-6', hNet: 4.1, aNet: -2.5 },
      'nhl-401892801': { home: 'SEA', away: 'VAN', hWl: '6-4', aWl: '5-5', hNet: 0.9, aNet: 0.1 },
      'nhl-401892802': { home: 'COL', away: 'ANA', hWl: '7-3', aWl: '3-7', hNet: 1.4, aNet: -1.1 },
      'nba-401910102': { home: 'NYK', away: 'BOS', hWl: '5-5', aWl: '8-2', hNet: 0.4, aNet: 7.2 },
      'nba-401910103': { home: 'GSW', away: 'LAL', hWl: '7-3', aWl: '5-5', hNet: 5.0, aNet: -0.3 },
      'nba-401910104': { home: 'DEN', away: 'PHX', hWl: '7-3', aWl: '4-6', hNet: 4.4, aNet: -1.6 }
    };

    const fetchFn: any = vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.p_game_id;
      const st = toolStatsById[gId];

      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(JSON.stringify({ source: 'snapshot', game_id: gId, injuries: [] }), { status: 200 });
      }
      if (url.includes('get_matchup_fundamentals_v1')) {
        const [hw, hl] = (st?.hWl || '5-5').split('-').map(Number);
        const [aw, al] = (st?.aWl || '5-5').split('-').map(Number);
        return new Response(
          JSON.stringify({
            home: { team: st?.home || 'HOME', wins: hw, losses: hl, points_for_avg: 114.2, points_against_avg: 110.1, net_margin: st?.hNet ?? 2.0 },
            away: { team: st?.away || 'AWAY', wins: aw, losses: al, points_for_avg: 109.1, points_against_avg: 111.6, net_margin: st?.aNet ?? -1.0 }
          }),
          { status: 200 }
        );
      }
      // get_market_movement_v1: POR @ MIL has exact 225.5 -> 228.5 and spread delta +1
      if (gId === 'nba-401910101') {
        return new Response(
          JSON.stringify({
            game_id: gId,
            home_team_abbr: 'MIL',
            away_team_abbr: 'POR',
            opening: { spread: -4.5, total: 225.5, ml_home: -190, ml_away: 160 },
            latest: { spread: -5.5, total: 228.5, ml_home: -215, ml_away: 180 },
            line_delta: 1,
            line_snapshots: [
              { spread: -4.5, total: 225.5, ml_home: -190, ml_away: 160, snapshot_at: '2026-11-19T10:00:00Z' },
              { spread: -5.5, total: 228.5, ml_home: -215, ml_away: 180, snapshot_at: '2026-11-19T16:00:00Z' }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          game_id: gId,
          home_team_abbr: st?.home || 'HOME',
          away_team_abbr: st?.away || 'AWAY',
          opening: { spread: -2.5, total: 220.0, ml_home: -140, ml_away: 120 },
          latest: { spread: -3.5, total: 221.5, ml_home: -155, ml_away: 135 },
          line_delta: 1,
          line_snapshots: [
            { spread: -2.5, total: 220.0, ml_home: -140, ml_away: 120, snapshot_at: '2026-11-19T10:00:00Z' },
            { spread: -3.5, total: 221.5, ml_home: -155, ml_away: 135, snapshot_at: '2026-11-19T16:00:00Z' }
          ]
        }),
        { status: 200 }
      );
    });

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn, env }) }
    ]);

    let managerCalls = 0;
    const managerPrompts: string[] = [];
    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis: 'Quant edge on MIL (6-4), COL (7-3), BOS (8-2), and GSW (7-3).',
          picks: [
            { row: 'R2', event_id: 'nba-401910101', game: 'Portland Trail Blazers @ Milwaukee Bucks', market: 'spread', side: 'Milwaukee Bucks -5.5', confidence: 72, reason: 'MIL 6-4 vs POR 4-6.' },
            { row: 'R7', event_id: 'nhl-401892802', game: 'Anaheim Ducks @ Colorado Avalanche', market: 'spread', side: 'Colorado Avalanche -1.5', confidence: 74, reason: 'COL 7-3 vs ANA 3-7.' },
            { row: 'R8', event_id: 'nba-401910102', game: 'Boston Celtics @ New York Knicks', market: 'spread', side: 'Boston Celtics -3.5', confidence: 76, reason: 'BOS 8-2 (+7.2 net margin).' },
            { row: 'R11', event_id: 'nba-401910103', game: 'Los Angeles Lakers @ Golden State Warriors', market: 'spread', side: 'Golden State Warriors -2.5', confidence: 71, reason: 'GSW 7-3 (+5.0 net margin).' }
          ],
          scorecards: []
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        return JSON.stringify({
          analysis: 'POR @ MIL total moved 225.5 -> 228.5 (+1 spread delta). Market supports MIL -5.5, COL -1.5, BOS -3.5, GSW -2.5.',
          picks: [
            { row: 'R2', event_id: 'nba-401910101', game: 'Portland Trail Blazers @ Milwaukee Bucks', market: 'spread', side: 'Milwaukee Bucks -5.5', confidence: 70, reason: 'Spread moved 1 pt.' }
          ],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify(
          prompt.includes('OUTPUT CONTRACT (mandatory)')
            ? { pass: true, feedback: 'Grounded 4-leg parlay verified.' }
            : { pass: true, verdict: 'All 4 legs verified.', flags: [] }
        );
      }

      managerCalls++;
      managerPrompts.push(prompt);
      if (managerCalls === 1) {
        // Attempt 1 reproduces the buggy premature pass with all three loose ends
        return JSON.stringify({
          ui_title: 'Pass on 4-Leg Parlay',
          pass: true,
          summary:
            'Passing on the 4-leg parlay. No market movement or prop data was fetched. Matchup fundamentals missing for 4 of 6 games. VAN 2-3 L5, SEA 3-2 L5, and COL lost 1-4 create too much uncertainty.',
          picks: [],
          components: []
        });
      }

      // Attempt 2 uses returned market + fundamentals data for a grounded 4-leg parlay
      return JSON.stringify({
        ui_title: '4-Leg Parlay Card',
        pass: true,
        summary:
          'Bottom-line call: play a 4-leg parlay with Milwaukee Bucks -5.5 (R2), Colorado Avalanche -1.5 (R7), Boston Celtics -3.5 (R8), and Golden State Warriors -2.5 (R11). Market movement on POR @ MIL moved total 225.5 -> 228.5 with a +1 spread delta, while MIL (6-4), COL (7-3), BOS (8-2), and GSW (7-3) all hold positive net margins with clean injury reports. The call flips if a late star scratch hits any of these four legs.',
        picks: [
          { row: 'R2', event_id: 'nba-401910101', game: 'Portland Trail Blazers @ Milwaukee Bucks', market: 'spread', side: 'Milwaukee Bucks -5.5', confidence: 72, reason: 'MIL 6-4 vs POR 4-6; POR @ MIL total moved 225.5 -> 228.5 with +1 spread move.' },
          { row: 'R7', event_id: 'nhl-401892802', game: 'Anaheim Ducks @ Colorado Avalanche', market: 'spread', side: 'Colorado Avalanche -1.5', confidence: 74, reason: 'COL 7-3 (+1.4 net margin) vs ANA 3-7 (-1.1 net margin).' },
          { row: 'R8', event_id: 'nba-401910102', game: 'Boston Celtics @ New York Knicks', market: 'spread', side: 'Boston Celtics -3.5', confidence: 76, reason: 'BOS 8-2 (+7.2 net margin) vs NYK 5-5 (+0.4 net margin).' },
          { row: 'R11', event_id: 'nba-401910103', game: 'Los Angeles Lakers @ Golden State Warriors', market: 'spread', side: 'Golden State Warriors -2.5', confidence: 71, reason: 'GSW 7-3 (+5.0 net margin) vs LAL 5-5 (-0.3 net margin).' }
        ],
        components: []
      });
    });

    try {
      const result = await executeSwarmWorkflow({
        task: 'Build a 4-leg parlay for today.\nPICK OUTPUT CONTRACT:\nReturn JSON with analysis, picks, scorecards.',
        data: SIX_GAME_SLATE,
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

      // Attempt 1 buggy pass was deterministically vetoed, forcing Attempt 2
      expect(managerCalls).toBe(2);
      expect(managerPrompts[0]).toContain('Tool pull status (6 slate games):');
      expect(managerPrompts[1]).toContain('CRITICAL RETRY RULES:');
      expect(managerPrompts[1]).toContain('7. PULL BEFORE PASS:');

      const fa = result.finalAnalysis;
      expect(fa.verified).toBe(true);
      expect(fa.picks).toHaveLength(4);
      expect(fa.picks.map((p: any) => p.row)).toEqual(['R2', 'R7', 'R8', 'R11']);

      // Trace shows Executed Tool events for the games discussed
      const executedToolEvents = result.events.filter((e: any) => String(e.action || '').startsWith('Executed Tool:'));
      expect(executedToolEvents.length).toBeGreaterThanOrEqual(12);
      const tracedTools = new Set(executedToolEvents.map((e: any) => e.tool));
      expect(tracedTools).toEqual(
        new Set(['get_matchup_fundamentals', 'get_market_movement', 'get_injury_and_roster_delta'])
      );
      for (const discussedGameId of ['nba-401910101', 'nhl-401892802', 'nba-401910102', 'nba-401910103']) {
        expect(
          executedToolEvents.some(
            (e: any) => e.tool === 'get_market_movement' && String(e.prompt || '').includes(discussedGameId)
          )
        ).toBe(true);
        expect(
          executedToolEvents.some(
            (e: any) => e.tool === 'get_matchup_fundamentals' && String(e.prompt || '').includes(discussedGameId)
          )
        ).toBe(true);
      }

      // No false missing-data claims or ungrounded form claims in final output
      const serialized = JSON.stringify(fa);
      expect(serialized).not.toMatch(/no market movement/i);
      expect(serialized).not.toMatch(/not fetched/i);
      expect(serialized).not.toMatch(/fundamentals missing/i);
      expect(serialized).not.toContain('VAN 2-3 L5');
      expect(serialized).not.toContain('SEA 3-2 L5');
      expect(serialized).not.toContain('COL lost 1-4');
      expect(serialized).toContain('225.5 -> 228.5');
    } finally {
      runSpy.mockRestore();
    }
  });
});
