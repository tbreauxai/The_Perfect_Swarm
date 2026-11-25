import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { globalProviderLimiter } from '../swarm/providers/limiter.ts';
import { buildCompactRunDiagnostics } from '../swarm/engine/runDiagnostics.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { auditMarketCoverageAndRowBinding } from '../swarm/tools/marketRowBinding.ts';
import {
  getInjuryAndRosterDeltaTool,
  scoreInjuryStarterTier,
} from '../swarm/tools/dueloddsRpcTools.ts';

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role-key',
};

describe('wf-1795642034571 regressions (S1 venue/fail-closed, S2 Tier-1 Q/DNP, S3 cooldown)', () => {
  describe('S1: Venue mismatch scoping + clause-local direct modifiers', () => {
    const slate = [
      'event_id=nhl-401892784 | sport=icehockey_nhl | Philadelphia Flyers @ Washington Capitals | rows=R1:ML Philadelphia Flyers ML(-115),R2:ML Washington Capitals ML(-105),R11:SPR Philadelphia Flyers +1.5(-200),R12:SPR Washington Capitals -1.5(+170)',
      'event_id=nhl-401892790 | sport=icehockey_nhl | Anaheim Ducks @ Minnesota Wild | rows=R3:ML Minnesota Wild ML(-135),R4:ML Anaheim Ducks ML(+115),R13:SPR Minnesota Wild -1.5(+165),R14:SPR Anaheim Ducks +1.5(-195)',
      'event_id=nhl-401892799 | sport=icehockey_nhl | New Jersey Devils @ Tampa Bay Lightning | rows=R5:ML Tampa Bay Lightning ML(-140),R6:ML New Jersey Devils ML(+120),R15:SPR Tampa Bay Lightning -1.5(+160),R16:SPR New Jersey Devils +1.5(-190)',
    ].join('\n');
    const headers = parseGameHeaders(slate);
    const evidence = [
      'event_id=nhl-401892784 ml_away=-115 ml_home=-105',
      'event_id=nhl-401892790 ml_home=-135 ml_away=+115',
      'event_id=nhl-401892799 ml_home=-140 ml_away=+120',
    ].join('\n');

    it('does not false-positive on "away advantage over Capitals", "home record" with Wild, or unpicked game venue commentary', () => {
      // 1a. Flyers (away) with "away advantage over Capitals"
      const p1 = auditMarketCoverageAndRowBinding(
        {
          picks: [
            {
              row: 'R1',
              event_id: 'nhl-401892784',
              side: 'Philadelphia Flyers ML',
              reason: 'Flyers hold a strong away advantage over Capitals with Washington missing top defenders.',
            },
          ],
          summary: 'Back Philadelphia Flyers ML (R1).',
        },
        evidence,
        slate,
        headers,
      );
      expect(p1.pass).toBe(true);
      expect(p1.flags).not.toContain('spread_side_mismatch');

      // 1b. Wild (home) + "away_advantage" injury label in another clause
      const p2 = auditMarketCoverageAndRowBinding(
        {
          picks: [
            {
              row: 'R3',
              event_id: 'nhl-401892790',
              side: 'Minnesota Wild ML',
              reason: 'Minnesota Wild boast an elite home record while Ducks show an away_advantage label only on depth.',
            },
          ],
          summary: 'Back Minnesota Wild ML (R3).',
        },
        evidence,
        slate,
        headers,
      );
      expect(p2.pass).toBe(true);
      expect(p2.flags).not.toContain('spread_side_mismatch');

      // 1c. Unpicked Capitals mentioned with wrong venue in summary/scorecard while strictly picking R5 (Lightning)
      const p3 = auditMarketCoverageAndRowBinding(
        {
          picks: [
            {
              row: 'R5',
              event_id: 'nhl-401892799',
              side: 'Tampa Bay Lightning ML',
              reason: 'Tampa Bay Lightning hold clear 5v5 and goaltending edges at home.',
            },
          ],
          summary: 'Back Tampa Bay Lightning ML (R5). Passed on Philadelphia Flyers at home edge.',
        },
        evidence,
        slate,
        headers,
      );
      expect(p3.pass).toBe(true);
      expect(p3.flags).not.toContain('spread_side_mismatch');
    });

    it('still flags true venue contradiction on a picked team in the same clause', () => {
      const pTruePos = auditMarketCoverageAndRowBinding(
        {
          picks: [
            {
              row: 'R1',
              event_id: 'nhl-401892784',
              side: 'Philadelphia Flyers ML',
              reason: 'Philadelphia Flyers have a dominant home record tonight in this matchup.',
            },
          ],
          summary: 'Philadelphia Flyers win at home (R1).',
        },
        evidence,
        slate,
        headers,
      );
      expect(pTruePos.pass).toBe(false);
      expect(pTruePos.flags).toContain('spread_side_mismatch');
      expect(pTruePos.feedback).toMatch(/described as home.*away team/i);
    });
  });

  describe('S1: Fail-closed retry exhaustion payload reconciliation', () => {
    it('returns coherent 0-pick no_play state with vetoed Risk Critic scorecard and no stale picks/count in summary', async () => {
      const ctx = new SwarmContext();
      (ctx as any).id = 'wf-fail-closed-test';
      const slate = [
        'event_id=nba-401910101 | sport=basketball_nba | Boston Celtics @ Miami Heat | rows=R1:ML Boston Celtics ML(-150),R2:ML Miami Heat ML(+130)',
        'event_id=nba-401910102 | sport=basketball_nba | Phoenix Suns @ Denver Nuggets | rows=R3:ML Denver Nuggets ML(-180),R4:ML Phoenix Suns ML(+155)',
      ].join('\n');

      const managerAgent = {
        id: 'manager',
        role: 'GodView Compiler',
        provider: 'gemini',
        modelName: 'gemini-2.5-flash',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () =>
          JSON.stringify({
            ui_title: '2-Leg Parlay',
            summary: 'Bottom-line call: play 2-leg parlay R1 + R3 (picks=2).',
            analysis: 'Proposed 2-leg card with Celtics and Nuggets.',
            components: [],
            picks: [
              { row: 'R1', event_id: 'nba-401910101', side: 'Boston Celtics ML', reason: 'Strong road favorite' },
              { row: 'R3', event_id: 'nba-401910102', side: 'Denver Nuggets ML', reason: 'Home altitude edge' },
            ],
            scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Approved 2 legs.' }],
          }),
        ),
      } as unknown as Agent;

      // Dedicated verifier repeatedly vetoes all legs across repair retries so retries exhaust
      const criticAgent = {
        id: 'verifier',
        role: 'Verification Critic',
        provider: 'groq',
        modelName: 'llama-3.3-70b-versatile',
        setSystemInstruction: vi.fn(),
        run: vi.fn(async () =>
          JSON.stringify({
            pass: false,
            vetoedLegs: ['R1', 'R3'],
            feedback: 'Veto R1 (Boston Celtics ML) and R3 (Denver Nuggets ML): ungrounded injury claims on both legs.',
          }),
        ),
      } as unknown as Agent;

      const result = await runDeepAnalysisVerification({
        task: slate,
        rawInput: slate,
        effectiveDynamicPrompt: slate,
        effectiveCompiledReports: 'Quant a1 proposed R1 and R3.',
        effectiveHistoricalContext: '',
        managerAgent,
        analysts: [],
        dedicatedCriticAgent: criticAgent,
        context: ctx,
        settings: { maxRepairRetries: 1, model: 'gemini-2.5-flash' } as any,
        toolResults: '',
        criticVetoes: ['Risk Critic Veto: R1 and R3 ungrounded.'],
        criticVerdictApproved: false,
        hadProposedPicks: true,
        seatScorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Stale approve note' }],
      });

      const final = result.finalAnalysis;
      expect(final.picks).toEqual([]);
      expect(final.wageringPass).toBe(true);
      expect(final.criticApproved).toBe(false);
      expect(final.verified).toBe(false);
      expect(final.pass).toBe(true);
      expect(final.status).toBe('no_play');

      const riskCard = (final.scorecards || []).find(
        (s: any) => String(s?.seat || '').toLowerCase().includes('critic'),
      );
      expect(riskCard).toBeDefined();
      expect(riskCard.verdict).toBe('veto');
      expect(String(riskCard.notes || '')).not.toContain('Stale approve note');
      expect(String(final.summary || '')).not.toMatch(/picks\s*=\s*2|2-leg/i);
    });
  });

  describe('S2: Tightened Tier-1 Q thresholds + 0-min/0-TOI DNP handling on partial log teams', () => {
    it('classifies Snuggerud, Carlile, Sion James, Jalen Smith below Tier-1, preserves Embiid & Malkin as Tier-1 Q, and handles 0-min DNPs on <5-date teams as unlogged (1.0)', async () => {
      // S2 unit checks: Sion James (NBA 25 MPG / 8.4 PPG) & Jalen Smith (NBA 21.5 MPG / 10.2 PPG) -> Tier 2 (1.5)
      const sionScore = scoreInjuryStarterTier(
        { player_name: 'Sion James', team_abbr: 'CHA', status: 'QUESTIONABLE' },
        [{ player_name: 'Sion James', team_abbr: 'CHA', position: 'G', minutes: 25.0, points: 8.4, assists: 2.0, stats: { rebounds: 3.1 } }],
        'basketball_nba',
      );
      expect(sionScore).toMatchObject({ tier: 2, weight: 1.5 });

      const jalenScore = scoreInjuryStarterTier(
        { player_name: 'Jalen Smith', team_abbr: 'CHI', status: 'QUESTIONABLE' },
        [{ player_name: 'Jalen Smith', team_abbr: 'CHI', position: 'C', minutes: 21.5, points: 10.2, assists: 1.4, stats: { rebounds: 6.1 } }],
        'basketball_nba',
      );
      expect(jalenScore).toMatchObject({ tier: 2, weight: 1.5 });

      // Declan Carlile: espn_depthchart rank 1 non-G NHL skater without corroborating boxscore -> Tier 2 (1.5), NOT Tier 1
      const carlileScore = scoreInjuryStarterTier(
        { player_name: 'Declan Carlile', team_abbr: 'TBL', status: 'QUESTIONABLE' },
        [{ source: 'espn_depthchart', player_name: 'Declan Carlile', team_abbr: 'TBL', stats: { position: 'D', depth_rank: 1, starter: true } }],
        'icehockey_nhl',
      );
      expect(carlileScore?.tier).toBe(2);
      expect(carlileScore?.weight).toBe(1.5);

      // Joel Embiid (>= 28 MPG + >= 18 PPG) and Evgeni Malkin (>= 18.5 TOI/G + >= 0.65 PPG) stay Tier-1
      const embiidScore = scoreInjuryStarterTier(
        { player_name: 'Joel Embiid', team_abbr: 'PHI', status: 'QUESTIONABLE' },
        [{ player_name: 'Joel Embiid', team_abbr: 'PHI', position: 'C', minutes: 33.2, points: 28.4, assists: 4.8, stats: { rebounds: 10.5 } }],
        'basketball_nba',
      );
      expect(embiidScore?.tier).toBe(1);

      const malkinScore = scoreInjuryStarterTier(
        { player_name: 'Evgeni Malkin', team_abbr: 'PIT', status: 'QUESTIONABLE' },
        [{ player_name: 'Evgeni Malkin', team_abbr: 'PIT', position: 'C', toi_minutes: 19.5, points: 0.9 }],
        'icehockey_nhl',
      );
      expect(malkinScore?.tier).toBe(1);

      // End-to-end getInjuryAndRosterDeltaTool check for nhl-401892785:
      // Blues (away) have Jimmy Snuggerud (16:00 TOI/G, 0.45 PPG, Q -> Tier 2) + Robert Thomas (Tier 1 OUT = 3.0)
      // + Blues D1 (espn_depthchart rank 1 D, OUT -> Tier 2 = 1.5) = 4.5 OUT impact.
      // Islanders (home) have 3 distinct game_dates (<5, so canProveUnloggedDepth === false) and Islanders ZeroTOI (0 TOI OUT -> unlogged 1.0).
      const threeDates = ['2026-04-01', '2026-04-03', '2026-04-05'];
      const nhlLogs = [
        ...threeDates.flatMap((d) => [
          { player_name: 'Jimmy Snuggerud', team_abbr: 'STL', position: 'RW', toi_seconds: 960, points: 0.45, game_date: d },
          { player_name: 'Robert Thomas', team_abbr: 'STL', position: 'C', toi_seconds: 1260, points: 0.95, game_date: d },
          { player_name: 'Bo Horvat', team_abbr: 'NYI', position: 'C', toi_seconds: 1230, points: 0.92, game_date: d },
        ]),
        { source: 'espn_depthchart', player_name: 'Blues D1', team_abbr: 'STL', stats: { position: 'D', depth_rank: 1, starter: true } },
        { player_name: 'Islanders ZeroTOI', team_abbr: 'NYI', position: 'LW', toi_seconds: 0, points: 0, game_date: '2026-04-01' },
      ];
      const nhlFetch = vi.fn(async (url: string) => {
        if (url.includes('get_injury_and_roster_delta_v1')) {
          return new Response(
            JSON.stringify({
              game_id: 'nhl-401892785',
              sport: 'icehockey_nhl',
              home_team: 'New York Islanders',
              away_team: 'St. Louis Blues',
              injuries: [
                { team_name: 'St. Louis Blues', team_abbr: 'STL', player_name: 'Jimmy Snuggerud', position: 'RW', status: 'QUESTIONABLE' },
                { team_name: 'St. Louis Blues', team_abbr: 'STL', player_name: 'Robert Thomas', position: 'C', status: 'OUT' },
                { team_name: 'St. Louis Blues', team_abbr: 'STL', player_name: 'Blues D1', position: 'D', status: 'OUT' },
                { team_name: 'New York Islanders', team_abbr: 'NYI', player_name: 'Islanders ZeroTOI', position: 'LW', status: 'OUT' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/rest/v1/player_game_logs')) {
          return new Response(JSON.stringify(nhlLogs), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      });

      const nhlRes: any = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'nhl-401892785' },
        { fetchFn: nhlFetch, env: mockEnv },
      );
      expect(nhlRes.success).toBe(true);
      // STL 4.5 OUT impact vs NYI 1.0 unlogged OUT -> home_advantage (New York Islanders, +3.5 impact edge), NOT uncertain_questionable
      expect(nhlRes.summary).toContain('home_advantage (New York Islanders');
      expect(nhlRes.summary).not.toContain('uncertain_questionable');

      const nhlInjuries = nhlRes.data?.injuries ?? nhlRes.injuries ?? [];
      const nyiZero = nhlInjuries.find((r: any) => r.player_name === 'Islanders ZeroTOI');
      expect(nyiZero).toMatchObject({ impact_role: 'unlogged', impact_weight: 1.0 });

      // Contrast: when team HAS >= 5 distinct game_dates and player logs 0 min, they get 'depth' (0.5)
      const fiveDateLogs = ['2026-04-01', '2026-04-03', '2026-04-05', '2026-04-07', '2026-04-09'].flatMap((d) => [
        { player_name: 'Full Rotation Star', team_abbr: 'UTA', position: 'PF', minutes: 34.0, points: 24.0, game_date: d },
        { player_name: 'Dnp Zero Bench', team_abbr: 'UTA', position: 'G', minutes: 0, points: 0, game_date: d },
      ]);
      const nbaFetch = vi.fn(async (url: string) => {
        if (url.includes('get_injury_and_roster_delta_v1')) {
          return new Response(
            JSON.stringify({
              game_id: 'nba-401910555',
              sport: 'basketball_nba',
              home_team: 'Utah Jazz',
              away_team: 'Philadelphia 76ers',
              injuries: [
                { team_name: 'Utah Jazz', team_abbr: 'UTA', player_name: 'Dnp Zero Bench', position: 'G', status: 'OUT' },
                { team_name: 'Philadelphia 76ers', team_abbr: 'PHI', player_name: 'Joel Embiid', position: 'C', status: 'QUESTIONABLE' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/rest/v1/player_game_logs')) {
          return new Response(
            JSON.stringify([
              ...fiveDateLogs,
              { player_name: 'Joel Embiid', team_abbr: 'PHI', position: 'C', minutes: 33.2, points: 28.4, game_date: '2026-04-01' },
            ]),
            { status: 200 },
          );
        }
        return new Response('[]', { status: 200 });
      });

      const nbaRes: any = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'nba-401910555' },
        { fetchFn: nbaFetch, env: mockEnv },
      );
      expect(nbaRes.success).toBe(true);
      const nbaInjuries = nbaRes.data?.injuries ?? nbaRes.injuries ?? [];
      const utaZero = nbaInjuries.find((r: any) => r.player_name === 'Dnp Zero Bench');
      expect(utaZero).toMatchObject({ impact_role: 'depth', impact_weight: 0.5 });
      expect(nbaRes.summary).toContain('uncertain_questionable');
    });
  });

  describe('S3: Soft cooldown on consecutive or heavy-prompt timeouts + [COOLDOWN_SKIP]', () => {
    const origNvidia = ProviderRegistry.get('nvidia');
    const origGemini = ProviderRegistry.get('gemini');

    beforeEach(() => {
      globalProviderLimiter.reset();
    });

    afterEach(() => {
      ProviderRegistry.register(origNvidia);
      ProviderRegistry.register(origGemini);
      globalProviderLimiter.reset();
      vi.useRealTimers();
    });

    it('opens 10m cooldown after 1 heavy-prompt (>6000 tok) timeout, skips subsequent call to gemini failover in <50ms, and logs [COOLDOWN_SKIP]', async () => {
      const nvidiaCall = vi.fn(async () => {
        throw new Error('Request timed out after 30000ms [TIMEOUT]');
      });
      const geminiCall = vi.fn(async () =>
        JSON.stringify({ picks: [], confidence: 0.5, summary: 'Gemini fallback OK' }),
      );

      ProviderRegistry.register({ providerName: 'nvidia', call: nvidiaCall } as any);
      ProviderRegistry.register({ providerName: 'gemini', call: geminiCall } as any);

      // > 6,000 estimated tokens and < 8,000 NVIDIA maxInputTokens (~6,800 words)
      const heavyPrompt = `Analyze slate:\n${'data '.repeat(6800)}`;

      const ctx1 = new SwarmContext();
      (ctx1 as any).id = 'wf-cooldown-run1';
      const agent1 = new Agent(
        'Quant Analyst',
        'nemotron-3-ultra-550b-a55b',
        'nvidia',
        'nvapi-test-key',
        undefined,
        [{ provider: 'gemini', modelName: 'gemini-3.5-flash-lite', apiKey: 'AIzaTestKey123456' }],
        undefined,
        'a1',
      );
      await agent1.run(heavyPrompt, ctx1, { maxRetries: 1, timeoutMs: 30000 });
      expect(nvidiaCall).toHaveBeenCalledTimes(1);
      expect(geminiCall).toHaveBeenCalledTimes(1);
      expect(globalProviderLimiter.getSkipReason('nvidia', 'nemotron-3-ultra-550b-a55b')).toContain('[COOLDOWN_SKIP]');

      // Second run immediately afterward must skip NVIDIA in <50ms without calling nvidiaCall again
      const ctx2 = new SwarmContext();
      (ctx2 as any).id = 'wf-cooldown-run2';
      const agent2 = new Agent(
        'Quant Analyst',
        'nemotron-3-ultra-550b-a55b',
        'nvidia',
        'nvapi-test-key',
        undefined,
        [{ provider: 'gemini', modelName: 'gemini-3.5-flash-lite', apiKey: 'AIzaTestKey123456' }],
        undefined,
        'a1',
      );
      const t0 = Date.now();
      await agent2.run('Short follow-up prompt', ctx2, { maxRetries: 1, timeoutMs: 30000 });
      const elapsedMs = Date.now() - t0;

      expect(elapsedMs).toBeLessThan(50);
      expect(nvidiaCall).toHaveBeenCalledTimes(1);
      expect(geminiCall).toHaveBeenCalledTimes(2);

      const diag = buildCompactRunDiagnostics({ events: ctx2.events, totalMs: elapsedMs });
      const cooldownFailover = diag.failovers.find((f) => f.reason === '[COOLDOWN_SKIP]');
      expect(cooldownFailover).toBeDefined();
      expect(cooldownFailover?.from).toBe('nvidia/nemotron-3-ultra-550b-a55b');
      expect(cooldownFailover?.to).toBe('gemini/gemini-3.5-flash-lite');
    });

    it('requires 2 consecutive timeouts on <=6000 token prompts, clears on recordSuccess, and expires after 10 minutes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
      globalProviderLimiter.reset();

      // 1st light-prompt timeout -> no cooldown yet
      globalProviderLimiter.recordFailure('nvidia', 'nemotron-3-ultra-550b-a55b', 'network timeout', true, 1200);
      expect(globalProviderLimiter.getSkipReason('nvidia', 'nemotron-3-ultra-550b-a55b')).toBeNull();

      // Success resets consecutive count -> next single timeout still does not open cooldown
      globalProviderLimiter.recordSuccess('nvidia', 'nemotron-3-ultra-550b-a55b');
      globalProviderLimiter.recordFailure('nvidia', 'nemotron-3-ultra-550b-a55b', 'network timeout', true, 1200);
      expect(globalProviderLimiter.getSkipReason('nvidia', 'nemotron-3-ultra-550b-a55b')).toBeNull();

      // 2nd consecutive light-prompt timeout -> opens 10m cooldown
      globalProviderLimiter.recordFailure('nvidia', 'nemotron-3-ultra-550b-a55b', 'AbortError timed out', true, 1200);
      expect(globalProviderLimiter.getSkipReason('nvidia', 'nemotron-3-ultra-550b-a55b')).toContain('[COOLDOWN_SKIP]');

      // Still active at 9m 59s; expires after 10m 01s
      vi.advanceTimersByTime(9 * 60 * 1000 + 59 * 1000);
      expect(globalProviderLimiter.getSkipReason('nvidia', 'nemotron-3-ultra-550b-a55b')).toContain('[COOLDOWN_SKIP]');

      vi.advanceTimersByTime(2_000);
      expect(globalProviderLimiter.getSkipReason('nvidia', 'nemotron-3-ultra-550b-a55b')).toBeNull();
    });
  });
});
