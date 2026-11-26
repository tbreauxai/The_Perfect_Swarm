import { describe, it, expect, vi } from 'vitest';
import {
  auditClaimGrounding,
  auditCriticPremiseContradictions,
} from '../swarm/tools/claimGrounding.ts';
import {
  MANAGER_SYSTEM_INSTRUCTION,
  NO_ROUNDED_PPG_RULE,
} from '../swarm/engine/constants.ts';
import {
  sanitizeCompilerProposalOddsAndSummary,
  sanitizeMoneylinePriceMoves,
} from '../swarm/parser/responseGuards.ts';
import {
  normalizeRepairedFallbackOutput,
  runDeepAnalysisVerification,
} from '../swarm/engine/verificationPipeline.ts';
import { executeManagerSynthesis } from '../swarm/engine/synthesisPipeline.ts';
import { SwarmContext } from '../swarm/context.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

const WF_SLATE = [
  'event_id=nba-lal-1 | sport=basketball_nba | Utah Jazz @ Los Angeles Lakers | commence=2026-11-23T03:30:00Z | options: R35 Utah Jazz +13.5 (-110), R36 Los Angeles Lakers -13.5 (-114)',
  'event_id=nba-hou-2 | sport=basketball_nba | Washington Wizards @ Houston Rockets | commence=2026-11-23T01:00:00Z | options: R31 Washington Wizards +12.5 (-112), R32 Houston Rockets -12.5 (-110)',
  'event_id=nba-min-3 | sport=basketball_nba | Brooklyn Nets @ Minnesota Timberwolves | commence=2026-11-23T01:00:00Z | options: R12 Brooklyn Nets +12.5 (-110), R13 Minnesota Timberwolves -12.5 (-118)',
].join('\n');

const WF_EVIDENCE = [
  '=== GAME DOSSIER: nba-lal-1 | Utah Jazz @ Los Angeles Lakers ===',
  '[MATCHUP FUNDAMENTALS: nba-lal-1] Los Angeles Lakers: L5=4-1, PF/PA 119.8 / 113.0, H2H: LAL vs UTA 121-107 (W) | Utah Jazz: L5=1-4, PF/PA 104.2 / 118.4',
  '[INJURY DELTA: nba-lal-1] Summary: Los Angeles Lakers (0 OUT [unweighted_fallback], 0 Q) vs Utah Jazz (4 OUT [unweighted_fallback], 1 Q) | Health Balance: home_advantage (Los Angeles Lakers)',
  '[MARKET MOVEMENT: nba-lal-1] spread: -13.5 (-114) / +13.5 (-110) | Spread Steam: neutral',
  '',
  '=== GAME DOSSIER: nba-hou-2 | Washington Wizards @ Houston Rockets ===',
  '[MATCHUP FUNDAMENTALS: nba-hou-2] Houston Rockets: L5=4-1, PF/PA 117.4 / 106.0 | Washington Wizards: L5=0-5, PF/PA 102.6 / 119.2',
  '[INJURY DELTA: nba-hou-2] Summary: Houston Rockets (0 OUT [unweighted_fallback], 0 Q) vs Washington Wizards (3 OUT [unweighted_fallback], 1 Q) | Health Balance: home_advantage (Houston Rockets)',
  '[MARKET MOVEMENT: nba-hou-2] spread: -12.5 (-110) / +12.5 (-112) | Spread Steam: neutral',
  '',
  '=== GAME DOSSIER: nba-min-3 | Brooklyn Nets @ Minnesota Timberwolves ===',
  '[MATCHUP FUNDAMENTALS: nba-min-3] Minnesota Timberwolves: L5=4-1, PF/PA 114.8 / 108.5 | Brooklyn Nets: L5=1-4, PF/PA 103.5 / 114.0',
  '[INJURY DELTA: nba-min-3] Summary: Minnesota Timberwolves (3 OUT [unweighted_fallback], 0 Q) vs Brooklyn Nets (1 OUT [unweighted_fallback], 1 Q) | Health Balance: away_advantage (Brooklyn Nets)',
  'Minnesota Timberwolves: Anthony Edwards: OUT, Naz Reid: OUT, Mike Conley: OUT | Brooklyn Nets: Cam Thomas: OUT',
  '[MARKET MOVEMENT: nba-min-3] spread: -12.5 (-118) / +12.5 (-110) | Spread Steam: neutral',
].join('\n');

const WF_HEADERS = parseGameHeaders(WF_SLATE);

describe('wf-1795446433463 fixes (S1, S2, S3)', () => {
  describe('S1: Catch symmetric_injury_misread across proposer analysis & blanket pillar claims', () => {
    it('flags symmetric_injury_misread specifically on R13 when a1 analysis claims blanket asymmetric health, keeping R36 and R32 unvetoed', () => {
      const a1Report = {
        seat: 'a1',
        analysis: 'Each leg satisfies form/diff edge + asymmetric health (2 pillars).',
        picks: [
          { row: 'R36', side: 'Los Angeles Lakers -13.5', reason: 'Strong L5=4-1 form and scoring differential edge.' },
          { row: 'R32', side: 'Houston Rockets -12.5', reason: 'Strong L5=4-1 form and net margin edge.' },
          { row: 'R13', side: 'Minnesota Timberwolves -12.5', reason: 'Strong L5=4-1 form and home scoring differential.' },
        ],
      };

      const audit = auditCriticPremiseContradictions(
        {
          picks: a1Report.picks,
          analysis: a1Report.analysis,
          seatReports: [a1Report],
        },
        WF_EVIDENCE,
        WF_SLATE,
        { headers: WF_HEADERS },
      );

      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('symmetric_injury_misread');
      expect(audit.vetoedLegs).toBeDefined();
      const vetoedRowIds = (audit.vetoedLegs || []).map(v => v.rowId);
      expect(vetoedRowIds).toEqual(['R13']);
      expect(vetoedRowIds).not.toContain('R36');
      expect(vetoedRowIds).not.toContain('R32');
    });

    it('flags symmetric_injury_misread on R13 for blanket 2-pillar claims when spread steam is neutral and MIN is disadvantaged', () => {
      const a1Report = {
        seat: 'a1',
        analysis: 'All three legs satisfy 2 pillars based on form/diff and roster edge.',
        picks: [
          { row: 'R36', side: 'Los Angeles Lakers -13.5', reason: 'L5=4-1 edge.' },
          { row: 'R32', side: 'Houston Rockets -12.5', reason: 'L5=4-1 edge.' },
          { row: 'R13', side: 'Minnesota Timberwolves -12.5', reason: 'L5=4-1 edge.' },
        ],
      };

      const audit = auditCriticPremiseContradictions(
        {
          picks: a1Report.picks,
          seatReports: [a1Report],
        },
        WF_EVIDENCE,
        WF_SLATE,
        { headers: WF_HEADERS },
      );

      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('symmetric_injury_misread');
      expect((audit.vetoedLegs || []).map(v => v.rowId)).toEqual(['R13']);
    });
  });

  describe('S2: Surgical leg-prune rescue, _repaired:true pass fallback hygiene, and Rule-4 odds scrubber', () => {
    it('rescues clean legs [R36, R32] via surgical leg-prune when final verification retry rejects only MIN -12.5 (R13)', async () => {
      const mockManager: any = {
        id: 'mgr',
        role: 'Manager Node',
        provider: 'openrouter',
        modelName: 'mock-mgr',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () =>
          JSON.stringify({
            ui_title: 'NBA 3-Leg Spread Parlay',
            summary:
              'Proceed with a 3-leg spread parlay: LAL -13.5 (R36), HOU -12.5 (R32), and MIN -12.5 (R13), all spreads between -110 and -118.',
            analysis:
              'LAL -13.5 (R36) backs 119.8 PF/G after a 121-107 win. HOU -12.5 (R32) backs 117.4 PF/G against Washington. MIN -12.5 (R13) is priced at -118.',
            picks: [
              { row: 'R36', side: 'Los Angeles Lakers -13.5', reason: '119.8 PF/G and home_advantage health edge.' },
              { row: 'R32', side: 'Houston Rockets -12.5', reason: '117.4 PF/G and home_advantage health edge.' },
              { row: 'R13', side: 'Minnesota Timberwolves -12.5', reason: '115 PPG edge.' },
            ],
            components: [
              {
                id: 'c1',
                type: 'InsightList',
                props: {
                  title: 'Selected Legs',
                  insights: [
                    { type: 'info', message: '[R36] Los Angeles Lakers -13.5 — 119.8 PF/G.' },
                    { type: 'info', message: '[R32] Houston Rockets -12.5 — 117.4 PF/G.' },
                    { type: 'info', message: '[R13] Minnesota Timberwolves -12.5 — Anthony Edwards OUT.' },
                  ],
                },
              },
            ],
          }),
        ),
      };

      const mockCritic: any = {
        id: 'critic',
        role: 'Verification Critic',
        provider: 'groq',
        modelName: 'mock-critic',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () =>
          JSON.stringify({
            pass: false,
            feedback: 'Reject MIN -12.5 (R13): Minnesota has Health Balance away_advantage with Anthony Edwards OUT.',
          }),
        ),
      };

      const { finalAnalysis } = await runDeepAnalysisVerification({
        task: 'Build an NBA spread parlay',
        rawInput: WF_SLATE,
        effectiveDynamicPrompt: 'Compile NBA spread parlay',
        effectiveCompiledReports: 'a1 proposed R36, R32, R13',
        effectiveHistoricalContext: '',
        managerAgent: mockManager,
        analysts: [],
        dedicatedCriticAgent: mockCritic,
        context: new SwarmContext(),
        coveredEventIds: ['nba-lal-1', 'nba-hou-2', 'nba-min-3'],
        toolResults: WF_EVIDENCE,
      });

      expect(finalAnalysis.picks.map((pk: any) => pk.row)).toEqual(['R36', 'R32']);
      expect(finalAnalysis.summary).not.toMatch(/\bR13\b|Timberwolves|MIN\s*-12\.5/i);
      expect(finalAnalysis.summary).not.toMatch(/between\s+-110\s+and\s+-118/i);
      expect(finalAnalysis.analysis).not.toMatch(/\bR13\b|priced\s+at\s+-118/i);
    });

    it('emits consistent pass fallback on _repaired:true with picks:[] — explicit booleans, Risk Critic veto scorecard, and zero contradictory recommendation prose', () => {
      const brokenRepaired: any = {
        _repaired: true,
        verified: false,
        ui_title: 'Executive Swarm Synthesis',
        summary:
          '[UNVERIFIED] Proceed with a 3-leg spread parlay: LAL -13.5 (R36), HOU -12.5 (R32), MIN -12.5 (R13); all spreads between -110 and -118.',
        analysis:
          'Risk Critic approved all three legs (LAL -13.5, HOU -12.5, MIN -12.5) priced between -110 and -118.',
        picks: [],
        components: [],
      };

      normalizeRepairedFallbackOutput(brokenRepaired, {
        reasons: ['Verifier rejected MIN -12.5 (R13) due to away_advantage health balance'],
        seatScorecards: [
          { seat: 'Quant Proposer', verdict: 'approve', notes: 'Proposed 3 spread legs.' },
        ],
        markUnverified: true,
      });

      expect(brokenRepaired.picks).toEqual([]);
      expect(brokenRepaired.criticApproved).toBe(false);
      expect(brokenRepaired.wageringPass).toBe(true);
      expect(brokenRepaired.pass).toBe(true);
      expect(Array.isArray(brokenRepaired.scorecards)).toBe(true);
      expect(brokenRepaired.scorecards.length).toBeGreaterThanOrEqual(2);
      const criticCard = brokenRepaired.scorecards.find((s: any) => /risk\s*critic/i.test(String(s.seat || '')));
      expect(criticCard).toBeDefined();
      expect(criticCard.verdict).toBe('veto');
      expect(criticCard.criticApproved).toBe(false);
      expect(criticCard.wageringPass).toBe(true);
      expect(brokenRepaired.verification?.reasons).toContain(
        'Verifier rejected MIN -12.5 (R13) due to away_advantage health balance',
      );
      expect(brokenRepaired.summary.toLowerCase()).toContain('pass');
      expect(brokenRepaired.analysis.toLowerCase()).toContain('pass');
      expect(brokenRepaired.summary).not.toMatch(/Proceed with a 3-leg/i);
      expect(brokenRepaired.analysis).not.toMatch(/Proceed with a 3-leg|Risk Critic approved all three/i);
      expect(brokenRepaired.summary).not.toMatch(/between\s+-110\s+and\s+-118/i);
    });

    it('Rule-4 sanitizer removes non-parenthetical American price ranges while preserving spreads (-13.5, -12.5) and H2H scores (121-107)', () => {
      const text =
        'LAL -13.5 (R36) and HOU -12.5 (R32) after a 121-107 H2H win, all spreads between -110 and -118, with LAL priced at -114 and HOU -110 to -118.';
      const cleaned = sanitizeMoneylinePriceMoves(text);

      expect(cleaned).not.toMatch(/between\s+-110\s+and\s+-118/i);
      expect(cleaned).not.toMatch(/-110\s+to\s+-118/i);
      expect(cleaned).not.toMatch(/priced\s+at\s+-114/i);
      expect(cleaned).toContain('-13.5');
      expect(cleaned).toContain('-12.5');
      expect(cleaned).toContain('121-107');

      const proposal = sanitizeCompilerProposalOddsAndSummary({
        summary: 'LAL -13.5 (R36) and HOU -12.5 (R32), all spreads between -110 and -118.',
        analysis: 'LAL beat UTA 121-107; spreads priced at -114 (-110 to -118).',
        picks: [
          {
            row: 'R36',
            side: 'Los Angeles Lakers -13.5',
            reasons: ['121-107 H2H win; all spreads between -110 and -118.'],
          },
        ],
        insights: ['LAL -13.5 priced at -114 after 121-107 win.'],
      });

      expect(proposal.summary).not.toMatch(/between\s+-110\s+and\s+-118/i);
      expect(proposal.summary).toContain('-13.5');
      expect(proposal.summary).toContain('-12.5');
      expect(proposal.analysis).toContain('121-107');
      expect(proposal.analysis).not.toMatch(/priced\s+at\s+-114|-110\s+to\s+-118/i);
      expect(proposal.picks[0].reasons[0]).toContain('121-107');
      expect(proposal.picks[0].reasons[0]).not.toMatch(/between\s+-110\s+and\s+-118/i);
      expect(proposal.insights[0]).toContain('-13.5');
      expect(proposal.insights[0]).toContain('121-107');
      expect(proposal.insights[0]).not.toMatch(/priced\s+at\s+-114/i);
    });
  });

  describe('S3: Stop Manager from inventing rounded PPG averages while grounding exact PF/PA decimals', () => {
    it('includes NO_ROUNDED_PPG_RULE in MANAGER_SYSTEM_INSTRUCTION and injects it into custom Compiler instructions', async () => {
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain(NO_ROUNDED_PPG_RULE);
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain("NEVER round or estimate PPG / scoring averages (e.g., '115 PPG')");

      const capturedInstructions: string[] = [];
      const mockManager: any = {
        id: 'compiler',
        role: 'GodView Compiler',
        provider: 'openrouter',
        modelName: 'mock-mgr',
        setSystemInstruction: vi.fn((instr: string) => capturedInstructions.push(instr)),
        run: vi.fn(async () => JSON.stringify({ ui_title: 'Pass', summary: 'Pass.', picks: [], components: [] })),
      };

      await executeManagerSynthesis(
        mockManager,
        'Task:\nBuild parlay',
        new SwarmContext(),
        undefined,
        true,
        { managerInstruction: 'Custom GodView Compiler prompt.' } as any,
      );

      expect(capturedInstructions[0]).toContain('Custom GodView Compiler prompt.');
      expect(capturedInstructions[0]).toContain(NO_ROUNDED_PPG_RULE);
    });

    it('passes deterministic grounding for verbatim PF/PA values (119.8, 113.0 / 113) and fails rounded 115 PPG', () => {
      const groundedProposal = {
        summary: 'Los Angeles Lakers -13.5 (R36) average 119.8 PF/G while allowing 113 PA/G (113.0 PA/G).',
        picks: [
          {
            row: 'R36',
            side: 'Los Angeles Lakers -13.5',
            reason: 'Lakers post 119.8 PF/G and hold opponents to 113 PPG.',
          },
        ],
      };

      const groundedAudit = auditClaimGrounding(groundedProposal, WF_EVIDENCE, WF_SLATE, {
        headers: WF_HEADERS,
      });
      expect(groundedAudit.pass).toBe(true);
      expect(groundedAudit.violations).toEqual([]);

      const roundedProposal = {
        summary: 'Minnesota Timberwolves -12.5 (R13) are averaging 115 PPG at home.',
        picks: [
          {
            row: 'R13',
            side: 'Minnesota Timberwolves -12.5',
            reason: 'Timberwolves score 115 PPG.',
          },
        ],
      };

      const roundedAudit = auditClaimGrounding(roundedProposal, WF_EVIDENCE, WF_SLATE, {
        headers: WF_HEADERS,
      });
      expect(roundedAudit.pass).toBe(false);
      expect(roundedAudit.violations.join(' ')).toMatch(/Ungrounded form\/score claim.*115 PPG/i);
    });
  });
});
