import { describe, it, expect, vi } from 'vitest';
import {
  GROUNDING_RULE,
  auditClaimGrounding,
  sanitizeUngroundedClaims,
  extractSuccessfulEvidenceText,
  extractVetoedLegTargets
} from '../swarm/tools/claimGrounding.ts';
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
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { auditInjuryAttribution } from '../swarm/tools/injuryAttribution.ts';
import { extractRowOptions } from '../swarm/tools/marketRowBinding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

const SLATE_ANA_SEA = [
  'event_id=nhl-401892758 | sport=icehockey_nhl | Anaheim Ducks @ Colorado Avalanche | commence=2026-11-19T02:00:00Z | options: R47 Anaheim Ducks +1.5 (-130), R48 Colorado Avalanche -1.5 (+110)',
  'event_id=nhl-401892752 | sport=icehockey_nhl | Utah Mammoth @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R3 Seattle Kraken -1.5 (+150), R4 Seattle Kraken ML (-166), R5 Utah Mammoth ML (+140)'
].join('\n');

describe('Swarm Fix: No ungrounded form claims, contradicted health claims, or vetoed single-bet rewrites', () => {
  it('(1) includes verbatim GROUNDING_RULE in all system instructions, Verification Critic prompts, and CRITICAL RETRY RULES', async () => {
    const expectedLines = [
      'GROUNDING:',
      '- Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result.',
      '- If key players on that team are OUT, do not call the team relatively healthy.',
      '- A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.'
    ];

    for (const instr of [
      ANALYST_SYSTEM_INSTRUCTION,
      RED_TEAM_ANALYST_SYSTEM_INSTRUCTION,
      CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      MANAGER_SYSTEM_INSTRUCTION
    ]) {
      for (const line of expectedLines) {
        expect(instr).toContain(line);
      }
    }
    expect(GROUNDING_RULE).toBe(expectedLines.join('\n'));

    // Verification Critic instructions (both standard and morning_judge)
    for (const responseSchema of [undefined, 'morning_judge']) {
      const criticCaptured: string[] = [];
      const mockManager: any = {
        role: 'Manager',
        provider: 'openrouter',
        modelName: 'mock-m',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () => JSON.stringify({ summary: 'Verified test.', picks: [], components: [] }))
      };
      const mockCritic: any = {
        role: 'Verification Critic',
        provider: 'groq',
        modelName: 'mock-c',
        setSystemInstruction: vi.fn((s: string) => criticCaptured.push(s)),
        run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'ok' }))
      };

      await runDeepAnalysisVerification(
        {
          task: 'Verify slate',
          rawInput: SLATE_ANA_SEA,
          effectiveDynamicPrompt: 'Compile',
          effectiveCompiledReports: 'Reports',
          effectiveHistoricalContext: '',
          managerAgent: mockManager,
          analysts: [],
          dedicatedCriticAgent: mockCritic,
          context: new SwarmContext(),
          settings: responseSchema ? ({ responseSchema } as any) : undefined
        }
      );

      expect(criticCaptured[0]).toBeDefined();
      for (const line of expectedLines) {
        expect(criticCaptured[0]).toContain(line);
      }
    }

    // Lifecycle CRITICAL RETRY RULES
    const proposerPrompts: string[] = [];
    const retryProposer: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      run: vi.fn(async (p: string) => {
        proposerPrompts.push(p);
        return JSON.stringify({ summary: 'Clean pass', picks: [] });
      })
    };
    let criticCall = 0;
    const retryCritic: any = {
      role: 'Critic',
      provider: 'groq',
      modelName: 'mock-c',
      run: vi.fn(async () => {
        criticCall++;
        return criticCall === 1
          ? JSON.stringify({ pass: false, feedback: 'Fix grounding.' })
          : JSON.stringify({ pass: true, feedback: 'Verified.' });
      })
    };

    const lcRes = await new AnalysisLifecycle(retryProposer, retryCritic, 2).executeAndVerify(
      { rawBoard: SLATE_ANA_SEA },
      new SwarmContext(),
      'Compile',
      'Verify'
    );
    expect(lcRes.success).toBe(true);
    expect(proposerPrompts).toHaveLength(2);
    expect(proposerPrompts[1]).toContain('CRITICAL RETRY RULES:');
    expect(proposerPrompts[1]).toContain(
      '6. GROUNDING: Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result. If key players on that team are OUT, do not call the team relatively healthy. A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.'
    );
  });

  it('(2) vetoes and strips ungrounded score/goals-allowed claims while allowing tool-grounded stats and W-L records', () => {
    // Even with failed tool lines + event_id containing 8 + R48 + W-L 8-2 + 3.8 avg, "8 goals allowed" is NOT grounded
    const failedAndMisleadingEvidence = [
      'Error fetching matchup fundamentals for nhl-401892758: rpc_failed_500',
      '[Not Fetched]: nhl-401892758: not fetched',
      '[MATCHUP FUNDAMENTALS: nhl-401892758 (L10)] Home (COL): W-L 8-2 | PF/PA 3.8 / 2.4 | Net Margin +1.4'
    ].join('\n');

    expect(extractSuccessfulEvidenceText(failedAndMisleadingEvidence)).not.toContain('rpc_failed_500');
    expect(extractSuccessfulEvidenceText(failedAndMisleadingEvidence)).not.toContain('[Not Fetched]');

    const ungroundedProposal = {
      summary: 'Back R48 Colorado Avalanche -1.5. Anaheim’s defense remains porous (8 goals allowed last game).',
      analysis: 'Anaheim lost 8-2 in their last outing.',
      picks: [
        {
          row: 'R48',
          event_id: 'nhl-401892758',
          side: 'Colorado Avalanche -1.5',
          reason: 'Anaheim’s defense remains porous (8 goals allowed last game).'
        }
      ]
    };

    const audit = auditClaimGrounding(ungroundedProposal, failedAndMisleadingEvidence, SLATE_ANA_SEA);
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('ungrounded_form_claim');
    expect(audit.feedback).toContain('8 goals allowed');

    const sanitized = sanitizeUngroundedClaims(
      structuredClone(ungroundedProposal),
      failedAndMisleadingEvidence,
      SLATE_ANA_SEA
    );
    expect(sanitized.summary).not.toContain('8 goals allowed');
    expect(sanitized.summary).toContain('Back R48 Colorado Avalanche -1.5.');
    expect(sanitized.analysis).not.toContain('8-2');
    expect(sanitized.picks[0].reason).not.toContain('8 goals allowed');
    expect(auditClaimGrounding(sanitized, failedAndMisleadingEvidence, SLATE_ANA_SEA).pass).toBe(true);

    // Grounded via H2H 2-8 score -> PASSES
    const h2hEvidence = [
      '[MATCHUP FUNDAMENTALS: nhl-401892758 (L10)]',
      'Home (COL): W-L 6-4 | PF/PA 3.4 / 2.2 | Net Margin +1.2',
      'Away (ANA): W-L 4-6 | PF/PA 2.2 / 3.9 | Net Margin -1.7',
      'H2H: 2026-11-10: ANA vs COL 2-8 (L)'
    ].join('\n');

    const groundedProposal = {
      summary: 'Back R48 Colorado Avalanche -1.5. Anaheim’s defense remains porous (8 goals allowed last game) and allows 3.9 goals per game.',
      analysis: 'Anaheim lost 8-2 in H2H and holds a 4-6 L10 record while Colorado holds a 6-4 L10 record.',
      picks: [
        {
          row: 'R48',
          event_id: 'nhl-401892758',
          side: 'Colorado Avalanche -1.5',
          reason: 'Colorado 6-4 L10 vs Anaheim allowing 3.9 goals per game and 8 goals allowed in their H2H.'
        }
      ]
    };
    expect(auditClaimGrounding(groundedProposal, h2hEvidence, SLATE_ANA_SEA).pass).toBe(true);

    // Grounded via snapshot goals_allowed: 8 -> PASSES
    const snapshotEvidence = `[MATCHUP FUNDAMENTALS: nhl-401892758 (season) | source: snapshot]\nForm: {"ANA":{"goals_allowed":8}}`;
    expect(
      auditClaimGrounding(
        { summary: 'Anaheim’s defense remains porous (8 goals allowed last game).' },
        snapshotEvidence,
        SLATE_ANA_SEA
      ).pass
    ).toBe(true);
  });

  it('(3) vetoes and strips contradicted/ungrounded health claims while allowing clean injury tool results and non-sports prose', () => {
    const seattleOutEvidence = [
      'EVENT nhl-401892752 Utah Mammoth @ Seattle Kraken',
      'INJ: Seattle Kraken (SEA): Jared McCann (C): OUT; Vince Dunn (D): OUT',
      'EVENT nhl-401892758 Anaheim Ducks @ Colorado Avalanche',
      'INJ: No injuries reported'
    ].join('\n');

    // Contradicted: Jared McCann & Vince Dunn are OUT for Seattle
    const badHealthProposal = {
      summary: 'Seattle is relatively healthy at forward, giving R4 Seattle Kraken ML value.',
      picks: [
        {
          row: 'R4',
          event_id: 'nhl-401892752',
          side: 'Seattle Kraken ML',
          reason: 'Seattle is relatively healthy at forward.'
        }
      ]
    };
    const healthAudit = auditClaimGrounding(badHealthProposal, seattleOutEvidence, SLATE_ANA_SEA);
    expect(healthAudit.pass).toBe(false);
    expect(healthAudit.flags).toContain('contradicted_health_claim');
    expect(healthAudit.feedback).toContain('Jared McCann');

    const cleanedHealth = sanitizeUngroundedClaims(structuredClone(badHealthProposal), seattleOutEvidence, SLATE_ANA_SEA);
    expect(cleanedHealth.summary).not.toMatch(/relatively healthy/i);
    expect(cleanedHealth.picks[0].reason).not.toMatch(/relatively healthy/i);
    expect(auditClaimGrounding(cleanedHealth, seattleOutEvidence, SLATE_ANA_SEA).pass).toBe(true);

    // Ungrounded: no injury tool result covers Seattle game (only market movement returned, or injury error)
    const noInjuryToolEvidence = [
      'Error fetching injury/roster delta for nhl-401892752: rpc_failed_503',
      '[MARKET MOVEMENT: nhl-401892752] ml_home Seattle Kraken -166 | Total: 6.5'
    ].join('\n');
    const ungroundedHealthAudit = auditClaimGrounding(
      { summary: 'Seattle is relatively healthy at forward.' },
      noInjuryToolEvidence,
      SLATE_ANA_SEA
    );
    expect(ungroundedHealthAudit.pass).toBe(false);
    expect(ungroundedHealthAudit.flags).toContain('ungrounded_health_claim');

    // Allowed: Utah Mammoth has 0 OUTs on a successful injury pull for nhl-401892752, and Colorado has INJ: No injuries reported
    expect(
      auditClaimGrounding(
        { summary: 'Utah is relatively healthy, and Colorado is relatively healthy, while Seattle is missing Jared McCann.' },
        seattleOutEvidence,
        SLATE_ANA_SEA
      ).pass
    ).toBe(true);

    // Allowed: non-sports prose does not false-positive
    expect(
      auditClaimGrounding(
        { insights: ['System is completely healthy with 0 errors and optimal latency.'] },
        '',
        ''
      ).pass
    ).toBe(true);
  });

  it('(4) removes vetoed legs from picks and rejects rewriting a vetoed leg as a recommended single bet', () => {
    const headers = parseGameHeaders(SLATE_ANA_SEA);
    const rowMap = extractRowOptions([SLATE_ANA_SEA], headers);
    const vetoTexts = ['Veto: R4 Seattle Kraken ML rejected because Jared McCann is OUT.'];

    const targets = extractVetoedLegTargets(vetoTexts, headers, rowMap);
    expect(targets.some(t => t.rowId === 'R4')).toBe(true);

    // A: Kept in picks -> vetoed_leg_kept
    const keptPickProposal = {
      summary: 'Back R48 Colorado Avalanche -1.5 and R4 Seattle Kraken ML.',
      picks: [
        { row: 'R48', event_id: 'nhl-401892758', side: 'Colorado Avalanche -1.5' },
        { row: 'R4', event_id: 'nhl-401892752', side: 'Seattle Kraken ML' }
      ]
    };
    const keptAudit = auditClaimGrounding(keptPickProposal, '', SLATE_ANA_SEA, { headers, vetoTexts });
    expect(keptAudit.pass).toBe(false);
    expect(keptAudit.flags).toContain('vetoed_leg_kept');

    // B: Removed from picks, but rewritten in prose as a recommended single bet -> vetoed_leg_rewritten
    const rewrittenSingleProposal = {
      summary: 'Back R48 Colorado Avalanche -1.5 in the primary slate. Seattle Kraken ML (R4) was vetoed from the parlay, so play Seattle Kraken ML as a recommended single bet instead.',
      picks: [{ row: 'R48', event_id: 'nhl-401892758', side: 'Colorado Avalanche -1.5' }]
    };
    const rewriteAudit = auditClaimGrounding(rewrittenSingleProposal, '', SLATE_ANA_SEA, { headers, vetoTexts });
    expect(rewriteAudit.pass).toBe(false);
    expect(rewriteAudit.flags).toContain('vetoed_leg_rewritten');

    // Sanitizer removes vetoed picks and strips the single-bet rewrite
    const sanitizedKept = sanitizeUngroundedClaims(structuredClone(keptPickProposal), '', SLATE_ANA_SEA, { headers, vetoTexts });
    expect(sanitizedKept.picks).toHaveLength(1);
    expect(sanitizedKept.picks[0].row).toBe('R48');

    const sanitizedRewrite = sanitizeUngroundedClaims(structuredClone(rewrittenSingleProposal), '', SLATE_ANA_SEA, { headers, vetoTexts });
    expect(sanitizedRewrite.summary).not.toMatch(/recommended single bet/i);
    expect(auditClaimGrounding(sanitizedRewrite, '', SLATE_ANA_SEA, { headers, vetoTexts }).pass).toBe(true);

    // C: Surviving non-vetoed leg recommended as a single bet while vetoed leg is cleanly removed -> PASSES
    const validSurvivingSingle = {
      summary: 'R4 Seattle Kraken ML was vetoed, leaving Colorado Avalanche -1.5 (R48) as a recommended single bet.',
      picks: [{ row: 'R48', event_id: 'nhl-401892758', side: 'Colorado Avalanche -1.5' }]
    };
    expect(auditClaimGrounding(validSurvivingSingle, '', SLATE_ANA_SEA, { headers, vetoTexts }).pass).toBe(true);

    // D: Wording-only critique ("Ottawa is the away team, not the home team") does NOT ban the leg
    const wordingOnlyTargets = extractVetoedLegTargets(
      ['Ottawa is the away team (Ottawa Senators @ Winnipeg Jets), not the home team.'],
      headers,
      rowMap
    );
    expect(wordingOnlyTargets).toEqual([]);
  });

  it('(5) End-to-end executeSwarmWorkflow catches ungrounded 8-goals-allowed + contradicted Seattle health + vetoed single-bet rewrite while preserving injury attribution & Critic vetoes', async () => {
    const fetchFn: any = vi.fn(async (_url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.game_id || body.p_game_id;
      if (gId === 'nhl-401892752') {
        return new Response(
          JSON.stringify({
            source: 'snapshot',
            game_id: 'nhl-401892752',
            injuries: [
              { team_id: '124292', player_id: '4024998', player_name: 'Jared McCann', position: 'C', status: 'out' },
              { team_id: '124292', player_id: '4025001', player_name: 'Vince Dunn', position: 'D', status: 'out' }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          source: 'snapshot',
          game_id: 'nhl-401892758',
          injuries: []
        }),
        { status: 200 }
      );
    });

    const injuryTool = {
      ...getInjuryAndRosterDeltaTool,
      execute: (args: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(args, { ...ctx, fetchFn, env })
    };
    const fundamentalsTool = {
      name: 'get_matchup_fundamentals',
      description: 'fundamentals',
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => {
        if (game_id === 'nhl-401892758') {
          return {
            success: true,
            summary: '[MATCHUP FUNDAMENTALS: nhl-401892758 (L10)] Home (COL): W-L 7-3 (+1.1 net margin) | Away (ANA): W-L 3-7 (-0.9 net margin)'
          };
        }
        return {
          success: true,
          summary: '[MATCHUP FUNDAMENTALS: nhl-401892752 (L10)] Home (SEA): W-L 5-5 | Away (UTA): W-L 6-4'
        };
      })
    };
    const marketTool = {
      name: 'get_market_movement',
      description: 'market',
      parameters: { game_id: { type: 'string' as const, description: 'id', required: true } },
      execute: vi.fn(async ({ game_id }: any) => {
        if (game_id === 'nhl-401892758') {
          return {
            success: true,
            summary: '[MARKET MOVEMENT: nhl-401892758] Spread: COL -1.5 (+110) | Total: 6.5 | ml_home COL -220'
          };
        }
        return {
          success: true,
          summary: '[MARKET MOVEMENT: nhl-401892752] Spread: SEA -1.5 (+150) | Total: 6.5 | ml_home SEA -166'
        };
      })
    };

    const registry = new ToolRegistry([injuryTool as any, fundamentalsTool as any, marketTool as any]);

    let managerCalls = 0;
    const managerPrompts: string[] = [];
    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis:
            'Back R48 Colorado Avalanche -1.5. Anaheim’s defense remains porous (8 goals allowed last game). Seattle is relatively healthy at forward for R4.',
          picks: [
            {
              row: 'R48',
              event_id: 'nhl-401892758',
              game: 'Anaheim Ducks @ Colorado Avalanche',
              market: 'spread',
              side: 'Colorado Avalanche -1.5',
              confidence: 74,
              reason: 'Colorado is 7-3 L10 (+1.1 net margin); Anaheim’s defense remains porous (8 goals allowed last game).'
            },
            {
              row: 'R4',
              event_id: 'nhl-401892752',
              game: 'Utah Mammoth @ Seattle Kraken',
              market: 'ml',
              side: 'Seattle Kraken ML',
              confidence: 65,
              reason: 'Seattle is relatively healthy at forward.'
            }
          ],
          scorecards: []
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        return JSON.stringify({
          analysis: 'Market likes R48 Colorado Avalanche -1.5 (+110).',
          picks: [
            {
              row: 'R48',
              event_id: 'nhl-401892758',
              game: 'Anaheim Ducks @ Colorado Avalanche',
              market: 'spread',
              side: 'Colorado Avalanche -1.5',
              confidence: 73,
              reason: 'COL -1.5 (+110) supported by 7-3 L10 form vs ANA 3-7 (-0.9).'
            }
          ],
          scorecards: []
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        // Stage 2 or Lifecycle critic
        if (prompt.includes('OUTPUT CONTRACT (mandatory)')) {
          return JSON.stringify({
            pass: true,
            feedback: 'Looks reasonable.'
          });
        }
        return JSON.stringify({
          pass: false,
          verdict: 'Veto: R4 Seattle Kraken ML rejected because Jared McCann and Vince Dunn are OUT for Seattle.',
          flags: ['fatal_injury']
        });
      }

      // Manager synthesis / lifecycle retry
      managerCalls++;
      managerPrompts.push(prompt);
      if (managerCalls === 1) {
        // Attempt 1 tries to keep ungrounded claims AND rewrite vetoed R4 Seattle as a recommended single bet
        return JSON.stringify({
          ui_title: 'NHL Slate Picks',
          pass: true,
          summary:
            'Bottom-line call: play R48 Colorado Avalanche -1.5. Anaheim’s defense remains porous (8 goals allowed last game). Although R4 Seattle Kraken ML was vetoed, Seattle is relatively healthy at forward so play Seattle Kraken ML as a recommended single bet.',
          picks: [
            {
              row: 'R48',
              event_id: 'nhl-401892758',
              game: 'Anaheim Ducks @ Colorado Avalanche',
              market: 'spread',
              side: 'Colorado Avalanche -1.5',
              confidence: 74,
              reason: 'Colorado holds a 7-3 L10 (+1.1 net margin) edge over Anaheim (3-7, -0.9).'
            }
          ],
          components: []
        });
      }

      // Attempt 2 removes ungrounded claims and vetoed leg rewrite
      return JSON.stringify({
        ui_title: 'NHL Slate Pick',
        pass: true,
        summary:
          'Bottom-line call: play R48 Colorado Avalanche -1.5 (+110). Both Quant and Market specialists agree on Colorado (7-3 L10, +1.1 net margin) over Anaheim (3-7 L10, -0.9 net margin). The call flips if Colorado scratches a top-six forward before puck drop.',
        picks: [
          {
            row: 'R48',
            event_id: 'nhl-401892758',
            game: 'Anaheim Ducks @ Colorado Avalanche',
            market: 'spread',
            side: 'Colorado Avalanche -1.5',
            confidence: 74,
            reason: 'Colorado 7-3 L10 (+1.1 net margin) vs Anaheim 3-7 L10 (-0.9 net margin).'
          }
        ],
        components: []
      });
    });

    try {
      const result = await executeSwarmWorkflow({
        task: 'Recommend the best NHL parlay today.\nPICK OUTPUT CONTRACT:\nReturn JSON with analysis, picks, scorecards.',
        data: SLATE_ANA_SEA,
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

      // Attempt 1 was vetoed deterministically for grounding violations, triggering Attempt 2
      expect(managerCalls).toBe(2);
      expect(managerPrompts[1]).toContain('CRITICAL RETRY RULES');
      expect(managerPrompts[1]).toContain('6. GROUNDING:');

      const fa = result.finalAnalysis;
      expect(fa).toBeDefined();
      expect(fa.verified).toBe(true);
      expect(fa.picks).toHaveLength(1);
      expect(fa.picks[0].row).toBe('R48');
      expect(fa.picks[0].side).toContain('Colorado Avalanche -1.5');

      const serialized = JSON.stringify(fa);
      expect(serialized).not.toContain('8 goals allowed');
      expect(serialized).not.toMatch(/relatively healthy/i);
      expect(serialized).not.toMatch(/recommended single bet/i);
      expect(fa.picks.some((p: any) => p.row === 'R4' || /Seattle/i.test(String(p.side || p.pick || '')))).toBe(false);

      // Existing injury attribution rule remains intact
      const injAudit = auditInjuryAttribution(
        fa,
        'EVENT nhl-401892752 Utah Mammoth @ Seattle Kraken\nINJ: Seattle Kraken (SEA): Jared McCann (C): OUT',
        SLATE_ANA_SEA
      );
      expect(injAudit.pass).toBe(true);
    } finally {
      runSpy.mockRestore();
    }
  });
});
