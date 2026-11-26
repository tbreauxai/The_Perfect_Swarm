import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ManagerResponseSchema } from '../swarm/schemas.ts';
import { MANAGER_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { guardManagerResponse, normalizeScorecardEntry } from '../swarm/parser/responseGuards.ts';
import { globalProviderLimiter } from '../swarm/providers/limiter.ts';
import {
  auditMissingPicksSchemaViolation,
  hydrateMissingPicksFromSpecialists,
  reconcileFinalVerdictAndPicks
} from '../swarm/tools/criticAudit.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { executeManagerSynthesis } from '../swarm/engine/synthesisPipeline.ts';
import { getMarketMovementTool } from '../swarm/tools/dueloddsRpcTools.ts';

const SLATE_DATA = [
  'Game Slate:',
  'event_id=nba-401910101 | sport=basketball_nba | Boston Celtics @ New York Knicks | options: R1 SPR Boston Celtics -3.5(-110), R2 SPR New York Knicks +3.5(-110)',
  'event_id=nba-401910102 | sport=basketball_nba | Miami Heat @ Orlando Magic | options: R5 SPR Orlando Magic -4.5(-110), R6 SPR Miami Heat +4.5(-110)',
  'event_id=cfb-401856879 | sport=americanfootball_ncaaf | TCU Horned Frogs @ Texas Tech Red Raiders | options: R9 SPR Texas Tech Red Raiders -14.5(-110), R10 SPR TCU Horned Frogs +14.5(-110)'
].join('\n');

const TOOL_EVIDENCE = [
  'EVENT nba-401910101',
  '[MARKET MOVEMENT: nba-401910101] Open: home New York Knicks +3.5 -> Current: home New York Knicks +3.5 | Steam: TOWARD away Boston Celtics (-3.5 -> -3.5) | Health Balance: asymmetric (Boston Celtics healthier)',
  '',
  'EVENT nba-401910102',
  '[MARKET MOVEMENT: nba-401910102] Open: home Orlando Magic -3.5 -> Current: home Orlando Magic -4.5 | Steam: TOWARD home Orlando Magic (-3.5 -> -4.5, 1.0 pt) | AGAINST away Miami Heat (+3.5 -> +4.5)',
  '',
  'EVENT cfb-401856879',
  '[MARKET MOVEMENT: cfb-401856879] Open: home Texas Tech Red Raiders -15.5 -> Current: home Texas Tech Red Raiders -14.5 | Steam: TOWARD away TCU Horned Frogs (+15.5 -> +14.5, 1.0 pt) | AGAINST home Texas Tech Red Raiders (-15.5 -> -14.5)'
].join('\n');

const SPECIALIST_PICKS_A1 = [
  {
    row: 'R1',
    event_id: 'nba-401910101',
    side: 'Boston Celtics -3.5',
    confidence: 0.78,
    reasons: ['Boston Celtics hold a net rating edge and asymmetric roster health.'],
    reason: 'Boston Celtics hold a net rating edge and asymmetric roster health.',
    reasonSource: 'matchup_fundamentals'
  },
  {
    row: 'R5',
    event_id: 'nba-401910102',
    side: 'Orlando Magic -4.5',
    confidence: 0.76,
    reasons: ['Favorable 1.0 pt spread steam toward home Orlando Magic (-3.5 -> -4.5).'],
    reason: 'Favorable 1.0 pt spread steam toward home Orlando Magic (-3.5 -> -4.5).',
    reasonSource: 'market_movement'
  },
  {
    row: 'R10',
    event_id: 'cfb-401856879',
    side: 'TCU Horned Frogs +14.5',
    confidence: 0.75,
    reasons: ['Favorable 1.0 pt spread steam toward away TCU Horned Frogs (+15.5 -> +14.5).'],
    reason: 'Favorable 1.0 pt spread steam toward away TCU Horned Frogs (+15.5 -> +14.5).',
    reasonSource: 'market_movement'
  }
];

const MANAGER_PAYLOAD_OMITTING_PICKS = {
  ui_title: '3-Leg Parlay Card',
  summary: 'Bottom-line call: construct a 3-leg parlay with R1, R10, and R5 based on Quant Proposer and Risk Critic alignment.',
  analysis: 'Selected legs: R1 Boston Celtics -3.5, R5 Orlando Magic -4.5, and R10 TCU Horned Frogs +14.5 all passed Risk Critic review.',
  criticApproved: true,
  scorecards: [
    { seat: 'Quant Proposer', verdict: 'propose', scorecard: 'Proposed R1, R5, R10.' },
    { seat: 'Risk Critic', verdict: 'approve', scorecard: 'Approved R1, R5, R10.' }
  ],
  components: [
    {
      id: 'tbl-1',
      type: 'DataTable',
      props: {
        title: 'Recommended Parlay Legs',
        columns: [
          { key: 'row', header: 'Row' },
          { key: 'pick', header: 'Pick' }
        ],
        rows: [
          { row: 'R1', pick: 'Boston Celtics -3.5' },
          { row: 'R5', pick: 'Orlando Magic -4.5' },
          { row: 'R10', pick: 'TCU Horned Frogs +14.5' }
        ]
      }
    }
  ]
};

describe('wf-1795722858714: Missing Manager picks[] Guard & Recovery + NCAAF 1.0-pt Spread Steam Threshold', () => {
  beforeEach(() => {
    globalProviderLimiter.reset?.();
  });

  afterEach(() => {
    globalProviderLimiter.reset?.();
    vi.restoreAllMocks();
  });

  describe('S1.1: Manager prompt contract, schema preservation & scorecards.scorecard normalization', () => {
    it('places top-level picks[] requirement prominently in MANAGER_SYSTEM_INSTRUCTION and preserves picks in ManagerResponseSchema', () => {
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain(
        "NEVER put picks only in components/DataTable—top-level 'picks' MUST contain every recommended wager; leave 'picks': [] ONLY when intentionally passing with wageringPass: true."
      );
      const parsed = ManagerResponseSchema.safeParse({
        ...MANAGER_PAYLOAD_OMITTING_PICKS,
        picks: SPECIALIST_PICKS_A1,
        wageringPass: false
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.picks).toHaveLength(3);
        expect(parsed.data.wageringPass).toBe(false);
        expect(parsed.data.criticApproved).toBe(true);
      }
    });

    it('normalizes scorecards[].scorecard string into scorecards[].notes without leaving stale scorecard key', () => {
      const norm = normalizeScorecardEntry({
        seat: 'Risk Critic',
        verdict: 'approve',
        scorecard: 'Approved R1, R5, R10.'
      });
      expect(norm).toEqual({
        seat: 'Risk Critic',
        verdict: 'approve',
        notes: 'Approved R1, R5, R10.'
      });
      expect((norm as any).scorecard).toBeUndefined();

      const guarded = guardManagerResponse({
        ...MANAGER_PAYLOAD_OMITTING_PICKS,
        picks: SPECIALIST_PICKS_A1,
        wageringPass: false
      });
      expect((guarded as any).scorecards[0].notes).toBe('Proposed R1, R5, R10.');
      expect((guarded as any).scorecards[1]).toEqual({
        seat: 'Risk Critic',
        verdict: 'approve',
        notes: 'Approved R1, R5, R10.'
      });
    });
  });

  describe('S1.2: Deterministic Verifier rejection for missing/empty picks[] when prose or DataTable recommends wagers', () => {
    it('auditMissingPicksSchemaViolation rejects omitted/empty picks recommending R1, R5, R10 while allowing clean no-bet pass prose', () => {
      const badAudit = auditMissingPicksSchemaViolation(MANAGER_PAYLOAD_OMITTING_PICKS, undefined, SLATE_DATA);
      expect(badAudit.pass).toBe(false);
      expect(badAudit.citedRows).toEqual(['R1', 'R5', 'R10']);
      expect(badAudit.feedback).toContain("Schema violation: top-level 'picks' array is missing or empty");

      const passAudit = auditMissingPicksSchemaViolation(
        {
          ui_title: 'Pass — No Qualified Plays',
          summary: 'Bottom-line call: pass. Cannot construct a parlay because R1 and R5 lack sufficient verified edge.',
          picks: [],
          wageringPass: true,
          components: []
        },
        undefined,
        SLATE_DATA
      );
      expect(passAudit.pass).toBe(true);
    });

    it('rejects Attempt 1 with Schema violation (NOT 0.98 success) and does NOT add R1/R5/R10 to vetoedLegs; passes Attempt 2 when Manager populates picks', async () => {
      const verificationEvents: any[] = [];
      const context = new SwarmContext();
      const addEventOrig = context.addEvent.bind(context);
      context.addEvent = (ev: any) => {
        verificationEvents.push(ev);
        return addEventOrig(ev);
      };

      const managerPrompts: string[] = [];
      let managerCalls = 0;
      const managerAgent = {
        id: 'manager',
        role: 'GodView Compiler',
        provider: 'nvidia',
        modelName: 'nemotron-3.5-lightning-30b-a3b',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async (prompt: string) => {
          managerPrompts.push(prompt);
          managerCalls++;
          if (managerCalls === 1) {
            // Attempt 1: Manager omits top-level picks
            return JSON.stringify(MANAGER_PAYLOAD_OMITTING_PICKS);
          }
          // Attempt 2: Manager fixes schema by populating picks[] and wageringPass: false
          return JSON.stringify({
            ...MANAGER_PAYLOAD_OMITTING_PICKS,
            picks: SPECIALIST_PICKS_A1,
            wageringPass: false
          });
        })
      } as unknown as Agent;

      // Simulate an LLM Critic that lazily returns pass:true on Attempt 1 (like wf-1795722858714)
      const criticAgent = {
        id: 'critic',
        role: 'Risk Critic',
        provider: 'cloudflare',
        modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        setSystemInstruction: vi.fn(),
        getFallbacks: () => [],
        run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'Looks fine.' }))
      } as unknown as Agent;

      const result = await runDeepAnalysisVerification({
        task: 'Construct a 3-leg optimal parlay from today slate.',
        rawInput: SLATE_DATA,
        effectiveDynamicPrompt: `${SLATE_DATA}\n\n[QuantSpecialist Report]:\n${JSON.stringify({ summary: 'Proposed R1, R5, R10.', picks: SPECIALIST_PICKS_A1 })}`,
        effectiveCompiledReports: `[QuantSpecialist Report]:\n${JSON.stringify({ summary: 'Proposed R1, R5, R10.', picks: SPECIALIST_PICKS_A1 })}`,
        effectiveHistoricalContext: '',
        managerAgent,
        analysts: [],
        dedicatedCriticAgent: criticAgent,
        context,
        coveredEventIds: ['nba-401910101', 'nba-401910102', 'cfb-401856879'],
        toolResults: TOOL_EVIDENCE,
        criticVerdictApproved: true,
        hadProposedPicks: true,
        specialistPicks: SPECIALIST_PICKS_A1
      });

      const failedAttempt1Event = verificationEvents.find(
        (ev) => typeof ev?.action === 'string' && ev.action.startsWith('Verification FAILED on attempt 1')
      );
      expect(failedAttempt1Event).toBeDefined();
      expect(failedAttempt1Event.action).toContain("Schema violation: top-level 'picks' array is missing or empty");

      // Attempt 1 feedback must reach Attempt 2 without R1/R5/R10 injected into VETOED LEGS
      expect(managerPrompts.length).toBe(2);
      expect(managerPrompts[1]).toContain("Schema violation: top-level 'picks' array is missing or empty");
      expect(managerPrompts[1]).not.toContain('[VETOED LEGS & CLAIMS');

      expect(result.lifecycleResult.attempts).toBe(2);
      expect(result.lifecycleResult.success).toBe(true);
      expect(result.lifecycleResult.computedRating).toBe(0.88);
      expect(result.lifecycleResult.vetoedLegs ?? []).toHaveLength(0);

      expect(result.finalAnalysis.wageringPass).toBe(false);
      expect(result.finalAnalysis.criticApproved).toBe(true);
      expect(result.finalAnalysis.picks).toHaveLength(3);
      expect(result.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R1', 'R5', 'R10']);
    });
  });

  describe('S1.3: Deterministic Fallback Hydration & Contradictory wageringPass Blocker', () => {
    it('hydrates [R1, R5, R10] from Pass 1 specialist picks with wageringPass: false when Manager omits picks on final attempt', async () => {
      const managerAgent = {
        id: 'manager',
        role: 'GodView Compiler',
        provider: 'nvidia',
        modelName: 'nemotron-3.5-lightning-30b-a3b',
        setSystemInstruction: vi.fn(),
        // Fails to include picks on BOTH Attempt 1 and Attempt 2
        run: vi.fn(async () => JSON.stringify(MANAGER_PAYLOAD_OMITTING_PICKS))
      } as unknown as Agent;

      const criticAgent = {
        id: 'critic',
        role: 'Risk Critic',
        provider: 'cloudflare',
        modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        setSystemInstruction: vi.fn(),
        getFallbacks: () => [],
        run: vi.fn(async () => JSON.stringify({ pass: true, feedback: 'Approved.' }))
      } as unknown as Agent;

      const result = await runDeepAnalysisVerification({
        task: 'Construct a 3-leg optimal parlay from today slate.',
        rawInput: SLATE_DATA,
        effectiveDynamicPrompt: `${SLATE_DATA}\n\n[QuantSpecialist Report]:\n${JSON.stringify({ summary: 'Proposed R1, R5, R10.', picks: SPECIALIST_PICKS_A1 })}`,
        effectiveCompiledReports: `[QuantSpecialist Report]:\n${JSON.stringify({ summary: 'Proposed R1, R5, R10.', picks: SPECIALIST_PICKS_A1 })}`,
        effectiveHistoricalContext: '',
        managerAgent,
        analysts: [],
        dedicatedCriticAgent: criticAgent,
        context: new SwarmContext(),
        coveredEventIds: ['nba-401910101', 'nba-401910102', 'cfb-401856879'],
        toolResults: TOOL_EVIDENCE,
        criticVerdictApproved: true,
        hadProposedPicks: true,
        specialistPicks: SPECIALIST_PICKS_A1
      });

      expect(result.lifecycleResult.attempts).toBe(2);
      expect(result.lifecycleResult.computedRating).toBeLessThan(0.98);
      expect(result.finalAnalysis.picks).toHaveLength(3);
      expect(result.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R1', 'R5', 'R10']);
      expect(result.finalAnalysis.wageringPass).toBe(false);
      expect(result.finalAnalysis.criticApproved).toBe(true);
      expect(result.finalAnalysis.summary).toContain('construct a 3-leg parlay');
    });

    it('never emits contradictory "construct a 3-leg parlay" prose or recommendation DataTable when picks is genuinely empty and wageringPass: true', async () => {
      const contradictoryPassPayload = {
        ...MANAGER_PAYLOAD_OMITTING_PICKS,
        picks: [],
        wageringPass: true,
        criticApproved: false
      };

      const reconciled = reconcileFinalVerdictAndPicks(JSON.parse(JSON.stringify(contradictoryPassPayload)), {
        criticPass1Approved: false
      });
      expect(reconciled.picks).toEqual([]);
      expect(reconciled.wageringPass).toBe(true);
      expect(reconciled.criticApproved).toBe(false);
      expect(reconciled.summary).not.toMatch(/construct a 3-leg parlay/i);
      expect(reconciled.analysis).not.toMatch(/construct a 3-leg parlay/i);
      expect((reconciled.components || []).some((c: any) => c.type === 'DataTable')).toBe(false);

      // Also verify single-pass executeManagerSynthesis scrubs contradictory prose when no matching approved specialist picks exist
      const managerAgent = {
        id: 'manager',
        role: 'GodView Compiler',
        provider: 'nvidia',
        modelName: 'nemotron-3.5-lightning-30b-a3b',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () => JSON.stringify(MANAGER_PAYLOAD_OMITTING_PICKS))
      } as unknown as Agent;

      const synthResult = await executeManagerSynthesis(
        managerAgent,
        SLATE_DATA,
        new SwarmContext(),
        undefined,
        true,
        undefined,
        ['nba-401910101', 'nba-401910102', 'cfb-401856879'],
        {
          toolResults: TOOL_EVIDENCE,
          criticVerdictApproved: false,
          rawBoard: SLATE_DATA
        }
      );
      expect(synthResult.picks).toEqual([]);
      expect(synthResult.wageringPass).toBe(true);
      expect(synthResult.summary).not.toMatch(/construct a 3-leg parlay/i);
      expect((synthResult.components || []).some((c: any) => c.type === 'DataTable')).toBe(false);
    });

    it('hydrateMissingPicksFromSpecialists respects vetoedLegs and never hydrates a vetoed row', () => {
      const draft = JSON.parse(JSON.stringify(MANAGER_PAYLOAD_OMITTING_PICKS));
      const res = hydrateMissingPicksFromSpecialists(draft, {
        specialistPicks: SPECIALIST_PICKS_A1,
        slateText: SLATE_DATA,
        vetoedLegs: [{ rowId: 'R10', teamAliases: ['tcu'], reason: 'Scratch' }],
        criticVerdictApproved: true
      });
      expect(res.hydrated).toBe(false);
      expect(draft.picks).toBeUndefined();
    });
  });

  describe('S2: NCAAF 1.0-pt Spread Steam Threshold (college-football-401856879)', () => {
    it('emits TOWARD away TCU Horned Frogs (+15.5 -> +14.5, 1.0 pt) | AGAINST home Texas Tech Red Raiders (-15.5 -> -14.5) instead of Steam: neutral (1 pts)', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            game_id: 'college-football-401856879',
            sport: 'americanfootball_ncaaf',
            home_team: 'Texas Tech Red Raiders',
            away_team: 'TCU Horned Frogs',
            snapshots_tracked: 6,
            opening: {
              spread: -15.5,
              price: -110,
              ml_home: -820,
              ml_away: 550
            },
            latest: {
              spread: -14.5,
              price: -110,
              ml_home: -670,
              ml_away: 480
            },
            line_delta: 1,
            steam_direction: 'neutral',
            steam_magnitude: 1
          }),
          { status: 200 }
        )
      );

      const res = await (getMarketMovementTool as any).execute(
        { game_id: 'college-football-401856879', market_type: 'all' },
        {
          fetchFn: mockFetch as any,
          env: {
            SUPABASE_URL: 'https://test.supabase.co',
            SUPABASE_ANON_KEY: 'test-anon-key'
          },
          game: {
            event_id: 'college-football-401856879',
            sport: 'americanfootball_ncaaf',
            home_team: 'Texas Tech Red Raiders',
            away_team: 'TCU Horned Frogs'
          }
        }
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain(
        'Steam: TOWARD away TCU Horned Frogs (+15.5 -> +14.5, 1.0 pt) | AGAINST home Texas Tech Red Raiders (-15.5 -> -14.5)'
      );
      expect(res.summary).not.toContain('Steam: neutral (1 pts)');
    });
  });
});
