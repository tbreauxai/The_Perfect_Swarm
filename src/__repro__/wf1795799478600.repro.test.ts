import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { resolveSwarmAgents } from '../swarm/engine/agentResolution.ts';
import { executeManagerSynthesis, compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { MANAGER_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { GroqAdapter } from '../swarm/providers/groq.ts';
import { CloudflareAdapter } from '../swarm/providers/cloudflare.ts';
import { GeminiAdapter } from '../swarm/providers/gemini.ts';
import { MistralAdapter } from '../swarm/providers/mistral.ts';
import { globalProviderLimiter, estimateTokens } from '../swarm/providers/limiter.ts';
import { globalTokenBudgetManager } from '../swarm/loadBalancer/tokenBudgetManager.ts';
import {
  auditMarketCoverageAndRowBinding,
  auditProposerRowLock,
  validatePickReasonSource,
  extractUnvetoedProposerRowSet,
} from '../swarm/tools/marketRowBinding.ts';

const TEST_SLATE = [
  'event_id=nba-4019901 | sport=nba | Miami Heat @ Boston Celtics | options: R88 Boston Celtics -5.5 (-110) | R89 Miami Heat +5.5 (-110)',
  'event_id=nba-4019902 | sport=nba | Phoenix Suns @ Denver Nuggets | options: R110 Denver Nuggets ML (-140) | R111 Phoenix Suns ML (+120)',
  'event_id=nhl-4018999 | sport=nhl | Seattle Kraken @ Dallas Stars | options: R97 Dallas Stars ML (-135) | R98 Seattle Kraken ML (+115)',
  'event_id=nba-4019903 | sport=nba | Detroit Pistons @ Chicago Bulls | options: R30 Chicago Bulls -2.5 (-110) | R31 Detroit Pistons +2.5 (-110)',
  'event_id=ncaaf-4018505 | sport=ncaaf | Baylor Bears @ TCU Horned Frogs | options: R5 TCU Horned Frogs -7.5 (-110)',
].join('\n');

const TEST_EVIDENCE = [
  'EVENT nba-4019901 (Miami Heat @ Boston Celtics)',
  'Boston Celtics (nba-4019901) spread -5.5 | ml_home: -220, ml_away: 185 | L5 4-1, avgPts: 118.4, avgPtsAgainst: 109.2',
  'Steam: TOWARD Boston Celtics -5.5',
  'Health Balance: home_advantage (Miami Heat 2 OUT vs Boston Celtics 0 OUT)',
  '',
  'EVENT nba-4019902 (Phoenix Suns @ Denver Nuggets)',
  'Denver Nuggets (nba-4019902) ml_home: -140, ml_away: 120 | L5 4-1, avgPts: 116.0, avgPtsAgainst: 110.5',
  'Steam: TOWARD Denver Nuggets ML',
  'Health Balance: clean (0 OUT vs 0 OUT)',
  '',
  'EVENT nhl-4018999 (Seattle Kraken @ Dallas Stars)',
  'Dallas Stars (nhl-4018999) ml_home: -135, ml_away: 115 | L5 4-1, goalsFor: 3.4, goalsAgainst: 2.3',
  'Steam: TOWARD Dallas Stars ML',
  'Health Balance: home_advantage (Seattle Kraken 2 OUT vs Dallas Stars 0 OUT)',
  '',
  'EVENT nba-4019903 (Detroit Pistons @ Chicago Bulls)',
  'Chicago Bulls (nba-4019903) spread -2.5 | ml_home: -135, ml_away: 115 | L5 2-3',
].join('\n');

const UNVETOED_SPECIALIST_PICKS = [
  {
    row: 'R88',
    event_id: 'nba-4019901',
    side: 'Boston Celtics -5.5',
    market: 'spread',
    line: -5.5,
    odds: -110,
    confidence: 0.78,
    reason: 'Boston Celtics L5 4-1 with home_advantage and favorable spread steam.',
    reasonSource: 'matchup_fundamentals',
  },
  {
    row: 'R110',
    event_id: 'nba-4019902',
    side: 'Denver Nuggets ML',
    market: 'moneyline',
    odds: -140,
    confidence: 0.74,
    reason: 'Denver Nuggets hold L5 4-1 and home steam.',
    reasonSource: 'market_movement',
  },
  {
    row: 'R97',
    event_id: 'nhl-4018999',
    side: 'Dallas Stars ML',
    market: 'moneyline',
    odds: -135,
    confidence: 0.72,
    reason: 'Dallas Stars have home_advantage and 3.4 goalsFor.',
    reasonSource: 'R97',
  },
];

describe('wf-1795799478600: Manager Groq primary routing + Proposer Row Lock + Real reasonSource', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    globalProviderLimiter.reset();
    globalTokenBudgetManager.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    globalProviderLimiter.reset();
    globalTokenBudgetManager.reset();
    ProviderRegistry.register(new GroqAdapter());
    ProviderRegistry.register(new CloudflareAdapter());
    ProviderRegistry.register(new GeminiAdapter());
    ProviderRegistry.register(new MistralAdapter());
  });

  describe('Bug 1: Manager configured as groq / openai/gpt-oss-120b routes to Groq first, not Cloudflare', () => {
    it('routes primary manager directly to groq / openai/gpt-oss-120b even when Cloudflare keys are configured and groq has a >5s TPM wait', async () => {
      vi.stubEnv('GROQ_API_KEY', 'gsk_test_key');
      vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf_test_token');
      vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf_test_account');
      vi.stubEnv('GEMINI_API_KEY', 'gem_test_key');

      const { managerAgent, analysts } = resolveSwarmAgents(
        {
          agents: [
            { id: 'a1', role: 'Quant Proposer', provider: 'simulated', model: 'sim-1' },
            { id: 'a2', role: 'Market Proposer', provider: 'simulated', model: 'sim-2' },
            { id: 'manager', role: 'GodView Compiler', provider: 'groq', model: 'openai/gpt-oss-120b' },
          ],
          groqApiKey: 'gsk_test_key',
          cloudflareApiToken: 'cf_test_token',
          cloudflareAccountId: 'cf_test_account',
          geminiApiKey: 'gem_test_key',
        } as any,
        undefined
      );

      expect(managerAgent.provider).toBe('groq');
      expect(managerAgent.modelName).toBe('openai/gpt-oss-120b');
      // Only a1 and a2 should be analysts (manager / GodView Compiler excluded even without id check)
      expect(analysts).toHaveLength(2);
      // Fallback chain still starts with Cloudflare as backup if Groq actually fails
      expect(managerAgent.getFallbacks()[0]?.provider).toBe('cloudflare');

      // Simulate prior window consumption in TokenBudgetManager causing ~25ms wait or Limiter >5s wait on primary groq target
      // Use fake timers so wait completes instantaneously in the unit test while preserving > 5,000ms wait check
      vi.useFakeTimers();
      vi.spyOn(globalProviderLimiter, 'budgetWaitMs').mockImplementation((provider: string) => {
        if (provider === 'groq') return 7_500;
        return 0;
      });
      // Make TokenBudgetManager wait <= 7500ms or 0ms, wait triggers on limiterWait = 7,500ms
      const callSequence: Array<{ provider: string; model: string }> = [];
      ProviderRegistry.register({
        providerName: 'groq',
        async call(opts: any) {
          callSequence.push({ provider: 'groq', model: opts.modelName });
          return JSON.stringify({
            ui_title: 'Swarm Card',
            summary: 'Backing Boston Celtics -5.5 (R88) based on L5 4-1 and steam.',
            picks: [{ ...UNVETOED_SPECIALIST_PICKS[0] }],
            scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Approved' }],
            components: [],
            wageringPass: false,
            criticApproved: true,
          });
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'cloudflare',
        async call(opts: any) {
          callSequence.push({ provider: 'cloudflare', model: opts.modelName });
          return JSON.stringify({ ui_title: 'CF', summary: 'CF fallback', picks: [], wageringPass: true });
        },
      } as any);

      const ctx = new SwarmContext();
      const synth = compileSynthesisPrompt({
        task: 'Construct optimal NBA/NHL picks from slate.',
        rawInput: TEST_SLATE,
        analysts,
        managerAgent,
        allAnalystReports: [
          [{ role: 'Quant Proposer', summary: 'R88 Boston Celtics -5.5', picks: [UNVETOED_SPECIALIST_PICKS[0]], coveredEventIds: ['nba-4019901'] }],
          [{ role: 'Market Proposer', summary: 'R110 Denver Nuggets ML', picks: [UNVETOED_SPECIALIST_PICKS[1]], coveredEventIds: ['nba-4019902'] }],
        ],
        clusterDigests: {},
        historicalContext: '',
        context: ctx,
        params: { task: 'Construct optimal picks', isBettingRun: true } as any,
        bypassCache: true,
        verifierEvidence: TEST_EVIDENCE,
      });

      const synthPromise = executeManagerSynthesis(
        managerAgent,
        synth.effectiveDynamicPrompt,
        ctx,
        undefined,
        true,
        undefined,
        ['nba-4019901', 'nba-4019902'],
        {
          toolResults: TEST_EVIDENCE,
          rawBoard: TEST_SLATE,
          specialistPicks: UNVETOED_SPECIALIST_PICKS.slice(0, 2),
          criticVerdictApproved: true,
        }
      );

      await vi.advanceTimersByTimeAsync(8_000);
      const result = await synthPromise;

      expect(callSequence.length).toBeGreaterThanOrEqual(1);
      expect(callSequence[0]).toEqual({ provider: 'groq', model: 'openai/gpt-oss-120b' });
      expect(callSequence.some(c => c.provider === 'cloudflare')).toBe(false);
      expect(result.picks.map((p: any) => p.row)).toEqual(['R88']);
    });

    it('keeps MANAGER_SYSTEM_INSTRUCTION + synthesis + retry prompt within Groq token ceiling so retry stays on groq/openai/gpt-oss-120b', async () => {
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain('PROPOSER ROW LOCK');
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain('REAL "reasonSource" REQUIRED');
      expect(MANAGER_SYSTEM_INSTRUCTION).toMatch(/a1\/a2/);
      expect(MANAGER_SYSTEM_INSTRUCTION).toMatch(/never.*invent|NEVER invent/i);
      expect(MANAGER_SYSTEM_INSTRUCTION).toMatch(/flip.*opposite side/i);

      vi.stubEnv('GROQ_API_KEY', 'gsk_test_key');
      vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf_test_token');
      vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf_test_account');

      const managerAgent = new Agent('Manager Node', 'openai/gpt-oss-120b', 'groq', 'gsk_test_key', undefined, [
        { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'cf_test_token' },
      ]);
      managerAgent.preserveFallbackOrder = true;
      managerAgent.setSystemInstruction(MANAGER_SYSTEM_INSTRUCTION);

      const criticAgent = new Agent('Verification Critic', 'sim-critic', 'simulated', 'sim-key');

      const seenTargets: Array<{ provider: string; model: string; promptTokens: number }> = [];
      ProviderRegistry.register({
        providerName: 'groq',
        async call(opts: any) {
          seenTargets.push({
            provider: 'groq',
            model: opts.modelName,
            promptTokens: estimateTokens(`${opts.systemInstruction || ''}\n${opts.prompt || ''}`),
          });
          // Attempt 1 emits invented row R30; Attempt 2 obeys proposer row lock R88
          if (seenTargets.length === 1) {
            return JSON.stringify({
              summary: 'Backing Chicago Bulls -2.5 (R30) based on market read.',
              picks: [
                {
                  row: 'R30',
                  event_id: 'nba-4019903',
                  side: 'Chicago Bulls -2.5',
                  market: 'spread',
                  line: -2.5,
                  odds: -110,
                  confidence: 0.7,
                  reason: 'Bulls L5 2-3',
                  reasonSource: 'matchup_fundamentals',
                },
              ],
              scorecards: [],
              components: [],
              wageringPass: false,
              criticApproved: true,
            });
          }
          return JSON.stringify({
            summary: 'Backing Boston Celtics -5.5 (R88) with home_advantage and favorable steam.',
            picks: [{ ...UNVETOED_SPECIALIST_PICKS[0] }],
            scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Approved' }],
            components: [],
            wageringPass: false,
            criticApproved: true,
          });
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'cloudflare',
        async call(opts: any) {
          seenTargets.push({ provider: 'cloudflare', model: opts.modelName, promptTokens: 0 });
          throw new Error('Cloudflare should not have been called when Groq primary is healthy and under token ceiling');
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'simulated',
        async call() {
          return JSON.stringify({ pass: true, feedback: 'Verified.' });
        },
      } as any);

      // Build an oversized initial prompt that without Groq ceiling trimming would trip PROMPT_EXCEEDS_LIMIT_REASON on Attempt 2
      vi.useFakeTimers();
      const hugeReports = JSON.stringify({ summary: 'a1 proposed R88, R110, R97.', padding: 'x '.repeat(6000) });
      const ctx = new SwarmContext();
      const lifecycle = new AnalysisLifecycle(managerAgent, criticAgent, 2);
      const resPromise = lifecycle.executeAndVerify(
        {
          task: 'Select bets from unvetoed a1/a2 picks.',
          fullBoard: TEST_SLATE,
          rawBoard: TEST_SLATE,
          toolResults: TEST_EVIDENCE,
          specialistPicks: UNVETOED_SPECIALIST_PICKS,
          analystReports: hugeReports,
        },
        ctx,
        `Task: Analyze slate.\n\nGame Slate:\n${TEST_SLATE}\n\nAnalyst Reports:\n${hugeReports}`,
        'Verify proposal.',
        ['nba-4019901', 'nba-4019902', 'nhl-4018999', 'nba-4019903']
      );

      let done = false;
      resPromise.finally(() => { done = true; });
      for (let i = 0; i < 20 && !done; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const res = await resPromise;

      expect(res.success).toBe(true);
      expect(res.attempts).toBe(2);
      expect(seenTargets).toHaveLength(2);
      expect(seenTargets[0].provider).toBe('groq');
      expect(seenTargets[0].model).toBe('openai/gpt-oss-120b');
      expect(seenTargets[0].promptTokens).toBeLessThanOrEqual(7000);
      expect(seenTargets[1].provider).toBe('groq');
      expect(seenTargets[1].model).toBe('openai/gpt-oss-120b');
      expect(seenTargets[1].promptTokens).toBeLessThanOrEqual(7000);
    });
  });

  describe('Bug 2: Deterministic Verifier locks Manager picks to unvetoed proposer legs + rejects placeholder reasonSource', () => {
    it('rejects invented Manager row R30 and opposite-side flip R89 when unvetoed proposer set is {R88, R110, R97}, while accepting {R88, R110, R97}', () => {
      const vetoedLegs = [{ rowId: 'R5', eventId: 'ncaaf-4018505', teamLabel: 'TCU Horned Frogs', teamAliases: ['tcu'], reason: 'Vetoed test leg' }];
      const unvetoedInfo = extractUnvetoedProposerRowSet({
        specialistPicks: [
          ...UNVETOED_SPECIALIST_PICKS,
          { row: 'R5', event_id: 'ncaaf-4018505', side: 'TCU Horned Frogs -7.5', reasonSource: 'R5' },
        ],
        vetoedLegs,
        boardSource: TEST_SLATE,
      });
      expect(unvetoedInfo.unvetoedRows).toEqual(['R88', 'R110', 'R97']);
      expect(unvetoedInfo.vetoedProposerRows).toEqual(['R5']);

      // Invented row R30 rejected
      const inventedCheck = auditProposerRowLock(
        {
          picks: [
            { row: 'R30', event_id: 'nba-4019903', side: 'Chicago Bulls -2.5', reasonSource: 'matchup_fundamentals' },
          ],
        },
        { specialistPicks: UNVETOED_SPECIALIST_PICKS, vetoedLegs, boardSource: TEST_SLATE }
      );
      expect(inventedCheck.pass).toBe(false);
      expect(inventedCheck.flags).toContain('proposer_row_lock');
      expect(inventedCheck.rejectedRows).toEqual(['R30']);
      expect(inventedCheck.rejectedTargets.map(t => t.rowId)).toEqual(['R30']);
      // Feedback must NOT list allowed rows (R88, R110, R97) so extractVetoedLegTargets never poisons them
      expect(inventedCheck.feedback).not.toMatch(/\bR88\b|\bR110\b|\bR97\b/);

      // Opposite-side flip R89 of Celtics/Heat game rejected when only R88 was proposed
      const oppositeSideCheck = auditProposerRowLock(
        {
          picks: [
            { row: 'R89', event_id: 'nba-4019901', side: 'Miami Heat +5.5', reasonSource: 'matchup_fundamentals' },
          ],
        },
        { specialistPicks: UNVETOED_SPECIALIST_PICKS, vetoedLegs, boardSource: TEST_SLATE }
      );
      expect(oppositeSideCheck.pass).toBe(false);
      expect(oppositeSideCheck.rejectedRows).toEqual(['R89']);

      // Unvetoed proposer set {R88, R110, R97} accepted
      const validCheck = auditProposerRowLock(
        { picks: UNVETOED_SPECIALIST_PICKS },
        { specialistPicks: UNVETOED_SPECIALIST_PICKS, vetoedLegs, boardSource: TEST_SLATE }
      );
      expect(validCheck.pass).toBe(true);
    });

    it('rejects placeholder reasonSource values ("n/a", "none", "") and accepts real tool fields or slate row IDs', () => {
      for (const bad of ['n/a', 'N/A', 'none', 'None', '', '   ', 'unknown', 'tbd', null]) {
        const res = validatePickReasonSource({ row: 'R88', side: 'Boston Celtics -5.5', reasonSource: bad });
        expect(res.valid, `Expected reasonSource=${JSON.stringify(bad)} to be invalid`).toBe(false);
      }

      for (const good of ['matchup_fundamentals', 'market_movement', 'injury_and_roster_delta', 'R88', 'nba-4019901']) {
        const res = validatePickReasonSource({ row: 'R88', side: 'Boston Celtics -5.5', reasonSource: good });
        expect(res.valid, `Expected reasonSource=${JSON.stringify(good)} to be valid`).toBe(true);
      }

      const marketAudit = auditMarketCoverageAndRowBinding(
        {
          summary: 'Backing Boston Celtics -5.5 (R88).',
          picks: [
            {
              row: 'R88',
              event_id: 'nba-4019901',
              side: 'Boston Celtics -5.5',
              market: 'spread',
              line: -5.5,
              reason: 'Boston Celtics L5 4-1 with home_advantage.',
              reasonSource: 'n/a',
            },
          ],
        },
        TEST_EVIDENCE,
        TEST_SLATE
      );
      expect(marketAudit.pass).toBe(false);
      expect(marketAudit.flags).toContain('invalid_reason_source');
    });

    it('full verifier loop rejects Attempt 1 with R30 or reasonSource: "n/a" and recovers when Attempt 2 emits unvetoed R88/R110/R97 with real reasonSource', async () => {
      const manager = new Agent('GodView Compiler', 'sim-mgr', 'simulated', 'mock-key');
      const critic = new Agent('Verification Critic', 'sim-critic', 'simulated', 'mock-key');
      const ctx = new SwarmContext();
      const recordedPrompts: string[] = [];

      vi.spyOn(critic, 'run').mockResolvedValue(JSON.stringify({ pass: true, feedback: 'Looks fine.' }));
      const managerSpy = vi.spyOn(manager, 'run')
        // Attempt 1: invented R30 + valid R88 with reasonSource: "n/a"
        .mockImplementationOnce(async (prompt: string) => {
          recordedPrompts.push(prompt);
          return JSON.stringify({
            summary: 'Backing Chicago Bulls -2.5 (R30) and Boston Celtics -5.5 (R88).',
            picks: [
              {
                row: 'R30',
                event_id: 'nba-4019903',
                side: 'Chicago Bulls -2.5',
                market: 'spread',
                line: -2.5,
                odds: -110,
                confidence: 0.7,
                reason: 'Chicago Bulls L5 2-3',
                reasonSource: 'matchup_fundamentals',
              },
              {
                row: 'R88',
                event_id: 'nba-4019901',
                side: 'Boston Celtics -5.5',
                market: 'spread',
                line: -5.5,
                odds: -110,
                confidence: 0.78,
                reason: 'Boston Celtics L5 4-1 with home_advantage.',
                reasonSource: 'n/a',
              },
            ],
            scorecards: [],
            components: [],
            wageringPass: false,
            criticApproved: true,
          });
        })
        // Attempt 2: valid unvetoed proposer rows R88, R110, R97 with real reasonSources
        .mockImplementationOnce(async (prompt: string) => {
          recordedPrompts.push(prompt);
          return JSON.stringify({
            summary: 'Parlay Boston Celtics -5.5 (R88), Denver Nuggets ML (R110), and Dallas Stars ML (R97).',
            picks: UNVETOED_SPECIALIST_PICKS,
            scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Approved' }],
            components: [],
            wageringPass: false,
            criticApproved: true,
          });
        });

      const res = await runDeepAnalysisVerification({
        task: 'Construct optimal picks from unvetoed specialist proposals.',
        rawInput: TEST_SLATE,
        effectiveDynamicPrompt: `Game Slate:\n${TEST_SLATE}`,
        effectiveCompiledReports: '[Quant Proposer] R88 | [Market Proposer] R110, R97',
        effectiveHistoricalContext: '',
        managerAgent: manager,
        analysts: [],
        dedicatedCriticAgent: critic,
        context: ctx,
        coveredEventIds: ['nba-4019901', 'nba-4019902', 'nhl-4018999'],
        toolResults: TEST_EVIDENCE,
        specialistPicks: UNVETOED_SPECIALIST_PICKS,
        hadProposedPicks: true,
        criticVerdictApproved: true,
      });

      expect(managerSpy).toHaveBeenCalledTimes(2);
      // Retry prompt lists allowed unvetoed proposer rows for Compiler
      expect(recordedPrompts[1]).toContain('[ALLOWED UNVETOED PROPOSER ROWS (a1/a2 ONLY)]: R88, R110, R97');
      expect(res.lifecycleResult.attempts).toBe(2);
      expect(res.lifecycleResult.success).toBe(true);
      expect(res.finalAnalysis.verified).toBe(true);
      expect(res.finalAnalysis.wageringPass).toBe(false);
      expect(res.finalAnalysis.criticApproved).toBe(true);
      expect(res.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R88', 'R110', 'R97']);
    });

    it('permanently fails verification if Manager exhausts retries still emitting invented row R30 or reasonSource: "n/a"', async () => {
      const managerA = new Agent('GodView Compiler', 'sim-mgr', 'simulated', 'mock-key');
      const criticA = new Agent('Verification Critic', 'sim-critic', 'simulated', 'mock-key');
      vi.spyOn(criticA, 'run').mockResolvedValue(JSON.stringify({ pass: true, feedback: 'Looks fine.' }));
      vi.spyOn(managerA, 'run').mockResolvedValue(
        JSON.stringify({
          summary: 'Backing Chicago Bulls -2.5 (R30).',
          picks: [
            {
              row: 'R30',
              event_id: 'nba-4019903',
              side: 'Chicago Bulls -2.5',
              market: 'spread',
              line: -2.5,
              confidence: 0.7,
              reason: 'Bulls L5 2-3',
              reasonSource: 'matchup_fundamentals',
            },
          ],
          scorecards: [],
          components: [],
          wageringPass: false,
          criticApproved: true,
        })
      );

      const failRowRes = await runDeepAnalysisVerification({
        task: 'Pick unvetoed proposer rows.',
        rawInput: TEST_SLATE,
        effectiveDynamicPrompt: `Game Slate:\n${TEST_SLATE}`,
        effectiveCompiledReports: '[Quant Proposer] R88',
        effectiveHistoricalContext: '',
        managerAgent: managerA,
        analysts: [],
        dedicatedCriticAgent: criticA,
        context: new SwarmContext(),
        coveredEventIds: ['nba-4019901', 'nba-4019903'],
        toolResults: TEST_EVIDENCE,
        specialistPicks: [UNVETOED_SPECIALIST_PICKS[0]],
        hadProposedPicks: true,
        criticVerdictApproved: true,
      });

      expect(failRowRes.lifecycleResult.success).toBe(false);
      expect(failRowRes.finalAnalysis.verified).toBe(false);
      expect(failRowRes.finalAnalysis.picks).toEqual([]);
      expect(failRowRes.finalAnalysis.wageringPass).toBe(true);

      const managerB = new Agent('GodView Compiler', 'sim-mgr', 'simulated', 'mock-key');
      const criticB = new Agent('Verification Critic', 'sim-critic', 'simulated', 'mock-key');
      vi.spyOn(criticB, 'run').mockResolvedValue(JSON.stringify({ pass: true, feedback: 'Looks fine.' }));
      vi.spyOn(managerB, 'run').mockResolvedValue(
        JSON.stringify({
          summary: 'Backing Boston Celtics -5.5 (R88).',
          picks: [
            {
              ...UNVETOED_SPECIALIST_PICKS[0],
              reasonSource: 'n/a',
            },
          ],
          scorecards: [],
          components: [],
          wageringPass: false,
          criticApproved: true,
        })
      );

      const failRsRes = await runDeepAnalysisVerification({
        task: 'Pick unvetoed proposer rows.',
        rawInput: TEST_SLATE,
        effectiveDynamicPrompt: `Game Slate:\n${TEST_SLATE}`,
        effectiveCompiledReports: '[Quant Proposer] R88',
        effectiveHistoricalContext: '',
        managerAgent: managerB,
        analysts: [],
        dedicatedCriticAgent: criticB,
        context: new SwarmContext(),
        coveredEventIds: ['nba-4019901'],
        toolResults: TEST_EVIDENCE,
        specialistPicks: [UNVETOED_SPECIALIST_PICKS[0]],
        hadProposedPicks: true,
        criticVerdictApproved: true,
      });

      expect(failRsRes.lifecycleResult.success).toBe(false);
      expect(failRsRes.finalAnalysis.verified).toBe(false);
      expect(failRsRes.finalAnalysis.picks).toEqual([]);
      expect(failRsRes.finalAnalysis.wageringPass).toBe(true);
    });
  });
});
