import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditMarketCoverageAndRowBinding,
  checkPickRowSideBinding,
  extractRowOptions,
} from '../swarm/tools/marketRowBinding.ts';
import { getEventIdForPick, renderHeaders, type GameHeader } from '../swarm/context/gameHeaders.ts';
import {
  auditClaimGrounding,
  auditCriticPremiseContradictions,
  dedupeVetoMessages,
  ensureRiskCriticVetoScorecard,
  normalizePassIfAllLegsVetoed,
} from '../swarm/tools/claimGrounding.ts';
import { NvidiaAdapter } from '../swarm/providers/nvidia.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { buildCompactRunDiagnostics } from '../swarm/engine/runDiagnostics.ts';
import { LimiterSkipError, ProviderLimiter } from '../swarm/providers/limiter.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import {
  normalizeRepairedFallbackOutput,
  selectDecoupledVerifierAgent,
} from '../swarm/engine/verificationPipeline.ts';
import { globalTokenBudgetManager } from '../swarm/loadBalancer.ts';

const MULTI_SPORT_HEADERS: GameHeader[] = [
  {
    eventId: 'nba-401909320',
    sport: 'basketball_nba',
    away: 'Minnesota Timberwolves',
    home: 'Oklahoma City Thunder',
    options: [
      { id: 'R1', text: 'ML Oklahoma City Thunder(-240)' },
      { id: 'R2', text: 'ML Minnesota Timberwolves(+195)' },
    ],
  },
  {
    eventId: 'nhl-401892791',
    sport: 'icehockey_nhl',
    away: 'Utah Mammoth',
    home: 'Minnesota Wild',
    options: [
      { id: 'R3', text: 'ML Utah Mammoth(+125)' },
      { id: 'R4', text: 'ML Minnesota Wild(-150)' },
    ],
  },
  {
    eventId: 'nba-401909321',
    sport: 'basketball_nba',
    away: 'New York Knicks',
    home: 'Boston Celtics',
    options: [
      { id: 'R5', text: 'ML New York Knicks(+140)' },
      { id: 'R6', text: 'ML Boston Celtics(-165)' },
    ],
  },
  {
    eventId: 'nhl-401892792',
    sport: 'icehockey_nhl',
    away: 'New York Islanders',
    home: 'New York Rangers',
    options: [
      { id: 'R7', text: 'ML New York Islanders(+135)' },
      { id: 'R8', text: 'ML New York Rangers(-160)' },
    ],
  },
  {
    eventId: 'nba-401909322',
    sport: 'basketball_nba',
    away: 'Chicago Bulls',
    home: 'Miami Heat',
    options: [
      { id: 'R9', text: 'ML Chicago Bulls(+180)' },
      { id: 'R10', text: 'ML Miami Heat(-220)' },
    ],
  },
  {
    eventId: 'nhl-401892793',
    sport: 'icehockey_nhl',
    away: 'Chicago Blackhawks',
    home: 'Detroit Red Wings',
    options: [
      { id: 'R11', text: 'ML Chicago Blackhawks(+175)' },
      { id: 'R12', text: 'ML Detroit Red Wings(-210)' },
    ],
  },
];

const MULTI_SPORT_SLATE = renderHeaders(MULTI_SPORT_HEADERS);

const origNvidiaAdapter = ProviderRegistry.get('nvidia');
const origGeminiAdapter = ProviderRegistry.get('gemini');

describe('wf-1795635950672: Cross-Sport row_side_mismatch, a1 Unparsed Failover, Veto Dedupe & Verifier Scoping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (origNvidiaAdapter) ProviderRegistry.register(origNvidiaAdapter);
    if (origGeminiAdapter) ProviderRegistry.register(origGeminiAdapter);
    globalTokenBudgetManager.reset();
  });

  // =========================================================================
  // S1 — Cross-Sport City-Collision Fix in row_side_mismatch
  // =========================================================================
  describe('S1: Cross-Sport City-Collision Disambiguation (Wild vs Timberwolves, Knicks vs Rangers/Islanders, Bulls vs Blackhawks)', () => {
    it('does NOT veto R4 Minnesota Wild even when nba-401909320 (Minnesota Timberwolves) appears earlier on the slate', () => {
      const rowMap = extractRowOptions([MULTI_SPORT_SLATE], MULTI_SPORT_HEADERS);
      expect(rowMap.get('R4')?.eventId).toBe('nhl-401892791');

      const pick = { row: 'R4', side: 'Minnesota Wild', odds: '-150' };

      const binding = checkPickRowSideBinding(pick, rowMap);
      expect(binding.valid).toBe(true);
      expect(binding.reason).toBeUndefined();

      const eventId = getEventIdForPick(pick, MULTI_SPORT_HEADERS);
      expect(eventId).toBe('nhl-401892791');

      const audit = auditMarketCoverageAndRowBinding(
        { picks: [pick] },
        'nhl-401892791: ML Minnesota Wild(-150) confirmed in odds feed.',
        MULTI_SPORT_SLATE,
        MULTI_SPORT_HEADERS,
      );
      expect(audit.pass).toBe(true);
      expect(audit.flags).not.toContain('row_side_mismatch');
    });

    it('normalizes wrong cross-sport reasonSource to row when row and side both agree on nhl-401892791', () => {
      const rowMap = extractRowOptions([MULTI_SPORT_SLATE], MULTI_SPORT_HEADERS);
      const pick: Record<string, any> = {
        row: 'R4',
        side: 'Minnesota Wild',
        reasonSource: 'nba-401909320',
        odds: '-150',
      };

      const binding = checkPickRowSideBinding(pick, rowMap);
      expect(binding.valid).toBe(true);
      expect(pick.reasonSource).toBe('R4');

      const audit = auditMarketCoverageAndRowBinding(
        { picks: [pick] },
        'nhl-401892791: ML Minnesota Wild(-150) confirmed.',
        MULTI_SPORT_SLATE,
        MULTI_SPORT_HEADERS,
      );
      expect(audit.pass).toBe(true);
      expect(audit.flags).not.toContain('row_side_mismatch');
    });

    it('DOES trigger row_side_mismatch when R4 (Minnesota Wild) is paired with Minnesota Timberwolves', () => {
      const rowMap = extractRowOptions([MULTI_SPORT_SLATE], MULTI_SPORT_HEADERS);
      const badPick = { row: 'R4', side: 'Minnesota Timberwolves', odds: '+195' };

      const binding = checkPickRowSideBinding(badPick, rowMap);
      expect(binding.valid).toBe(false);
      expect(binding.reason).toMatch(/R4/i);

      const audit = auditMarketCoverageAndRowBinding(
        { picks: [badPick] },
        'nhl-401892791: ML Minnesota Wild(-150) | nba-401909320: ML Minnesota Timberwolves(+195)',
        MULTI_SPORT_SLATE,
        MULTI_SPORT_HEADERS,
      );
      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('row_side_mismatch');
    });

    it('disambiguates New York Knicks vs Islanders/Rangers and Chicago Bulls vs Blackhawks across NBA/NHL', () => {
      const rowMap = extractRowOptions([MULTI_SPORT_SLATE], MULTI_SPORT_HEADERS);

      // Valid matches
      expect(checkPickRowSideBinding({ row: 'R5', side: 'New York Knicks' }, rowMap).valid).toBe(true);
      expect(checkPickRowSideBinding({ row: 'R7', side: 'New York Islanders' }, rowMap).valid).toBe(true);
      expect(checkPickRowSideBinding({ row: 'R8', side: 'New York Rangers' }, rowMap).valid).toBe(true);
      expect(checkPickRowSideBinding({ row: 'R9', side: 'Chicago Bulls' }, rowMap).valid).toBe(true);
      expect(checkPickRowSideBinding({ row: 'R11', side: 'Chicago Blackhawks' }, rowMap).valid).toBe(true);

      // Event ID resolution must never collide across sports on shared city names
      expect(getEventIdForPick({ side: 'New York Islanders' }, MULTI_SPORT_HEADERS)).toBe('nhl-401892792');
      expect(getEventIdForPick({ side: 'New York Rangers' }, MULTI_SPORT_HEADERS)).toBe('nhl-401892792');
      expect(getEventIdForPick({ side: 'New York Knicks' }, MULTI_SPORT_HEADERS)).toBe('nba-401909321');
      expect(getEventIdForPick({ side: 'Chicago Blackhawks' }, MULTI_SPORT_HEADERS)).toBe('nhl-401892793');
      expect(getEventIdForPick({ side: 'Chicago Bulls' }, MULTI_SPORT_HEADERS)).toBe('nba-401909322');

      // True cross-sport mismatches MUST still be vetoed
      expect(checkPickRowSideBinding({ row: 'R8', side: 'New York Knicks' }, rowMap).valid).toBe(false);
      expect(checkPickRowSideBinding({ row: 'R5', side: 'New York Rangers' }, rowMap).valid).toBe(false);
      expect(checkPickRowSideBinding({ row: 'R7', side: 'New York Rangers' }, rowMap).valid).toBe(false);
      expect(checkPickRowSideBinding({ row: 'R11', side: 'Chicago Bulls' }, rowMap).valid).toBe(false);
      expect(checkPickRowSideBinding({ row: 'R9', side: 'Chicago Blackhawks' }, rowMap).valid).toBe(false);
    });
  });

  // =========================================================================
  // S2 — NVIDIA Nemotron Reasoning Config & a1 Unparsed Output Failover
  // =========================================================================
  describe('S2: NVIDIA Reasoning Model Payload & Proposer Unparsed-JSON Failover', () => {
    it('sends chat_template_kwargs.enable_thinking=false and max_tokens>=4096 for nvidia/nemotron-3-ultra-550b-a55b JSON requests', async () => {
      const capturedBodies: any[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url: any, init: any) => {
        if (init?.body) capturedBodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ picks: [], summary: 'Pass' }) } }],
          }),
          text: async () => JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ picks: [], summary: 'Pass' }) } }],
          }),
        } as any;
      }) as any;

      try {
        const adapter = new NvidiaAdapter();
        const out = await adapter.call({
          role: 'Quant Proposer',
          modelName: 'nvidia/nemotron-3-ultra-550b-a55b',
          apiKey: 'nvapi-test-key',
          prompt: 'Propose 1 NHL ML pick in JSON.',
          timeoutMs: 60000,
          config: {
            responseMimeType: 'application/json',
            maxTokens: 1800,
          },
        });
        expect(JSON.parse(out)).toEqual({ picks: [], summary: 'Pass' });
        expect(capturedBodies).toHaveLength(1);
        expect(capturedBodies[0].max_tokens).toBeGreaterThanOrEqual(4096);
        expect(capturedBodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
        expect(capturedBodies[0].reasoning_effort).toBe('none');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('treats truncated <think> output on a1 as parse_failed, fails over to gemini-3.5-flash-lite, and records reason=unparsed_json with <=120-char snippet', async () => {
      const truncatedThink =
        '<think>Let me analyze Utah Mammoth at Minnesota Wild deeply across every metric and possession stat ' +
        'without ever reaching the closing think tag or emitting a valid JSON object... ' +
        'x'.repeat(200);

      let nvidiaCalls = 0;
      let geminiCalls = 0;

      ProviderRegistry.register({
        providerName: 'nvidia',
        async call() {
          nvidiaCalls++;
          return truncatedThink;
        },
      } as any);

      ProviderRegistry.register({
        providerName: 'gemini',
        async call() {
          geminiCalls++;
          return JSON.stringify({
            picks: [{ row: 'R4', side: 'Minnesota Wild', odds: '-150' }],
            summary: 'Recovered clean JSON from Gemini 3.5 Flash Lite',
          });
        },
      } as any);

      const quantAgent = new Agent(
        'Quant Proposer',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'nvidia',
        'nvapi-key',
        undefined,
        [{ provider: 'gemini', modelName: 'gemini-3.5-flash-lite', apiKey: 'gem-key' }],
      );
      quantAgent.preserveFallbackOrder = true;

      const ctx = new SwarmContext();
      const result = await quantAgent.run('Propose best slate pick in JSON.', ctx, {
        responseMimeType: 'application/json',
        maxTokens: 1800,
        bypassCache: true,
      });

      expect(nvidiaCalls).toBe(1);
      expect(geminiCalls).toBe(1);
      expect(result).toBeTypeOf('object');
      expect(result.picks).toHaveLength(1);
      expect(result.picks[0].side).toBe('Minnesota Wild');

      const diag = buildCompactRunDiagnostics({
        events: ctx.events,
        totalMs: 1200,
      });
      expect(diag.failovers).toHaveLength(1);
      expect(diag.failovers[0].seat).toBe('a1');
      expect(diag.failovers[0].from).toBe('nvidia/nemotron-3-ultra-550b-a55b');
      expect(diag.failovers[0].to).toBe('gemini/gemini-3.5-flash-lite');
      expect(diag.failovers[0].reason).toBe('unparsed_json');
      expect(diag.failovers[0].error.length).toBeLessThanOrEqual(120);
      expect(diag.seatTimings.some(t => t.seat === 'a1' && t.status === 'failover')).toBe(true);
    });
  });

  // =========================================================================
  // S3 — Veto Deduplication, Instant Limiter Skip, and Scoped Verifier
  // =========================================================================
  describe('S3: Veto Deduplication, 0ms Limiter Skip, and Scoped Verifier (<=3,000 tokens + gemini-3.5-flash-lite)', () => {
    it('emits a single row_side_mismatch veto exactly once across summary, analysis, reason, insights, and scorecards[0].notes', () => {
      const triplePrefixedSpam = [
        'Veto: Row side mismatch — R4 is "ML Minnesota Wild(-150)", not "Minnesota Timberwolves".',
        'Veto (GROUNDING): row_side_mismatch: R4 is "ML Minnesota Wild(-150)", not "Minnesota Timberwolves".',
        'Veto (PREMISE): row_side_mismatch: R4 is "ML Minnesota Wild(-150)", not "Minnesota Timberwolves".',
      ];
      const joined9xSpam = [
        triplePrefixedSpam.join(' '),
        triplePrefixedSpam.join(' | '),
        triplePrefixedSpam.join(' | '),
      ].join(' | ');

      const deduped = dedupeVetoMessages([...triplePrefixedSpam, joined9xSpam]);
      expect(deduped).toHaveLength(1);

      // Verify skipRowSideCheck prevents duplicate emission when marketRowAudit already flagged row_side_mismatch
      const badProposal = {
        picks: [{ row: 'R4', side: 'Minnesota Timberwolves', odds: '+195' }],
        summary: 'Minnesota Timberwolves via R4.',
      };
      const groundingWithSkip = auditClaimGrounding(badProposal, '', MULTI_SPORT_SLATE, {
        headers: MULTI_SPORT_HEADERS,
        skipRowSideCheck: true,
      });
      expect(groundingWithSkip.flags).not.toContain('row_side_mismatch');
      const premiseWithSkip = auditCriticPremiseContradictions(badProposal, '', MULTI_SPORT_SLATE, {
        headers: MULTI_SPORT_HEADERS,
        skipRowSideCheck: true,
      });
      expect(premiseWithSkip.flags).not.toContain('row_side_mismatch');

      // Normalize repaired fallback output with 9x duplicated veto text -> must appear ONCE everywhere
      const normalized: Record<string, any> = normalizeRepairedFallbackOutput<Record<string, any>>(
        {
          picks: [],
          summary: joined9xSpam,
          analysis: joined9xSpam,
          reason: joined9xSpam,
          insights: [joined9xSpam],
          scorecards: [
            {
              seat: 'Risk Critic',
              verdict: 'veto',
              notes: joined9xSpam,
            },
          ],
        },
        {
          reasons: [...triplePrefixedSpam, joined9xSpam],
          headers: MULTI_SPORT_HEADERS,
          slateText: MULTI_SPORT_SLATE,
        },
      );

      const countOccurrences = (text: string) =>
        (String(text || '').match(/ML Minnesota Wild\(-150\)/gi) || []).length;

      expect(countOccurrences(normalized.summary)).toBe(1);
      expect(countOccurrences(normalized.analysis)).toBe(1);
      expect(countOccurrences(normalized.reason)).toBe(1);
      expect(countOccurrences(normalized.scorecards[0].notes)).toBe(1);
      expect(normalized.verification?.reasons).toHaveLength(1);

      // Also verify normalizePassIfAllLegsVetoed + ensureRiskCriticVetoScorecard keep count === 1
      const passReport: Record<string, any> = normalizePassIfAllLegsVetoed<Record<string, any>>(
        {
          picks: [],
          summary: '',
          analysis: '',
        },
        1,
        true,
        {
          vetoTexts: [...triplePrefixedSpam, joined9xSpam],
          criticApproved: false,
        },
      );
      ensureRiskCriticVetoScorecard(passReport, { vetoReason: joined9xSpam });
      expect(countOccurrences(passReport.summary)).toBe(1);
      expect(countOccurrences(passReport.analysis)).toBe(1);
      expect(countOccurrences(passReport.reason)).toBe(1);
      expect(countOccurrences(passReport.scorecards[0].notes)).toBe(1);
    });

    it('skips in <50ms when estimatedWaitMs (18000ms) exceeds maxBudgetWaitMs (5000ms) instead of sleeping 5s', async () => {
      let fakeNow = 1_000_000;
      let sleptMs = 0;
      const limiter = new ProviderLimiter(
        {
          groq: {
            concurrency: 1,
            minSpacingMs: 0,
            tokensPerMinute: 8000,
            maxBudgetWaitMs: 5000,
          },
        },
        () => fakeNow,
        async (ms: number) => {
          sleptMs += ms;
          fakeNow += ms;
        },
      );

      // Record 7500 tokens at fakeNow = 1,000,000 via a completed call
      await limiter.run(
        { provider: 'groq', model: 'openai/gpt-oss-120b', estTokens: 7500, maxBudgetWaitMs: 5000 },
        async () => 'ok',
      );
      fakeNow = 1_042_000; // 42s elapsed -> 18,000ms remaining in 60s TPM window

      const estWait = limiter.budgetWaitMs('groq', 2000, 'openai/gpt-oss-120b');
      expect(estWait).toBeGreaterThanOrEqual(17_900);
      expect(estWait).toBeLessThanOrEqual(18_100);

      // Even while a concurrent request holds the slot OR when slot is idle, skip happens in <50ms (0ms sleep)
      const wallStart = Date.now();
      await expect(
        limiter.run(
          { provider: 'groq', model: 'openai/gpt-oss-120b', estTokens: 2000, maxBudgetWaitMs: 5000 },
          async () => 'should-never-run',
        ),
      ).rejects.toBeInstanceOf(LimiterSkipError);
      const wallElapsed = Date.now() - wallStart;

      expect(wallElapsed).toBeLessThan(50);
      expect(sleptMs).toBe(0);
    });

    it('scopes Verifier prompt to <=3,000 input tokens on a 20-game slate (both 0-pick pass and 2-leg parlay) and prefers gemini-3.5-flash-lite', async () => {
      vi.stubEnv('GEMINI_API_KEY', 'gem-test-key');
      vi.stubEnv('GROQ_API_KEY', 'gsk-test-key');

      // 1. Verifier Gemini model preference: gemini-3.5-flash-lite ahead of gemini-3.1-flash-lite
      const managerAgent = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'gemini', 'gem-test-key');
      const pass1Critic = new Agent('Risk Critic', 'openai/gpt-oss-120b', 'groq', 'gsk-test-key');
      const routeCtx = new SwarmContext();
      const verifier = selectDecoupledVerifierAgent({
        baseCriticAgent: pass1Critic,
        managerAgent,
        analysts: [pass1Critic],
        context: routeCtx,
      });
      expect(verifier.provider).toBe('gemini');
      expect(verifier.modelName).toBe('gemini-3.5-flash-lite');

      // 2. Build a realistic 20-game slate + massive 45,000-char dossier (~11,500 tokens)
      const twentyHeaders: GameHeader[] = Array.from({ length: 20 }, (_, i) => {
        const id = `nhl-40189${String(1000 + i)}`;
        const rAway = `R${i * 2 + 1}`;
        const rHome = `R${i * 2 + 2}`;
        const away = `AwayClub${i + 1}`;
        const home = `HomeClub${i + 1}`;
        return {
          eventId: id,
          sport: 'icehockey_nhl',
          away,
          home,
          options: [
            { id: rAway, text: `ML ${away}(+120)` },
            { id: rHome, text: `ML ${home}(-140)` },
          ],
        };
      });
      const twentyGames = renderHeaders(twentyHeaders);

      const hugeDossier = twentyHeaders
        .map(h => {
          return (
            `### ${h.eventId} ${h.away} @ ${h.home}\n` +
            `Odds: ml_home=-140, ml_away=+120 (${h.options[1].id}: ${h.options[1].text}).\n` +
            `Team Stats: ` +
            `xGF 3.12, Corsi 52.4%, PP 23.1%, PK 81.4%, Goalie SV% .918. `.repeat(35)
          );
        })
        .join('\n\n');
      expect(hugeDossier.length).toBeGreaterThan(40_000);

      // 2a. Verify 0-pick pass sends <= 3,000 tokens (<= 12,000 chars) to Critic Verifier
      const capturedVerifierPrompts: string[] = [];
      const proposerZero = new Agent('Manager Node', 'mock-m', 'simulated', 'mock');
      const criticVerifier = new Agent('Risk Critic', 'mock-c', 'simulated', 'mock');

      vi.spyOn(proposerZero, 'run').mockResolvedValue({
        picks: [],
        pass: true,
        status: 'no_play',
        summary: 'Pass: no qualified edges on the 20-game slate.',
      });
      vi.spyOn(criticVerifier, 'run').mockImplementation(async (prompt: string) => {
        capturedVerifierPrompts.push(prompt);
        return { pass: true, feedback: 'Clean pass verified.' };
      });

      const lifecycleZero = new AnalysisLifecycle(proposerZero, criticVerifier, 1);
      await lifecycleZero.executeAndVerify(
        {
          fullBoard: twentyGames,
          allHeaders: twentyHeaders,
          toolResults: hugeDossier,
          secondaryContext: 'Prior round notes: ' + 'verbose context '.repeat(400),
          coveredEventIds: ['nhl-401891000', 'nhl-401891001'],
        },
        new SwarmContext(),
        'Compile picks',
        'Verify the compiled output against grounded evidence.',
      );

      expect(capturedVerifierPrompts).toHaveLength(1);
      const zeroPassTokens = Math.ceil(capturedVerifierPrompts[0].length / 4);
      expect(zeroPassTokens).toBeLessThanOrEqual(3000);

      // 2b. Verify 2-leg parlay on 20-game slate also stays <= 3,000 input tokens and scopes to referenced games
      const capturedParlayPrompts: string[] = [];
      const proposerParlay = new Agent('Manager Node', 'mock-m', 'simulated', 'mock');
      const criticParlay = new Agent('Risk Critic', 'mock-c', 'simulated', 'mock');

      vi.spyOn(proposerParlay, 'run').mockResolvedValue({
        picks: [
          { row: 'R2', side: 'HomeClub1', odds: '-140', event_id: 'nhl-401891000' },
          { row: 'R4', side: 'HomeClub2', odds: '-140', event_id: 'nhl-401891001' },
        ],
        summary: '2-leg parlay on HomeClub1 (R2) and HomeClub2 (R4).',
      });
      vi.spyOn(criticParlay, 'run').mockImplementation(async (prompt: string) => {
        capturedParlayPrompts.push(prompt);
        return { pass: true, feedback: '2-leg parlay verified.' };
      });

      const lifecycleParlay = new AnalysisLifecycle(proposerParlay, criticParlay, 1);
      await lifecycleParlay.executeAndVerify(
        {
          fullBoard: twentyGames,
          allHeaders: twentyHeaders,
          toolResults: hugeDossier,
          secondaryContext: 'Prior round notes: ' + 'verbose context '.repeat(400),
          coveredEventIds: ['nhl-401891000', 'nhl-401891001'],
        },
        new SwarmContext(),
        'Compile picks',
        'Verify the compiled output against grounded evidence.',
      );

      expect(capturedParlayPrompts).toHaveLength(1);
      const parlayTokens = Math.ceil(capturedParlayPrompts[0].length / 4);
      expect(parlayTokens).toBeLessThanOrEqual(3000);
      // Must include referenced games and omit unreferenced games from the 20-game slate
      expect(capturedParlayPrompts[0]).toContain('nhl-401891000');
      expect(capturedParlayPrompts[0]).toContain('nhl-401891001');
      expect(capturedParlayPrompts[0]).not.toContain('nhl-401891019');
    });
  });
});
