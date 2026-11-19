import { describe, it, expect, vi } from 'vitest';
import {
  VETO_STICKS_RULE,
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
import { executeManagerSynthesis } from '../swarm/engine/synthesisPipeline.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';

const SLATE_3LEG_NHL = [
  'event_id=nhl-ott-1 | sport=icehockey_nhl | Ottawa Senators @ Detroit Red Wings | commence=2026-11-19T00:00:00Z | options: R1 Ottawa Senators ML (-125), R2 Detroit Red Wings ML (+105)',
  'event_id=nhl-chi-2 | sport=icehockey_nhl | Chicago Blackhawks @ Buffalo Sabres | commence=2026-11-19T00:30:00Z | options: R3 Chicago Blackhawks ML (-110), R4 Buffalo Sabres ML (-110)',
  'event_id=nhl-van-3 | sport=icehockey_nhl | Vancouver Canucks @ Seattle Kraken | commence=2026-11-19T03:00:00Z | options: R5 Vancouver Canucks +1.5 (-145), R6 Seattle Kraken -1.5 (+125)'
].join('\n');

const EVIDENCE_3LEG_NHL = [
  'event_id=nhl-ott-1 | Ottawa Senators: L5=3-2 | team_games last4: W-W-W-L (3-1), GF 3.2 GA 2.6 | INJ: Detroit Red Wings: Dylan Larkin: PROBABLE | ml_home: +105, ml_away: -125',
  'event_id=nhl-chi-2 | Chicago Blackhawks: L5=4-1 | team_games last4: W-W-W-W (4-0), GF 3.5 GA 2.2 | INJ: Chicago Blackhawks: no significant injuries | ml_home: -110, ml_away: -110',
  'event_id=nhl-van-3 | Vancouver Canucks: L5=3-2 | team_games last4: W-L-W-W (3-1), GF 3.0 GA 2.5 | INJ: Vancouver Canucks: Thatcher Demko: QUESTIONABLE | spread: -1.5 (+125) / +1.5 (-145), ml_home: -140, ml_away: +120'
].join('\n');

describe('Swarm Fix: A grounding veto must stick', () => {
  it('(1) injects verbatim VETO_STICKS_RULE across instructions, Verification Critic, and CRITICAL RETRY RULES', async () => {
    const expectedLines = [
      'VETO STICKS:',
      '- A Critic veto for ungrounded form, missing market, or fatal injury removes that leg.',
      '- Do not repeat the vetoed claim in a later attempt or in the final analysis.',
      '- Do not put a vetoed leg back into picks.',
      '- If every leg is vetoed, the result is a pass.'
    ];
    expect(VETO_STICKS_RULE).toBe(expectedLines.join('\n'));
    expect(GROUNDING_RULE).toContain('GROUNDING:');

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
        rawInput: SLATE_3LEG_NHL,
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
      for (const line of expectedLines) {
        expect(captured[0]).toContain(line);
      }
    }

    const retryPrompts: string[] = [];
    const proposer: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      run: vi.fn(async (p: string) => {
        retryPrompts.push(p);
        return JSON.stringify({ summary: 'Clean pass', picks: [] });
      })
    };
    let cCount = 0;
    const critic: any = {
      role: 'Critic',
      provider: 'groq',
      modelName: 'mock-c',
      run: vi.fn(async () => {
        cCount++;
        return cCount === 1
          ? JSON.stringify({ pass: false, feedback: 'Veto (GROUNDING): Ottawa Senators ungrounded 3-0-1 form (R1).' })
          : JSON.stringify({ pass: true, feedback: 'Verified.' });
      })
    };
    await new AnalysisLifecycle(proposer, critic, 2).executeAndVerify(
      { rawBoard: SLATE_3LEG_NHL },
      new SwarmContext(),
      'Compile',
      'Audit',
      ['nhl-ott-1']
    );
    expect(retryPrompts.length).toBe(2);
    expect(retryPrompts[1]).toContain('CRITICAL RETRY RULES:');
    expect(retryPrompts[1]).toContain('8. VETO STICKS:');
    expect(retryPrompts[1]).toContain('[VETOED LEGS & CLAIMS — DO NOT INCLUDE]');
  });

  it('(2) drops vetoed Ottawa ML leg + ungrounded 3-0-1 form on retry while keeping grounded Chicago ML and Vancouver +1.5', async () => {
    const proposerPrompts: string[] = [];
    let attempt = 0;
    const mockManager: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async (prompt: string) => {
        attempt++;
        proposerPrompts.push(prompt);
        if (attempt === 1) {
          return JSON.stringify({
            ui_title: '3-Leg NHL Parlay',
            summary: 'Ottawa enters in 3-0-1 form over their last four games. Parlay: Ottawa ML + Chicago ML + Vancouver +1.5.',
            picks: [
              {
                row: 'R1',
                event_id: 'nhl-ott-1',
                side: 'Ottawa Senators ML',
                odds: -125,
                reason: 'Ottawa carries 3-0-1 form into Detroit.'
              },
              {
                row: 'R3',
                event_id: 'nhl-chi-2',
                side: 'Chicago Blackhawks ML',
                odds: -110,
                reason: 'Chicago enters 4-0 in team_games last4.'
              },
              {
                row: 'R5',
                event_id: 'nhl-van-3',
                side: 'Vancouver Canucks +1.5',
                odds: -145,
                reason: 'Vancouver sits 3-1 in team_games last4.'
              }
            ],
            components: [
              {
                id: 'rec_bets_1',
                type: 'DataTable',
                props: {
                  title: 'Recommended Bets',
                  columns: [
                    { key: 'Row', header: 'Row' },
                    { key: 'Pick', header: 'Pick' },
                    { key: 'Reason', header: 'Reason' }
                  ],
                  rows: [
                    { Row: 'R1', Pick: 'Ottawa Senators ML', Reason: '3-0-1 form' },
                    { Row: 'R3', Pick: 'Chicago Blackhawks ML', Reason: '4-0 form' },
                    { Row: 'R5', Pick: 'Vancouver Canucks +1.5', Reason: '3-1 last4' }
                  ]
                }
              }
            ]
          });
        }
        return JSON.stringify({
          ui_title: '2-Leg NHL Parlay',
          summary: 'Chicago ML + Vancouver +1.5 based on verified team_games form.',
          picks: [
            {
              row: 'R3',
              event_id: 'nhl-chi-2',
              side: 'Chicago Blackhawks ML',
              odds: -110,
              reason: 'Chicago enters 4-0 in team_games last4.'
            },
            {
              row: 'R5',
              event_id: 'nhl-van-3',
              side: 'Vancouver Canucks +1.5',
              odds: -145,
              reason: 'Vancouver sits 3-1 in team_games last4.'
            }
          ]
        });
      })
    };
    const mockCritic: any = {
      role: 'Verification Critic',
      provider: 'groq',
      modelName: 'mock-c',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'Verified.' }))
    };

    const res = await runDeepAnalysisVerification({
      task: 'Build a 3-leg NHL parlay',
      rawInput: SLATE_3LEG_NHL,
      effectiveDynamicPrompt: 'Recommend grounded NHL parlay.',
      effectiveCompiledReports: 'Quant reports gathered.',
      effectiveHistoricalContext: '',
      managerAgent: mockManager,
      analysts: [],
      dedicatedCriticAgent: mockCritic,
      context: new SwarmContext(),
      coveredEventIds: ['nhl-ott-1', 'nhl-chi-2', 'nhl-van-3'],
      toolResults: EVIDENCE_3LEG_NHL
    });

    expect(res.lifecycleResult.attempts).toBe(2);
    expect(res.lifecycleResult.success).toBe(true);
    expect(proposerPrompts[1]).toContain('3-0-1');
    expect(proposerPrompts[1]).toContain('Ottawa');
    expect(res.finalAnalysis.verified).toBe(true);
    expect(res.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R3', 'R5']);
    const serialized = JSON.stringify(res.finalAnalysis);
    expect(serialized).not.toContain('3-0-1');
    expect(serialized).not.toMatch(/Ottawa/i);
  });

  it('(3) blocks stubborn proposer/compiler from restoring vetoed leg or claim even when retries are exhausted', async () => {
    const stubbornProposal = {
      ui_title: '3-Leg NHL Parlay',
      summary: 'Ottawa enters in 3-0-1 form. Recommended parlay: Ottawa ML + Chicago ML + Vancouver +1.5.',
      analysis: 'Ottawa ML benefits from 3-0-1 form over its last 4 games. Chicago ML and Vancouver +1.5 are strong.',
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-ott-1',
          side: 'Ottawa Senators ML',
          odds: -125,
          reason: 'Ottawa carries 3-0-1 form over last 4.'
        },
        {
          row: 'R3',
          event_id: 'nhl-chi-2',
          side: 'Chicago Blackhawks ML',
          odds: -110,
          reason: 'Chicago enters 4-0 in team_games last4.'
        },
        {
          row: 'R5',
          event_id: 'nhl-van-3',
          side: 'Vancouver Canucks +1.5',
          odds: -145,
          reason: 'Vancouver sits 3-1 in team_games last4.'
        }
      ],
      components: [
        {
          id: 'rec_bets_stubborn',
          type: 'DataTable',
          props: {
            title: 'Recommended Bets',
            columns: [
              { key: 'Row', header: 'Row' },
              { key: 'Pick', header: 'Pick' },
              { key: 'Reason', header: 'Reason' }
            ],
            rows: [
              { Row: 'R1', Pick: 'Ottawa Senators ML', Reason: '3-0-1 form' },
              { Row: 'R3', Pick: 'Chicago Blackhawks ML', Reason: '4-0 in team_games last4' },
              { Row: 'R5', Pick: 'Vancouver Canucks +1.5', Reason: '3-1 in team_games last4' }
            ]
          }
        }
      ]
    };

    const mockManager: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () => JSON.stringify(stubbornProposal))
    };
    const mockCritic: any = {
      role: 'Verification Critic',
      provider: 'groq',
      modelName: 'mock-c',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'ok' }))
    };

    const res = await runDeepAnalysisVerification({
      task: 'Build a 3-leg NHL parlay',
      rawInput: SLATE_3LEG_NHL,
      effectiveDynamicPrompt: 'Recommend grounded NHL parlay.',
      effectiveCompiledReports: 'Reports.',
      effectiveHistoricalContext: '',
      managerAgent: mockManager,
      analysts: [],
      dedicatedCriticAgent: mockCritic,
      context: new SwarmContext(),
      coveredEventIds: ['nhl-ott-1', 'nhl-chi-2', 'nhl-van-3'],
      toolResults: EVIDENCE_3LEG_NHL
    });

    // Exhausted retries keep remaining grounded picks (Q3) and strip vetoed leg + claim everywhere.
    expect(res.finalAnalysis.verified).toBe(false);
    expect(res.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R3', 'R5']);
    expect(res.finalAnalysis.summary).toContain('Chicago ML + Vancouver +1.5');
    expect(res.finalAnalysis.summary).not.toContain('3-0-1');
    expect(res.finalAnalysis.summary).not.toMatch(/Ottawa/i);
    expect(res.finalAnalysis.analysis).not.toContain('3-0-1');
    expect(res.finalAnalysis.analysis).not.toMatch(/Ottawa ML/i);
    const table = res.finalAnalysis.components.find((c: any) => c.type === 'DataTable');
    expect(table.props.rows.map((r: any) => r.Row)).toEqual(['R3', 'R5']);

    // Direct executeManagerSynthesis must also enforce Stage 2 / prior vetoes
    const synRes = await executeManagerSynthesis(
      mockManager,
      `Task:\nBuild parlay\n\nBoard:\n${SLATE_3LEG_NHL}`,
      new SwarmContext(),
      undefined,
      true,
      undefined,
      ['nhl-ott-1', 'nhl-chi-2', 'nhl-van-3'],
      {
        toolResults: EVIDENCE_3LEG_NHL,
        rawBoard: SLATE_3LEG_NHL,
        criticVetoes: ['Veto (GROUNDING): Ungrounded record/form claim ("3-0-1") on Ottawa Senators (R1).']
      }
    );
    expect(synRes.picks.map((p: any) => p.row)).toEqual(['R3', 'R5']);
    expect(JSON.stringify(synRes)).not.toContain('3-0-1');
    expect(JSON.stringify(synRes.picks)).not.toMatch(/Ottawa/i);
  });

  it('(4) strips prose-only ungrounded claim from opening analysis without vetoing grounded pick', () => {
    const proposal = {
      summary: 'Ottawa enters in 3-0-1 form over its last 4 games. Best leg is Ottawa ML.',
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-ott-1',
          side: 'Ottawa Senators ML',
          odds: -125,
          reason: 'Ottawa sits 3-1 across team_games last4.'
        }
      ]
    };

    const audit = auditClaimGrounding(proposal, EVIDENCE_3LEG_NHL, SLATE_3LEG_NHL);
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('ungrounded_form_claim');
    expect(audit.vetoedClaims).toContain('3-0-1');
    // Pick reasoning itself was grounded ("3-1"), so Ottawa leg was NOT added to vetoedLegs
    expect(audit.vetoedLegs ?? []).toHaveLength(0);

    const sanitized = sanitizeUngroundedClaims(
      structuredClone(proposal),
      EVIDENCE_3LEG_NHL,
      SLATE_3LEG_NHL,
      {
        vetoedClaims: audit.vetoedClaims,
        vetoedLegs: audit.vetoedLegs
      }
    );
    expect(sanitized.summary).not.toContain('3-0-1');
    expect(sanitized.picks).toHaveLength(1);
    expect(sanitized.picks[0].row).toBe('R1');
  });

  it('(5) enforces veto persistence equally for fatal injury vetoes and missing-market vetoes', async () => {
    const proposalWithInjuryAndMissingMkt = {
      summary: 'Ottawa ML (R1) + Chicago ML (R3) + Vancouver +1.5 (R5).',
      picks: [
        {
          row: 'R1',
          event_id: 'nhl-ott-1',
          side: 'Ottawa Senators ML',
          odds: -125,
          reason: 'Ottawa benefits from Detroit missing injured Dylan Larkin.'
        },
        {
          row: 'R3',
          event_id: 'nhl-chi-2',
          side: 'Chicago Blackhawks ML',
          odds: -110,
          reason: 'Chicago enters 4-0 in team_games last4.'
        }
      ]
    };

    // Simulate a stubborn proposer across retries while Stage 2 Critic vetoed R1 for fatal injury & Chicago had a prior missing-market veto
    const mockManager: any = {
      role: 'Manager',
      provider: 'openrouter',
      modelName: 'mock-m',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () => JSON.stringify(proposalWithInjuryAndMissingMkt))
    };
    const mockCritic: any = {
      role: 'Verification Critic',
      provider: 'groq',
      modelName: 'mock-c',
      setSystemInstruction: vi.fn(),
      run: vi.fn(async () => JSON.stringify({
        pass: false,
        feedback: 'Veto (INJURY): fatal injury invalidates Ottawa Senators ML (R1). Veto: missing market for Chicago Blackhawks ML (R3).'
      }))
    };

    // Pass all 2 legs vetoed => must normalize to a Pass (picks: [])
    const resAllVetoed = await runDeepAnalysisVerification({
      task: 'Parlay check',
      rawInput: SLATE_3LEG_NHL,
      effectiveDynamicPrompt: 'Check parlay',
      effectiveCompiledReports: 'Reports',
      effectiveHistoricalContext: '',
      managerAgent: mockManager,
      analysts: [],
      dedicatedCriticAgent: mockCritic,
      context: new SwarmContext(),
      toolResults: EVIDENCE_3LEG_NHL,
      criticVetoes: [
        'Veto (INJURY): fatal injury removes Ottawa Senators ML (R1).',
        'Veto: missing market coverage for Chicago Blackhawks ML (R3).'
      ]
    });

    expect(resAllVetoed.finalAnalysis.picks).toEqual([]);
    expect(resAllVetoed.finalAnalysis.pass).toBe(true);
    expect(resAllVetoed.finalAnalysis.status).toBe('no_play');

    // Now test single injury veto via Stage 2 while keeping Vancouver +1.5 grounded
    const partialRes = await executeManagerSynthesis(
      mockManager,
      `Task:\nParlay\n\nBoard:\n${SLATE_3LEG_NHL}`,
      new SwarmContext(),
      undefined,
      true,
      undefined,
      ['nhl-ott-1', 'nhl-chi-2'],
      {
        toolResults: EVIDENCE_3LEG_NHL,
        rawBoard: SLATE_3LEG_NHL,
        criticVetoes: ['Veto (INJURY): fatal injury removes Ottawa Senators ML (R1).']
      }
    );
    expect(partialRes.picks.map((p: any) => p.row)).toEqual(['R3']);
    expect(partialRes.summary).not.toMatch(/Ottawa/i);
  });
});
