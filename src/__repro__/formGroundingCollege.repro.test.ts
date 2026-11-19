import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GROUNDING_RULE,
  FORM_GROUNDING_BULLETS,
  FORM_GROUNDING_RULE,
  auditClaimGrounding,
  sanitizeUngroundedClaims
} from '../swarm/tools/claimGrounding.ts';
import {
  auditPullBeforePass,
  sanitizePullBeforePassClaims
} from '../swarm/tools/pullBeforePass.ts';
import {
  ANALYST_SYSTEM_INSTRUCTION,
  RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  MANAGER_SYSTEM_INSTRUCTION
} from '../swarm/engine/constants.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
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

const MIXED_COLLEGE_PRO_SLATE = [
  'event_id=ncaaf-rice-temple | sport=americanfootball_ncaaf | Rice Owls @ Temple Owls | commence=2026-11-20T00:30:00Z | options: R1 Rice Owls +6.5 (-110), R2 Temple Owls -6.5 (-110)',
  'event_id=nba-401910101 | sport=basketball_nba | Portland Trail Blazers @ Milwaukee Bucks | commence=2026-11-20T01:00:00Z | options: R3 Portland Trail Blazers +10.5 (-110), R4 Milwaukee Bucks -10.5 (-110)',
  'event_id=nhl-401892802 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-20T02:00:00Z | options: R5 Anaheim Ducks +1.5 (-125), R6 Colorado Avalanche -1.5 (+105)'
].join('\n');

describe('Swarm Fix: No form without a tool, no "missing" after a hit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(1) adds the 4 new GROUNDING rules across instructions, Verification Critic, and CRITICAL RETRY RULES without altering GROUNDING_RULE', async () => {
    const newLines = [
      '- Do not cite a record, L2, or score unless it is in a successful tool result for that team.',
      '- If you did not call the form tool, do not invent the record.',
      '- If a tool returned data, do not say fundamentals or market data are missing.',
      '- A pass is fine. Do not pad it with ungrounded form.'
    ];

    expect(GROUNDING_RULE).toBe(
      [
        'GROUNDING:',
        '- Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result.',
        '- If key players on that team are OUT, do not call the team relatively healthy.',
        '- A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.'
      ].join('\n')
    );
    expect(FORM_GROUNDING_BULLETS).toBe(newLines.join('\n'));
    expect(FORM_GROUNDING_RULE).toBe(`GROUNDING:\n${newLines.join('\n')}`);

    for (const instr of [
      ANALYST_SYSTEM_INSTRUCTION,
      RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      MANAGER_SYSTEM_INSTRUCTION
    ]) {
      for (const line of newLines) {
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
        run: vi.fn(async () => JSON.stringify({ summary: 'Pass.', picks: [], components: [] }))
      };
      const mockCritic: any = {
        role: 'Verification Critic',
        provider: 'groq',
        modelName: 'mock-c',
        setSystemInstruction: vi.fn((s: string) => captured.push(s)),
        run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'ok' }))
      };

      await runDeepAnalysisVerification({
        task: 'Verify parlay',
        rawInput: MIXED_COLLEGE_PRO_SLATE,
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
      for (const line of newLines) {
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
        return JSON.stringify({ summary: 'Clean pass.', picks: [] });
      })
    };
    let calls = 0;
    const retryCritic: any = {
      role: 'Critic',
      provider: 'groq',
      modelName: 'mock-c',
      run: vi.fn(async () => {
        calls++;
        return calls === 1
          ? JSON.stringify({ pass: false, feedback: 'Fix grounding.' })
          : JSON.stringify({ pass: true, feedback: 'Ok.' });
      })
    };

    await new AnalysisLifecycle(retryProposer, retryCritic, 2).executeAndVerify(
      { rawBoard: MIXED_COLLEGE_PRO_SLATE },
      new SwarmContext(),
      'Compile',
      'Verify'
    );
    expect(proposerPrompts).toHaveLength(2);
    expect(proposerPrompts[1]).toContain('Do not cite a record, L2, or score unless it is in a successful tool result for that team.');
    expect(proposerPrompts[1]).toContain('A pass is fine. Do not pad it with ungrounded form.');
  });

  it('(2) catches "Rice and Temple are 0-2 L2" and bare copula "Rice is 0-2" when no form tool returned data for that college game, even if another team is 0-2', () => {
    const onlyNbaHas02Evidence = [
      'EVENT nba-401910101 Portland Trail Blazers @ Milwaukee Bucks',
      '[MATCHUP FUNDAMENTALS: nba-401910101 (L10)]',
      'Away (POR): W-L 0-2 | Recent L,L',
      'Home (MIL): W-L 8-2 | Recent W,W,W,W,L',
      'EVENT ncaaf-rice-temple Rice Owls @ Temple Owls',
      '[INJURY & ROSTER DELTA: ncaaf-rice-temple] Lineups clean.',
      '[MARKET MOVEMENT: ncaaf-rice-temple | all] Current: spread +6.5 | Total: 48.5'
    ].join('\n');

    // A: Coordinated "Rice and Temple are 0-2 L2" must fail (never borrow POR's 0-2!)
    const ungroundedL2 = {
      summary: 'Passing on the college leg. Rice and Temple are 0-2 L2 with limited offensive efficiency.',
      picks: []
    };
    const l2Audit = auditClaimGrounding(ungroundedL2, onlyNbaHas02Evidence, MIXED_COLLEGE_PRO_SLATE);
    expect(l2Audit.pass).toBe(false);
    expect(l2Audit.flags).toContain('ungrounded_form_claim');

    const strippedL2 = sanitizeUngroundedClaims(structuredClone(ungroundedL2), onlyNbaHas02Evidence, MIXED_COLLEGE_PRO_SLATE);
    expect(strippedL2.summary).not.toContain('0-2');
    expect(strippedL2.summary).toContain('Passing on the college leg.');

    // B: Copula without L2 ("Rice is 0-2") also fails
    const copulaAudit = auditClaimGrounding(
      { summary: 'Passing on Rice @ Temple because Rice is 0-2 right now.', picks: [] },
      onlyNbaHas02Evidence,
      MIXED_COLLEGE_PRO_SLATE
    );
    expect(copulaAudit.pass).toBe(false);
    expect(copulaAudit.flags).toContain('ungrounded_form_claim');

    // C: Partial grounding (Rice Owls is 0-2, Temple Owls is 2-0) must STILL reject "Rice and Temple are 0-2 L2"
    const partialCollegeEvidence = [
      'EVENT ncaaf-rice-temple Rice Owls @ Temple Owls',
      '[MATCHUP FUNDAMENTALS: ncaaf-rice-temple (L10)]',
      'Away (Rice Owls): W-L 0-2 | Recent L,L',
      'Home (Temple Owls): W-L 2-0 | Recent W,W'
    ].join('\n');
    const partialAudit = auditClaimGrounding(
      { summary: 'Rice and Temple are 0-2 L2.', picks: [] },
      partialCollegeEvidence,
      MIXED_COLLEGE_PRO_SLATE
    );
    expect(partialAudit.pass).toBe(false);
    expect(partialAudit.flags).toContain('ungrounded_form_claim');

    // D: Full per-team grounding via Recent sequences passes
    const fullCollegeEvidence = [
      'EVENT ncaaf-rice-temple Rice Owls @ Temple Owls',
      '[MATCHUP FUNDAMENTALS: ncaaf-rice-temple (L10)]',
      'Away (Rice Owls): W-L 3-5 | Recent L,L,W,W,L',
      'Home (Temple Owls): W-L 4-4 | Recent W,W,W,L,L'
    ].join('\n');
    // Note: Rice first 2 are L,L (0-2) and Temple last 2 are L,L (0-2)!
    const fullAudit = auditClaimGrounding(
      { summary: 'Rice and Temple are 0-2 L2.', picks: [] },
      fullCollegeEvidence,
      MIXED_COLLEGE_PRO_SLATE
    );
    expect(fullAudit.pass).toBe(true);
  });

  it('(3) catches and strips "without specific game fundamentals" after injury/market tools succeeded while allowing true empty fundamentals passes', () => {
    const injuryAndMarketOnlyEvidence = [
      'EVENT ncaaf-rice-temple Rice Owls @ Temple Owls',
      '[INJURY & ROSTER DELTA: ncaaf-rice-temple] No major scratches.',
      '[MARKET MOVEMENT: ncaaf-rice-temple | all] Current: home Temple Owls -6.5 / away Rice Owls +6.5 | Total: 48.5'
    ].join('\n');

    const traceWithHitsOnly = [
      { tool: 'get_injury_and_roster_delta', eventId: 'ncaaf-rice-temple', status: 'data' as const },
      { tool: 'get_market_movement', eventId: 'ncaaf-rice-temple', status: 'data' as const }
    ];

    const marketProposerReport = {
      analysis: 'Passing on Rice @ Temple without specific game fundamentals.',
      picks: [],
      insights: ['No play on the slate without specific game fundamentals.']
    };

    // A: Rejected when get_matchup_fundamentals was never called despite injury+market hits
    const audit = auditPullBeforePass(marketProposerReport, injuryAndMarketOnlyEvidence, MIXED_COLLEGE_PRO_SLATE, {
      toolCallTrace: traceWithHitsOnly,
      availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
    });
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('unqueried_missing_data_claim');
    expect(audit.unqueriedGameIds).toContain('ncaaf-rice-temple');

    // B: Rejected without explicit availableTools when another tool returned data for that game
    const implicitAudit = auditPullBeforePass(marketProposerReport, injuryAndMarketOnlyEvidence, MIXED_COLLEGE_PRO_SLATE, {
      toolCallTrace: traceWithHitsOnly
    });
    expect(implicitAudit.pass).toBe(false);

    // C: Sanitizer removes "without specific game fundamentals" cleanly while keeping the pass statement
    const sanitized = sanitizePullBeforePassClaims(
      structuredClone(marketProposerReport),
      injuryAndMarketOnlyEvidence,
      MIXED_COLLEGE_PRO_SLATE,
      {
        toolCallTrace: traceWithHitsOnly,
        availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
      }
    );
    expect(sanitized.analysis).toBe('Passing on Rice @ Temple.');
    expect(sanitized.insights[0]).toBe('No play on the slate.');

    // D: Rejected as false_missing_data_claim when get_matchup_fundamentals DID return data
    const auditWithFundamentals = auditPullBeforePass(
      marketProposerReport,
      `${injuryAndMarketOnlyEvidence}\n[MATCHUP FUNDAMENTALS: ncaaf-rice-temple (season)] Away (Rice Owls): W-L 4-4 | Home (Temple Owls): W-L 5-3`,
      MIXED_COLLEGE_PRO_SLATE,
      {
        toolCallTrace: [
          ...traceWithHitsOnly,
          { tool: 'get_matchup_fundamentals', eventId: 'ncaaf-rice-temple', status: 'data' as const }
        ],
        availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
      }
    );
    expect(auditWithFundamentals.pass).toBe(false);
    expect(auditWithFundamentals.flags).toContain('false_missing_data_claim');

    // E: Allowed when get_matchup_fundamentals WAS called for ncaaf-rice-temple and returned empty
    const emptyFundamentalsAudit = auditPullBeforePass(
      { analysis: 'Passing on Rice @ Temple without specific game fundamentals after the tool returned empty.', picks: [] },
      `${injuryAndMarketOnlyEvidence}\n[MATCHUP FUNDAMENTALS: ncaaf-rice-temple (season)] no canonical game for ncaaf-rice-temple`,
      MIXED_COLLEGE_PRO_SLATE,
      {
        toolCallTrace: [
          ...traceWithHitsOnly,
          { tool: 'get_matchup_fundamentals', eventId: 'ncaaf-rice-temple', status: 'empty' as const }
        ],
        availableTools: ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement']
      }
    );
    expect(emptyFundamentalsAudit.pass).toBe(true);
  });

  it('(4) End-to-end parlay request with a college game prevents ungrounded "0-2 L2" and strips Market Proposer "without specific game fundamentals" while allowing clean pass', async () => {
    const fetchFn: any = vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.p_game_id;
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(JSON.stringify({ source: 'snapshot', game_id: gId, injuries: [] }), { status: 200 });
      }
      if (url.includes('get_matchup_fundamentals_v1')) {
        if (gId === 'ncaaf-rice-temple') {
          // Empty college form -> no form data exists for Rice @ Temple
          return new Response(JSON.stringify({ source: 'empty', status: 'no_rows' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            home: { team: gId === 'nba-401910101' ? 'MIL' : 'COL', wins: 7, losses: 3, points_for_avg: 114, points_against_avg: 108, net_margin: 6 },
            away: { team: gId === 'nba-401910101' ? 'POR' : 'ANA', wins: 0, losses: 2, points_for_avg: 101, points_against_avg: 112, net_margin: -11 }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          game_id: gId,
          opening: { spread: gId === 'ncaaf-rice-temple' ? 6.5 : 10.5, total: 224.5, ml_home: -280, ml_away: 220 },
          latest: { spread: gId === 'ncaaf-rice-temple' ? 6.5 : 10.5, total: 225.0, ml_home: -290, ml_away: 230 },
          line_snapshots: [
            { spread: 6.5, total: 224.5, ml_home: -280, ml_away: 220, snapshot_at: '2026-11-20T00:00:00Z' },
            { spread: 6.5, total: 225.0, ml_home: -290, ml_away: 230, snapshot_at: '2026-11-20T00:15:00Z' }
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
    let capturedMarketProposerPrompt = '';
    const capturedManagerPrompts: string[] = [];
    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis: 'NBA POR @ MIL and NHL ANA @ COL have fundamentals; Rice @ Temple fundamentals returned empty.',
          picks: [],
          scorecards: []
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        capturedMarketProposerPrompt = prompt;
        return JSON.stringify({
          analysis: 'Injury and market tools returned data across the slate; passing on the parlay without specific game fundamentals.',
          picks: [],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify(
          prompt.includes('OUTPUT CONTRACT (mandatory)')
            ? { pass: true, feedback: 'Clean pass verified.' }
            : { pass: true, verdict: 'Clean pass verified.', flags: [] }
        );
      }

      managerCalls++;
      capturedManagerPrompts.push(prompt);
      if (managerCalls === 1) {
        // Attempt 1 pads a pass with ungrounded college form "Rice and Temple are 0-2 L2"
        return JSON.stringify({
          ui_title: 'Pass on Parlay',
          pass: true,
          summary:
            'Passing on the 3-leg parlay. Rice and Temple are 0-2 L2 with shaky efficiency, and there is no edge today.',
          picks: [],
          components: []
        });
      }

      return JSON.stringify({
        ui_title: 'Pass on Parlay',
        pass: true,
        summary:
          'Bottom-line call: pass on a parlay today. Tool pulls show clean injury and market snapshots across the slate, while Rice Owls @ Temple Owls matchup fundamentals returned no rows and available NBA/NHL lines show no mispricing edge.',
        picks: [],
        components: []
      });
    });

    try {
      const res = await executeSwarmWorkflow({
        task: 'Build a 3-leg parlay including Rice Owls @ Temple Owls.\nPICK OUTPUT CONTRACT:\nReturn JSON with analysis, picks, scorecards.',
        data: MIXED_COLLEGE_PRO_SLATE,
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

      expect(capturedMarketProposerPrompt).toContain('ncaaf-rice-temple');
      expect(managerCalls).toBe(2);

      // Market Proposer's "without specific game fundamentals" was sanitized out before synthesis
      expect(capturedManagerPrompts[0]).toContain('Market Proposer');
      expect(capturedManagerPrompts[0]).toContain('Injury and market tools returned data across the slate');
      expect(capturedManagerPrompts[0]).not.toMatch(/without specific game fundamentals/i);

      // Final verified pass keeps pass behavior intact without "0-2 L2" or false "fundamentals missing"
      expect(res.finalAnalysis.verified).toBe(true);
      expect(res.finalAnalysis.picks).toEqual([]);
      const serializedFinal = JSON.stringify(res.finalAnalysis);
      expect(serializedFinal).not.toMatch(/0-2\s*L2/i);
      expect(serializedFinal).not.toMatch(/without specific game fundamentals/i);
      expect(serializedFinal).not.toMatch(/fundamentals missing/i);

      // Trace confirms tool calls executed for the college game ncaaf-rice-temple
      const executedToolEvents = res.events.filter((e: any) => String(e.action || '').startsWith('Executed Tool:'));
      expect(
        executedToolEvents.some((e: any) => e.tool === 'get_market_movement' && String(e.prompt || '').includes('ncaaf-rice-temple'))
      ).toBe(true);
      expect(
        executedToolEvents.some((e: any) => e.tool === 'get_matchup_fundamentals' && String(e.prompt || '').includes('ncaaf-rice-temple'))
      ).toBe(true);
    } finally {
      runSpy.mockRestore();
    }
  });
});
