import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compileSynthesisPrompt, MANAGER_MAX_PROMPT_CHARS } from '../swarm/engine/synthesisPipeline.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import {
  DEFAULT_PROVIDER_MODELS,
  GEMINI_FREE_TIER_MODELS,
  isAllowedFreeTierGeminiModel,
  remapDeprecatedGeminiModel,
  rankModelsForAccount,
  fetchProviderModels,
  clearCatalogCache,
} from '../swarm/server/modelsProvider.ts';
import {
  ProviderLimiter,
  LimiterSkipError,
  PROMPT_EXCEEDS_LIMIT_REASON,
  globalProviderLimiter,
  MODEL_COOLDOWN_MS,
  GEMINI_503_RETRY_MIN_MS,
  GEMINI_503_RETRY_MAX_MS,
} from '../swarm/providers/limiter.ts';
import { MANAGER_CHAIN } from '../swarm/engine/managerChain.ts';
import { resolveSwarmAgents } from '../swarm/engine/agentResolution.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { GeminiAdapter } from '../swarm/providers/gemini.ts';
import { buildPartialFinalAnalysis } from '../swarm/engine/partialResult.ts';
import {
  evaluateQualitativePillars,
  formatUnifiedPerGameDossier,
  type UnifiedGameDossierEntry,
} from '../swarm/engine/unifiedDossier.ts';

function makeClock(start: number) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('Consolidated Spec (wf-1795448851648 + Nov 2026 Gemini Catalog): S1–S5', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCatalogCache();
    globalProviderLimiter.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearCatalogCache();
    globalProviderLimiter.reset();
    ProviderRegistry.register(new GeminiAdapter());
  });

  describe('S1: Scope Manager synthesis context to proposed/approved games (<= 9,000 chars)', () => {
    it('scopes 17-game slate + dossiers strictly to the 3 proposed games and stays <= 9,000 chars', () => {
      const gameIds: string[] = [];
      const slateLines: string[] = [];
      const dossierBlocks: string[] = [];

      for (let i = 1; i <= 17; i++) {
        const evId = `nba-4019100${String(i).padStart(2, '0')}`;
        gameIds.push(evId);
        const rHome = `R${i * 4 - 3}`;
        const rAway = `R${i * 4 - 2}`;
        const awayTeam = `AwayTeam${i}`;
        const homeTeam = `HomeTeam${i}`;
        slateLines.push(
          `${evId} | NBA | ${awayTeam} @ ${homeTeam} | ${rHome}: ${homeTeam} -4.5 (-110) | ${rAway}: ${awayTeam} +4.5 (-110)`,
        );
        const block = [
          `=== GAME DOSSIER: ${evId} (${awayTeam} @ ${homeTeam}) ===`,
          `Rows: ${rHome}:${homeTeam} -4.5 | ${rAway}:${awayTeam} +4.5`,
          `Fundamentals: Home (${homeTeam}): W-L 42-25 | PF/PA 116.2/109.1 | Net Margin +7.1 | L5: 4-1 | Away (${awayTeam}): W-L 30-37 | PF/PA 108.4/112.9 | Net Margin -4.5 | L5: 2-3`,
          `Injuries: Health Balance: home_advantage | Summary: ${awayTeam} (3 OUT, 1 Q) vs ${homeTeam} (0 OUT, 0 Q) | ${awayTeam} StarterA OUT, StarterB OUT, BenchC OUT`,
          `Market: Side Steam: TOWARD home ${homeTeam} | Consensus spread moved from -3.0 to -4.5 across 6 books.`,
        ].join('\n');
        // Intentionally inject duplicate copies to verify deduplication too
        dossierBlocks.push(block, block);
      }

      const rawInput = slateLines.join('\n');
      const full17GameEvidence = [
        '=== TOP PILLAR CANDIDATES (QUALITATIVE) ===',
        ...gameIds.map((id) => `- ${id} [2 pillars (home): form=HOME, health=home_advantage]`),
        '',
        ...dossierBlocks,
      ].join('\n\n');

      // Verify raw full evidence is massive (> 15k chars)
      expect(full17GameEvidence.length).toBeGreaterThan(15000);

      // Analysts proposed ONLY 3 games: #2, #7, #15
      const proposedIds = ['nba-401910002', 'nba-401910007', 'nba-401910015'];
      const repeatedProse =
        'HomeTeam2 holds a +11.6 net margin edge with three AwayTeam2 starters ruled OUT and directional side steam toward HomeTeam2.';

      const a1 = new Agent('Quant Proposer', 'gemini-3.5-flash-lite', 'gemini', 'k1');
      const a2 = new Agent('Market Analyst', 'openai/gpt-oss-120b', 'groq', 'k2');
      const manager = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'gemini', 'km');
      const ctx = new SwarmContext();

      const res = compileSynthesisPrompt({
        task: 'Build a 3-leg NBA parlay from tonight slate.',
        rawInput,
        analysts: [a1, a2],
        managerAgent: manager,
        allAnalystReports: [
          [
            {
              seat: 'a1',
              role: 'Quant Proposer',
              summary: repeatedProse,
              insights: [repeatedProse, 'HomeTeam7 and HomeTeam15 also show aligned health edges.'],
              picks: [
                { row: 'R5', eventId: proposedIds[0], pick: 'HomeTeam2 -4.5' },
                { row: 'R25', eventId: proposedIds[1], pick: 'HomeTeam7 -4.5' },
                { row: 'R57', eventId: proposedIds[2], pick: 'HomeTeam15 -4.5' },
              ],
              coveredEventIds: gameIds,
              toolEvidence: full17GameEvidence,
              toolEvidenceItems: gameIds.map((id) => ({ eventId: id, tool: 'get_matchup_fundamentals', summary: 'dup' })),
            },
          ],
          [
            {
              seat: 'a2',
              role: 'Market Analyst',
              summary: repeatedProse,
              insights: [repeatedProse],
              picks: [{ row: 'R5', eventId: proposedIds[0], pick: 'HomeTeam2 -4.5' }],
              coveredEventIds: gameIds,
              toolEvidence: full17GameEvidence,
            },
          ],
        ],
        clusterDigests: {},
        historicalContext: '',
        settings: {} as any,
        context: ctx,
        params: { isBettingRun: true, originApp: 'duelodds', eventIds: gameIds } as any,
        bypassCache: true,
        verifierEvidence: full17GameEvidence,
      });

      const prompt = res.effectiveDynamicPrompt;
      expect(prompt.length).toBeLessThanOrEqual(MANAGER_MAX_PROMPT_CHARS);
      expect(prompt.length).toBeLessThanOrEqual(9000);

      // Must include ONLY the 3 proposed games' slate rows and dossiers
      for (const keepId of proposedIds) {
        expect(prompt).toContain(keepId);
      }
      // Must NOT include the other 14 non-proposed games in slate or dossiers
      const nonProposedIds = gameIds.filter((id) => !proposedIds.includes(id));
      for (const dropId of nonProposedIds) {
        expect(prompt).not.toContain(dropId);
      }
    });
  });

  describe('S2: Nov 2026 Gemini Free-Tier Catalog, Remapping, Groq Infinityms Fix, & Failover Chain', () => {
    it('catalog includes active Nov 2026 free models, excludes retired/paid models, and auto-remaps gemini-2.5/2.0', async () => {
      expect(DEFAULT_PROVIDER_MODELS.gemini).toBe('gemini-3.5-flash-lite');
      expect(GEMINI_FREE_TIER_MODELS).toContain('gemini-3.5-flash-lite');
      expect(GEMINI_FREE_TIER_MODELS).toContain('gemini-3.1-flash-lite');
      expect(GEMINI_FREE_TIER_MODELS).toContain('gemini-3.8-flash');

      // Allowed free-tier models
      for (const id of [
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemma-4-31b-it',
        'gemma-4-26b-a4b-it',
      ]) {
        expect(isAllowedFreeTierGeminiModel(id)).toBe(true);
      }

      // Excluded retired, paid-only, and non-text models
      for (const blocked of [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-4-argon',
        'gemini-4-carbon',
        'gemini-4-neon',
        'gemini-3.1-pro-preview',
        'gemini-3.5-flash-image',
        'gemini-3.5-flash-tts',
        'gemini-3.5-flash-live',
        'veo-3.0-generate',
        'imagen-4.0',
        'gemini-omni-flash',
        'text-embedding-004',
      ]) {
        expect(isAllowedFreeTierGeminiModel(blocked)).toBe(false);
      }

      // Transparent remapping of retired overrides
      expect(remapDeprecatedGeminiModel('gemini-2.5-flash')).toBe('gemini-3.5-flash-lite');
      expect(remapDeprecatedGeminiModel('gemini-2.5-flash-lite')).toBe('gemini-3.5-flash-lite');
      expect(remapDeprecatedGeminiModel('gemini-2.5-pro')).toBe('gemini-3.5-flash-lite');
      expect(remapDeprecatedGeminiModel('gemini-2.0-flash')).toBe('gemini-3.5-flash-lite');
      expect(remapDeprecatedGeminiModel('gemini-3.1-flash-lite')).toBe('gemini-3.1-flash-lite');

      // Verify GeminiAdapter also transparently remaps retired IDs
      const genMock = vi.fn().mockResolvedValue({
        text: '{"ok":true}',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      });
      const adapter = new GeminiAdapter();
      await adapter.call({
        modelName: 'gemini-2.5-flash',
        prompt: 'ping',
        apiKey: 'fake-key',
        aiClient: { models: { generateContent: genMock } } as any,
      });
      expect(genMock.mock.calls[0][0].model).toBe('gemini-3.5-flash-lite');
    });

    it('Groq bucket: requestedTokens > bucketCapacity or refillRate === 0 NEVER returns Infinity or Infinityms', async () => {
      const clock = makeClock(Date.UTC(2026, 10, 23, 12, 0, 0));
      const limiterOver = new ProviderLimiter(
        {
          groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 7000, maxInputTokens: 1500 },
        },
        clock.now,
        clock.sleep,
      );

      // Case 1: requestedTokens > bucketCapacity (12,000 > 7,000)
      const waitOver = limiterOver.budgetWaitMs('groq', 12000);
      expect(Number.isFinite(waitOver)).toBe(true);
      expect(String(waitOver)).not.toContain('Infinity');

      await expect(
        limiterOver.run({ provider: 'groq', model: 'openai/gpt-oss-120b', estTokens: 12000 }, async () => 'never'),
      ).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(LimiterSkipError);
        expect(err.reason).toBe(PROMPT_EXCEEDS_LIMIT_REASON);
        expect(err.message).not.toContain('Infinity');
        return true;
      });

      // Case 2: refillRate === 0 (tokensPerMinute === 0)
      const limiterZero = new ProviderLimiter(
        {
          groq: { concurrency: 1, minSpacingMs: 0, tokensPerMinute: 0, maxInputTokens: 1500 },
        },
        clock.now,
        clock.sleep,
      );
      const waitZero = limiterZero.budgetWaitMs('groq', 500);
      expect(Number.isFinite(waitZero)).toBe(true);
      expect(String(waitZero)).not.toContain('Infinity');

      await expect(
        limiterZero.run({ provider: 'groq', model: 'openai/gpt-oss-120b', estTokens: 500 }, async () => 'never'),
      ).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(LimiterSkipError);
        expect(err.reason).toBe(PROMPT_EXCEEDS_LIMIT_REASON);
        expect(err.message).not.toContain('Infinity');
        return true;
      });
    });

    it('Gemini 503: retries once (1200-2000ms) and succeeds; if 503 twice, fails over to gemini-3.1-flash-lite -> gemini-3.8-flash before external providers', async () => {
      // Part A: Limiter 1x jittered retry (1200–2000ms) on single 503 -> succeeds
      const clock = makeClock(Date.UTC(2026, 10, 23, 12, 0, 0));
      const limiter = new ProviderLimiter(
        { gemini: { concurrency: 2, minSpacingMs: 0, maxInputTokens: 8000 } },
        clock.now,
        clock.sleep,
      );

      let attempts = 0;
      const singleRetryResult = await limiter.run(
        { provider: 'gemini', model: 'gemini-3.5-flash-lite', estTokens: 500 },
        async () => {
          attempts++;
          if (attempts === 1) throw new Error('[SERVER_ERROR_503] 503 model overloaded due to high demand');
          return 'recovered-on-retry';
        },
      );
      expect(singleRetryResult).toBe('recovered-on-retry');
      expect(attempts).toBe(2);
      expect(clock.sleeps).toHaveLength(1);
      expect(clock.sleeps[0]).toBeGreaterThanOrEqual(GEMINI_503_RETRY_MIN_MS);
      expect(clock.sleeps[0]).toBeLessThanOrEqual(GEMINI_503_RETRY_MAX_MS);

      // Part B: Full Manager chain order & sibling failover before leaving Gemini
      vi.stubEnv('GEMINI_API_KEY', 'gem-key');
      vi.stubEnv('GROQ_API_KEY', 'groq-key');
      vi.stubEnv('MISTRAL_API_KEY', 'mis-key');
      vi.stubEnv('CLOUDFLARE_API_TOKEN', 'acc:cf-key');
      vi.stubEnv('OPENROUTER_API_KEY', '');
      vi.stubEnv('NVIDIA_API_KEY', 'nv-key');

      expect(MANAGER_CHAIN.map((e) => `${e.provider}:${e.model}`)).toEqual([
        'gemini:gemini-3.5-flash-lite',
        'gemini:gemini-3.1-flash-lite',
        'gemini:gemini-3.8-flash',
        'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        'mistral:mistral-small-latest',
        'openrouter:nvidia/nemotron-3.5-lightning:free',
        'groq:openai/gpt-oss-120b',
        'nvidia:nvidia/nemotron-3.5-lightning-30b-a3b',
      ]);

      const { managerAgent } = resolveSwarmAgents(
        {
          agents: [
            { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-2.5-flash' } as any,
            { id: 'a1', role: 'Quant', provider: 'groq', model: 'openai/gpt-oss-20b' } as any,
          ],
        } as any,
        undefined,
      );
      // Persisted gemini-2.5-flash auto-remapped to gemini-3.5-flash-lite
      expect(managerAgent.modelName).toBe('gemini-3.5-flash-lite');
      // Gemini siblings preserved BEFORE external providers, and high-TPM providers ahead of Groq
      const fbIds = managerAgent.getFallbacks().map((f) => `${f.provider}:${f.modelName}`);
      expect(fbIds.slice(0, 6)).toEqual([
        'gemini:gemini-3.1-flash-lite',
        'gemini:gemini-3.8-flash',
        'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        'mistral:mistral-small-latest',
        'groq:openai/gpt-oss-120b',
        'nvidia:nvidia/nemotron-3.5-lightning-30b-a3b',
      ]);

      // Simulate 503 on gemini-3.5-flash-lite (fails twice) AND 503 on gemini-3.1-flash-lite (fails twice) -> succeeds on gemini-3.8-flash BEFORE touching Groq!
      const calledModels: string[] = [];
      const groqSpy = vi.fn(async () => '{"summary":"should-not-be-called"}');
      ProviderRegistry.register({
        providerName: 'gemini',
        async call(opts: any) {
          calledModels.push(opts.modelName);
          if (opts.modelName === 'gemini-3.5-flash-lite' || opts.modelName === 'gemini-3.1-flash-lite') {
            throw new Error('[SERVER_ERROR_503] 503 high demand');
          }
          return JSON.stringify({ ui_title: 'OK', summary: 'Compiled on 3.8-flash', components: [] });
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'groq',
        call: groqSpy,
      } as any);

      // Speed up sleep for this test via spy on globalProviderLimiter
      const origSleep = (globalProviderLimiter as any).sleep;
      (globalProviderLimiter as any).sleep = async () => {};
      try {
        const ctx = new SwarmContext();
        const out = await managerAgent.run('Compile JSON', ctx, { responseMimeType: 'application/json' });
        expect(out.summary).toBe('Compiled on 3.8-flash');
        expect(calledModels).toEqual([
          'gemini-3.5-flash-lite',
          'gemini-3.5-flash-lite', // 1x retry
          'gemini-3.1-flash-lite',
          'gemini-3.1-flash-lite', // 1x retry
          'gemini-3.8-flash',
        ]);
        expect(groqSpy).not.toHaveBeenCalled();
      } finally {
        (globalProviderLimiter as any).sleep = origSleep;
      }
    });
  });

  describe('S3: Zero-Quota Gemini Health Check (GET /v1beta/models) & Per-Model Runtime Cooldowns', () => {
    it('checking 5 Gemini free-tier models issues 1 GET /v1beta/models call and 0 generateContent calls', async () => {
      let metadataCalls = 0;
      let generateContentCalls = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: any) => {
          const u = String(url);
          if (u.includes('generateContent')) {
            generateContentCalls++;
          }
          if (u.includes('generativelanguage.googleapis.com/v1beta/models')) {
            metadataCalls++;
            return new Response(
              JSON.stringify({
                models: [
                  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemma-4-31b-it', displayName: 'Gemma 4 31B IT', supportedGenerationMethods: ['generateContent'] },
                  // Paid / retired / non-text entries must be filtered out
                  { name: 'models/gemini-2.5-flash', displayName: 'Retired 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemini-4-argon', displayName: 'Paid Argon', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemini-3.5-flash-image', displayName: 'Image Gen', supportedGenerationMethods: ['generateContent'] },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('{}', { status: 200 });
        }),
      );

      const adapterSpy = vi.fn(async () => {
        generateContentCalls++;
        return 'ok';
      });
      vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
        providerName: 'gemini',
        call: adapterSpy,
      } as any);

      const fiveModels = [
        { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite' },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
        { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT' },
      ];

      const ranked = await rankModelsForAccount('gemini', fiveModels, 'gem-live-key');
      expect(ranked).toHaveLength(5);
      expect(ranked.every((m) => m.available === true)).toBe(true);
      expect(metadataCalls).toBe(1);
      expect(generateContentCalls).toBe(0);
      expect(adapterSpy).not.toHaveBeenCalled();

      // Second call within 20-minute cache window reuses cache (still 1 GET call, 0 generateContent calls)
      const fetched = await fetchProviderModels('gemini', 'gem-live-key', {}, {
        forceRefresh: true,
        deferCatalogPersist: true,
        learningStore: { loadCatalogState: vi.fn(async () => null), saveCatalogState: vi.fn(async () => {}) } as any,
      });
      expect(fetched.map((m) => m.id)).toEqual([
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemma-4-31b-it',
      ]);
      expect(metadataCalls).toBe(1);
      expect(generateContentCalls).toBe(0);
    });

    it('runtime 503 on gemini-3.5-flash-lite cools down ONLY that model (60s), leaving gemini-3.1-flash-lite healthy', () => {
      const clock = makeClock(Date.UTC(2026, 10, 23, 12, 0, 0));
      const limiter = new ProviderLimiter(
        { gemini: { concurrency: 2, minSpacingMs: 0, maxInputTokens: 8000 } },
        clock.now,
        clock.sleep,
      );

      // Simulate multiple 503 failures on gemini-3.5-flash-lite
      for (let i = 0; i < 4; i++) {
        limiter.recordFailure('gemini', 'gemini-3.5-flash-lite', '[SERVER_ERROR_503] 503 high demand');
      }

      // Only gemini-3.5-flash-lite is on cooldown
      expect(limiter.isAvailable('gemini', 'gemini-3.5-flash-lite')).toBe(false);
      // Siblings remain completely healthy!
      expect(limiter.isAvailable('gemini', 'gemini-3.1-flash-lite')).toBe(true);
      expect(limiter.isAvailable('gemini', 'gemini-3.8-flash')).toBe(true);

      // After 60s cooldown expires, gemini-3.5-flash-lite becomes healthy again
      clock.advance(MODEL_COOLDOWN_MS + 1);
      expect(limiter.isAvailable('gemini', 'gemini-3.5-flash-lite')).toBe(true);

      // Explicit daily RPD exhaustion cools down longer (> 60s, until UTC midnight) without hurting siblings
      limiter.recordFailure('gemini', 'gemini-3.5-flash-lite', '[RATE_LIMIT_429] Daily limit exceeded (RPD quota)');
      clock.advance(MODEL_COOLDOWN_MS + 1);
      expect(limiter.isAvailable('gemini', 'gemini-3.5-flash-lite')).toBe(false);
      expect(limiter.isAvailable('gemini', 'gemini-3.1-flash-lite')).toBe(true);
    });
  });

  describe('S4: Fix partial: true (manager degraded) fallback payload', () => {
    const a1Scratchpad =
      'Evaluated R43 Thunder -10.5 but self-vetoed R43 due to uncertain Holmgren tag. Recommending R62 Knicks -4.5 and R12 Pacers +3.5.';
    const bestAnalyst = {
      seatId: 'a1',
      role: 'Quant Proposer',
      provider: 'gemini',
      report: {
        summary: a1Scratchpad,
        insights: [a1Scratchpad, 'R43 Thunder was considered and rejected.'],
        picks: [
          { row: 'R62', eventId: 'nba-401910062', pick: 'Knicks -4.5', market: 'spread' },
          { row: 'R12', eventId: 'nba-401910012', pick: 'Pacers +3.5', market: 'spread' },
        ],
      },
    };
    const scorecards = [
      { seat: 'Quant Proposer', verdict: 'propose', picksCount: 2 },
      { seat: 'Risk Critic', verdict: 'approve', criticApproved: true, wageringPass: false },
    ];

    it('when manager fails after Critic pass: true on [R62, R12], hoists picks, sets flags, preserves scorecards, and omits R43/Key points dump', () => {
      const result = buildPartialFinalAnalysis(bestAnalyst, ['manager'], {
        isBettingRun: true,
        criticRan: true,
        criticPassed: true,
        criticApproved: true,
        vetoedLegs: [],
        seatScorecards: scorecards,
      });

      expect(result.partial).toBe(true);
      expect(result.degraded).toContain('manager');
      expect(result.criticApproved).toBe(true);
      expect(result.wageringPass).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.picks).toHaveLength(2);
      expect(result.picks.map((p: any) => p.row)).toEqual(['R62', 'R12']);
      expect(result.scorecards).toEqual(scorecards);

      // Non-duplicated concise summary covering ONLY top-level picks; ZERO Key points dump & ZERO mention of R43
      expect(result.summary).toContain('R62');
      expect(result.summary).toContain('R12');
      expect(result.summary).not.toContain('Key points:');
      expect(result.summary).not.toContain('R43');
      expect(result.analysis).not.toContain('R43');
      expect(result.analysis).not.toContain('Key points:');
    });

    it('when manager fails with NO Critic approval (did not run or returned pass: false), fails closed', () => {
      const noCriticRes = buildPartialFinalAnalysis(bestAnalyst, ['manager'], {
        isBettingRun: true,
        criticRan: false,
        criticPassed: false,
        criticApproved: false,
        seatScorecards: [{ seat: 'Quant Proposer', verdict: 'propose', picksCount: 2 }],
      });
      expect(noCriticRes.picks).toEqual([]);
      expect(noCriticRes.criticApproved).toBe(false);
      expect(noCriticRes.wageringPass).toBe(true);
      expect(noCriticRes.verified).toBe(false);
      expect(noCriticRes.partial).toBe(true);

      const criticVetoRes = buildPartialFinalAnalysis(bestAnalyst, ['manager'], {
        isBettingRun: true,
        criticRan: true,
        criticPassed: false,
        criticApproved: false,
        vetoTexts: ['Unverified spread line'],
        seatScorecards: [{ seat: 'Risk Critic', verdict: 'veto', criticApproved: false, wageringPass: true }],
      });
      expect(criticVetoRes.picks).toEqual([]);
      expect(criticVetoRes.criticApproved).toBe(false);
      expect(criticVetoRes.wageringPass).toBe(true);
      expect(criticVetoRes.verified).toBe(false);
      expect(criticVetoRes.partial).toBe(true);
    });
  });

  describe('S5: Score === TOP PILLAR CANDIDATES === per side (fix split-direction "3 pillars" bug)', () => {
    it('nba-401910038 (form=OKC away, steam=TOWARD home IND, health=home_advantage IND) scores 2 pillars for home IND, NOT 3', () => {
      const entry: UnifiedGameDossierEntry = {
        eventId: 'nba-401910038',
        matchup: 'Oklahoma City Thunder @ Indiana Pacers',
        sport: 'nba',
        fundamentals:
          'Home (IND): W-L 34-30 | PF/PA 115.0/114.2 | Net Margin +0.8 | L5: 3-2 | Away (OKC): W-L 50-14 | PF/PA 121.4/108.6 | Net Margin +12.8 | L5: 4-1',
        injuries: 'Health Balance: home_advantage | Summary: OKC (4 OUT, 0 Q) vs IND (1 OUT, 0 Q)',
        market: 'Side Steam: TOWARD home Indiana Pacers | Spread moved from +10.5 to +8.5',
        hasDirectionalSteam: true,
        outCountDiff: 3,
        netMarginGap: 12.0,
      };

      const evalRes = evaluateQualitativePillars(entry);
      expect(evalRes.pillarCount).toBe(2);
      expect(evalRes.alignedPillarCount).toBe(2);
      expect(evalRes.winningSide).toBe('home');
      expect(evalRes.winningTeam).toBe('IND');
      expect(evalRes.homePillarCount).toBe(2);
      expect(evalRes.awayPillarCount).toBe(1);
      expect(evalRes.tags).toEqual(['steam=TOWARD home Indiana Pacers', 'health=home_advantage']);
      expect(evalRes.tags.some((t) => t.includes('form=OKC'))).toBe(false);

      const formatted = formatUnifiedPerGameDossier([entry]);
      expect(formatted.text).toContain(
        '- nba-401910038 [2 pillars (home IND): steam=TOWARD home Indiana Pacers, health=home_advantage]',
      );
      expect(formatted.text).not.toContain('3 pillars');
    });

    it('nba-401910044 (form=LAL home, health=home_advantage LAL, steam=TOWARD Under) scores 2 side pillars for LAL and notes total_steam separately', () => {
      const entry: UnifiedGameDossierEntry = {
        eventId: 'nba-401910044',
        matchup: 'Sacramento Kings @ Los Angeles Lakers',
        sport: 'nba',
        fundamentals:
          'Home (LAL): W-L 42-22 | PF/PA 117.1/111.3 | Net Margin +5.8 | L5: 4-1 | Away (SAC): W-L 30-34 | PF/PA 112.0/115.2 | Net Margin -3.2 | L5: 2-3',
        injuries: 'Health Balance: home_advantage | Summary: SAC (3 OUT, 0 Q) vs LAL (0 OUT, 0 Q)',
        market: 'Steam: TOWARD Under | Total moved from 231.5 to 227.5',
        hasDirectionalSteam: false,
        outCountDiff: 3,
        netMarginGap: 9.0,
      };

      const evalRes = evaluateQualitativePillars(entry);
      expect(evalRes.pillarCount).toBe(2);
      expect(evalRes.alignedPillarCount).toBe(2);
      expect(evalRes.winningSide).toBe('home');
      expect(evalRes.winningTeam).toBe('LAL');
      expect(evalRes.tags).toEqual(['form=LAL', 'health=home_advantage']);
      expect(evalRes.totalSteamTag).toBe('TOWARD Under');

      const formatted = formatUnifiedPerGameDossier([entry]);
      expect(formatted.text).toContain(
        '- nba-401910044 [2 pillars (home LAL): form=LAL, health=home_advantage] | total_steam=TOWARD Under',
      );
      expect(formatted.text).not.toContain('3 pillars');
    });
  });
});
