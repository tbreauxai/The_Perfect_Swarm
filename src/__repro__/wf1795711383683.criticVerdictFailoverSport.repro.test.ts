import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { globalProviderLimiter } from '../swarm/providers/limiter.ts';
import { buildCompactRunDiagnostics } from '../swarm/engine/runDiagnostics.ts';
import { executeManagerSynthesis } from '../swarm/engine/synthesisPipeline.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { reconcileFinalVerdictAndPicks } from '../swarm/tools/criticAudit.ts';
import { matchTeamByLabel, resolveEspnTeam } from '../swarm/tools/injuryAttribution.ts';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';

describe('wf-1795711383683: Authoritative Critic Verdict Lock, Failover Diagnostics & Sport-Scoped Team Resolution', () => {
  const originalGeminiAdapter = ProviderRegistry.get('gemini');
  const originalGroqAdapter = ProviderRegistry.get('groq');

  beforeEach(() => {
    globalProviderLimiter.reset?.();
  });

  afterEach(() => {
    if (originalGeminiAdapter) ProviderRegistry.register(originalGeminiAdapter);
    if (originalGroqAdapter) ProviderRegistry.register(originalGroqAdapter);
    globalProviderLimiter.reset?.();
    vi.restoreAllMocks();
  });

  describe('S1: Authoritative Pass 1 Risk Critic Verdict Lock & Strict criticApproved / wageringPass / picks Invariants', () => {
    it('wf-1795711383683 fixture: reconciles contradictory Risk Critic { verdict: "veto" } and Market Proposer dissent when Pass 1 Critic approved R9', async () => {
      const managerPayload = {
        ui_title: 'Top Parlay Play',
        summary: 'Bottom-line call: Backing R9 Memphis Grizzlies +6.5 based on Pass 1 Risk Critic approval.',
        analysis: 'R9 Memphis Grizzlies +6.5 has clean injury parity and line support.',
        components: [],
        picks: [
          {
            row: 'R9',
            event_id: 'nba-401910099',
            side: 'Memphis Grizzlies +6.5',
            reason: 'Health parity and closing steam'
          }
        ],
        scorecards: [
          { seat: 'Quant Proposer', verdict: 'propose', picksCount: 1 },
          { seat: 'Market Proposer', verdict: 'veto', notes: 'Line moved 0.5pt' },
          { seat: 'Risk Critic', criticApproved: true, wageringPass: false, verdict: 'veto' }
        ]
        // Intentionally omitting top-level wageringPass & criticApproved
      };

      // 1. Direct reconciler check
      const directReconciled = reconcileFinalVerdictAndPicks(JSON.parse(JSON.stringify(managerPayload)), {
        criticPass1Approved: true,
        deterministicVetoes: []
      });
      expect(directReconciled.criticApproved).toBe(true);
      expect(directReconciled.wageringPass).toBe(false);
      expect(directReconciled.picks).toHaveLength(1);
      expect(directReconciled.picks[0].row).toBe('R9');
      const directCriticCard = directReconciled.scorecards.find((s: any) => s.seat === 'Risk Critic');
      expect(directCriticCard.verdict).toBe('approve');
      expect(directCriticCard.criticApproved).toBe(true);
      expect(directCriticCard.wageringPass).toBe(false);

      // 2. Full executeManagerSynthesis pipeline check
      const managerAgent = {
        id: 'manager',
        role: 'GodView Compiler',
        provider: 'nvidia',
        modelName: 'nemotron-3.5-lightning-30b-a3b',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () => JSON.stringify(managerPayload))
      } as unknown as Agent;

      const synthResult = await executeManagerSynthesis(
        managerAgent,
        'Game Slate:\nevent_id=nba-401910099 | sport=basketball_nba | San Antonio Spurs @ Memphis Grizzlies | options: R9 SPR Memphis Grizzlies +6.5(-110), R10 SPR San Antonio Spurs -6.5(-110)',
        new SwarmContext(),
        undefined,
        true,
        undefined,
        ['nba-401910099'],
        {
          toolResults: '[MARKET MOVEMENT: nba-401910099] spread_home=+6.5 | Health Balance: symmetric',
          criticVerdictApproved: true
        }
      );

      expect(synthResult.criticApproved).toBe(true);
      expect(synthResult.wageringPass).toBe(false);
      expect(synthResult.picks).toHaveLength(1);
      expect(synthResult.picks[0].row).toBe('R9');
      const synthCriticCard = (synthResult.scorecards || []).find((s: any) =>
        String(s?.seat || '').toLowerCase().includes('critic')
      );
      expect(synthCriticCard).toBeDefined();
      expect(synthCriticCard.verdict).toBe('approve');
    });

    it('genuine veto fixture: Pass 1 Critic vetoed R9 -> post-processor enforces criticApproved: false, wageringPass: true, picks: []', async () => {
      const staleManagerDraft = {
        ui_title: 'Top Parlay Play',
        summary: 'Recommend R9 Memphis Grizzlies +6.5.',
        components: [],
        picks: [{ row: 'R9', event_id: 'nba-401910099', side: 'Memphis Grizzlies +6.5', reason: 'Steam' }],
        scorecards: [{ seat: 'Risk Critic', verdict: 'approve', criticApproved: true, wageringPass: false }]
      };

      const reconciledVeto = reconcileFinalVerdictAndPicks(JSON.parse(JSON.stringify(staleManagerDraft)), {
        criticPass1Approved: false,
        deterministicVetoes: ['Risk Critic vetoed R9 due to starter late scratch'],
        vetoTexts: ['Risk Critic vetoed R9 due to starter late scratch']
      });

      expect(reconciledVeto.criticApproved).toBe(false);
      expect(reconciledVeto.wageringPass).toBe(true);
      expect(reconciledVeto.picks).toEqual([]);

      // Also verify verificationPipeline when Pass 1 Critic vetoed R9
      const managerAgent = {
        id: 'manager',
        role: 'GodView Compiler',
        provider: 'nvidia',
        modelName: 'nemotron-3.5-lightning-30b-a3b',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () => JSON.stringify(staleManagerDraft))
      } as unknown as Agent;

      const criticVetoAgent = {
        id: 'critic',
        role: 'Risk Critic',
        provider: 'cloudflare',
        modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () =>
          JSON.stringify({
            pass: false,
            criticApproved: false,
            vetoedLegs: ['R9'],
            feedback: 'Vetoed R9: starter Ja Morant downgraded to OUT.'
          })
        )
      } as unknown as Agent;

      const verifiedVeto = await runDeepAnalysisVerification({
        task: 'Compile best play',
        rawInput:
          'event_id=nba-401910099 | sport=basketball_nba | San Antonio Spurs @ Memphis Grizzlies | options: R9 SPR Memphis Grizzlies +6.5(-110)',
        effectiveDynamicPrompt: 'Compile best play',
        effectiveCompiledReports: '[Quant Proposer]: R9 Memphis Grizzlies +6.5',
        effectiveHistoricalContext: '',
        managerAgent,
        analysts: [],
        dedicatedCriticAgent: criticVetoAgent,
        context: new SwarmContext(),
        settings: { maxRepairRetries: 0 } as any,
        criticVetoes: ['Vetoed R9: starter Ja Morant downgraded to OUT.'],
        vetoedLegs: [{ rowId: 'R9', teamAliases: ['memphis', 'grizzlies'], reason: 'Starter downgraded to OUT' }],
        criticVerdictApproved: false,
        hadProposedPicks: true
      });

      expect(verifiedVeto.finalAnalysis.criticApproved).toBe(false);
      expect(verifiedVeto.finalAnalysis.wageringPass).toBe(true);
      expect(verifiedVeto.finalAnalysis.picks).toEqual([]);
    });
  });

  describe('S2: Complete Failover Diagnostics (diagnostics.failovers[] never silent when seat fails over)', () => {
    const runFailoverScenario = async (mode: 'http400' | 'http429' | 'cooldown') => {
      let skipSpy: any;
      ProviderRegistry.register({
        providerName: 'gemini',
        async call() {
          if (mode === 'http400') {
            throw Object.assign(new Error('Invalid argument: model unavailable (400)'), { status: 400 });
          }
          if (mode === 'http429') {
            throw Object.assign(new Error('Quota rate limit exceeded (429)'), { status: 429 });
          }
          throw new Error('Should not have called gemini when [COOLDOWN_SKIP] is active');
        }
      } as any);

      ProviderRegistry.register({
        providerName: 'groq',
        async call() {
          return JSON.stringify({
            summary: 'Groq backup completed a1 cleanly.',
            insights: ['Recovered on groq'],
            picks: []
          });
        }
      } as any);

      if (mode === 'cooldown') {
        skipSpy = vi
          .spyOn(globalProviderLimiter, 'getSkipReason')
          .mockImplementation((provider: string) =>
            provider === 'gemini' ? '[COOLDOWN_SKIP] gemini circuit open' : null
          );
      }

      const ctx = new SwarmContext();
      const a1 = new Agent('Quant Proposer', 'gemini-4-hydrogen', 'gemini', 'fake-gemini-key', undefined, [
        { provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'fake-groq-key' }
      ]);
      a1.id = 'a1';
      a1.preserveFallbackOrder = true;

      await a1.run('Analyze slate', ctx, { responseMimeType: 'application/json', bypassCache: true });
      if (skipSpy) skipSpy.mockRestore();

      return buildCompactRunDiagnostics({ events: ctx.events, totalMs: 2660, hop1ToolsMs: 120 });
    };

    it('records HTTP 400 failover on a1 (gemini-4-hydrogen -> groq/openai/gpt-oss-120b) in both seatTimings and diagnostics.failovers', async () => {
      const diag = await runFailoverScenario('http400');
      const a1Timing = diag.seatTimings.find(s => s.seat === 'a1');
      expect(a1Timing?.status).toBe('failover');
      expect(diag.failovers.length).toBeGreaterThanOrEqual(1);
      expect(diag.failovers[0]).toMatchObject({
        seat: 'a1',
        from: 'gemini/gemini-4-hydrogen',
        to: 'groq/openai/gpt-oss-120b',
        status: 400
      });
      expect(diag.failovers[0].error.length).toBeGreaterThan(0);
    });

    it('records HTTP 429 failover on a1 (gemini-4-hydrogen -> groq/openai/gpt-oss-120b) in both seatTimings and diagnostics.failovers', async () => {
      const diag = await runFailoverScenario('http429');
      const a1Timing = diag.seatTimings.find(s => s.seat === 'a1');
      expect(a1Timing?.status).toBe('failover');
      expect(diag.failovers.length).toBeGreaterThanOrEqual(1);
      expect(diag.failovers[0]).toMatchObject({
        seat: 'a1',
        from: 'gemini/gemini-4-hydrogen',
        to: 'groq/openai/gpt-oss-120b',
        status: 429
      });
    });

    it('records [COOLDOWN_SKIP] failover on a1 (gemini-4-hydrogen -> groq/openai/gpt-oss-120b) in both seatTimings and diagnostics.failovers', async () => {
      const diag = await runFailoverScenario('cooldown');
      const a1Timing = diag.seatTimings.find(s => s.seat === 'a1');
      expect(a1Timing?.status).toBe('failover');
      expect(diag.failovers.length).toBeGreaterThanOrEqual(1);
      expect(diag.failovers[0]).toMatchObject({
        seat: 'a1',
        from: 'gemini/gemini-4-hydrogen',
        to: 'groq/openai/gpt-oss-120b',
        reason: '[COOLDOWN_SKIP]'
      });
    });

    it('final safeguard synthesizes diagnostics.failovers entries when a1 & critic execute via limiter-skip / failover without [COOLDOWN_SKIP]', () => {
      const diag = buildCompactRunDiagnostics({
        totalMs: 31200,
        hop1ToolsMs: 1400,
        events: [
          {
            id: 's1',
            timestamp: new Date().toISOString(),
            agentRole: 'Quant Proposer',
            action: 'Started execution',
            modelName: 'gemini / gemini-4-hydrogen',
            prompt: 'Analyze compact slate'
          },
          {
            id: 's2',
            timestamp: new Date().toISOString(),
            agentRole: 'Quant Proposer',
            action: 'Provider Skipped',
            modelName: 'gemini/gemini-4-hydrogen',
            prompt: 'Skipped provider target: skipped_tpm_wait: 12000ms',
            output: {
              provider: 'gemini',
              model: 'gemini-4-hydrogen',
              fromProvider: 'gemini',
              fromModel: 'gemini-4-hydrogen',
              reason: 'skipped_tpm_wait: 12000ms'
            }
          },
          {
            id: 's3',
            timestamp: new Date().toISOString(),
            agentRole: 'Quant Proposer',
            action: 'Completed execution via failover (groq)',
            modelName: 'groq / openai/gpt-oss-120b',
            prompt: 'Analyze compact slate',
            durationMs: 2660
          },
          {
            id: 's4',
            timestamp: new Date().toISOString(),
            agentRole: 'Risk Critic',
            action: 'Started execution',
            modelName: 'groq / openai/gpt-oss-120b',
            prompt: 'Audit picks'
          },
          {
            id: 's5',
            timestamp: new Date().toISOString(),
            agentRole: 'Risk Critic',
            action: 'Provider Skipped',
            modelName: 'groq/openai/gpt-oss-120b',
            prompt: 'Skipped provider target: token budget remaining 100 < 2000; shifting seat',
            output: {
              provider: 'groq',
              model: 'openai/gpt-oss-120b',
              fromProvider: 'groq',
              fromModel: 'openai/gpt-oss-120b',
              reason: 'token budget remaining 100 < 2000; shifting seat'
            }
          },
          {
            id: 's6',
            timestamp: new Date().toISOString(),
            agentRole: 'Risk Critic',
            action: 'Completed execution via failover (cloudflare)',
            modelName: 'cloudflare / @cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Audit picks',
            durationMs: 2480
          }
        ]
      });

      expect(diag.seatTimings.find(s => s.seat === 'a1')?.status).toBe('failover');
      expect(diag.seatTimings.find(s => s.seat === 'critic')?.status).toBe('failover');
      expect(diag.failovers).toHaveLength(2);
      expect(diag.failovers.find(f => f.seat === 'a1')).toMatchObject({
        seat: 'a1',
        from: 'gemini/gemini-4-hydrogen',
        to: 'groq/openai/gpt-oss-120b'
      });
      expect(diag.failovers.find(f => f.seat === 'critic')).toMatchObject({
        seat: 'critic',
        from: 'groq/openai/gpt-oss-120b',
        to: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      });
    });
  });

  describe('S3: Sport-Scoped Team Resolution in get_injury_and_roster_delta', () => {
    it('college-football-401856879 (TCU Horned Frogs @ Texas Tech Red Raiders): header renders exact names and NEVER Las Vegas Raiders', async () => {
      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'college-football-401856879' },
        {
          fetchFn: async () =>
            new Response(
              JSON.stringify({
                event_id: 'college-football-401856879',
                sport: 'americanfootball_ncaaf',
                home_team: 'Texas Tech Red Raiders',
                away_team: 'TCU Horned Frogs',
                home_team_id: '2641',
                away_team_id: '2628',
                injuries: [],
                total_injuries: 0
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            ),
          env: {
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_PUBLISHABLE_KEY: 'pub-test-key'
          }
        }
      );

      expect(res.summary).toContain('Texas Tech Red Raiders (0 OUT, 0 Q) vs TCU Horned Frogs (0 OUT, 0 Q)');
      expect(res.summary).not.toContain('Las Vegas Raiders');
    });

    it('college-football-401856879 with generic sport="football" and injuries preserves exact CFB team names without NFL crossover', async () => {
      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'college-football-401856879' },
        {
          fetchFn: async () =>
            new Response(
              JSON.stringify({
                event_id: 'college-football-401856879',
                sport: 'football',
                home_team: 'Texas Tech Red Raiders',
                away_team: 'TCU Horned Frogs',
                home_team_id: '2641',
                away_team_id: '2628',
                injuries: [
                  {
                    player_name: 'Sample Tech WR',
                    team_id: '2641',
                    team_name: 'Texas Tech Red Raiders',
                    position: 'WR',
                    status: 'Out'
                  },
                  {
                    player_name: 'Sample TCU LB',
                    team_id: '2628',
                    team_name: 'TCU Horned Frogs',
                    position: 'LB',
                    status: 'Questionable'
                  }
                ],
                total_injuries: 2
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            ),
          env: {
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_PUBLISHABLE_KEY: 'pub-test-key'
          }
        }
      );

      expect(res.summary).toContain('Texas Tech Red Raiders (1 OUT, 0 Q) vs TCU Horned Frogs (0 OUT, 1 Q)');
      expect(res.summary).toContain('- Texas Tech Red Raiders: Sample Tech WR');
      expect(res.summary).toContain('- TCU Horned Frogs: Sample TCU LB');
      expect(res.summary).not.toContain('Las Vegas Raiders');
      expect(res.summary).not.toMatch(/(?<!Red )Raiders/);
    });

    it('does not cross sports for shared mascots (Panthers NFL/NHL, Kings NHL/NBA, Red Raiders CFB/NFL)', () => {
      // Carolina Panthers is strictly NFL, never NHL Florida Panthers
      expect(matchTeamByLabel('Carolina Panthers', 'nhl')).toBeUndefined();
      expect(matchTeamByLabel('Carolina Panthers', 'icehockey_nhl')).toBeUndefined();
      expect(matchTeamByLabel('Carolina Panthers', 'nfl')?.name).toBe('Carolina Panthers');
      expect(matchTeamByLabel('Carolina Panthers', 'americanfootball_nfl')?.sport).toBe('nfl');

      expect(matchTeamByLabel('Florida Panthers', 'nfl')).toBeUndefined();
      expect(matchTeamByLabel('Florida Panthers', 'nhl')?.name).toBe('Florida Panthers');

      // Los Angeles Kings is strictly NHL, never NBA Sacramento Kings or LA Clippers
      expect(matchTeamByLabel('Los Angeles Kings', 'nba')).toBeUndefined();
      expect(matchTeamByLabel('Los Angeles Kings', 'basketball_nba')).toBeUndefined();
      expect(matchTeamByLabel('Los Angeles Kings', 'nhl')?.name).toBe('Los Angeles Kings');
      expect(matchTeamByLabel('Los Angeles Kings', 'icehockey_nhl')?.sport).toBe('nhl');

      expect(matchTeamByLabel('Sacramento Kings', 'nhl')).toBeUndefined();
      expect(matchTeamByLabel('Sacramento Kings', 'nba')?.name).toBe('Sacramento Kings');

      // College Football teams must NEVER match NFL teams
      expect(matchTeamByLabel('Texas Tech Red Raiders', 'americanfootball_ncaaf')).toBeUndefined();
      expect(matchTeamByLabel('Texas Tech Red Raiders', 'college-football-401856879')).toBeUndefined();
      expect(matchTeamByLabel('Texas Tech Red Raiders')).toBeUndefined();
      expect(resolveEspnTeam('2641', 'college-football-401856879', ['TCU Horned Frogs', 'Texas Tech Red Raiders'])).toBeUndefined();
    });
  });
});
