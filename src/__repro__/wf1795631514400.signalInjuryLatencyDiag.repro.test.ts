import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  auditCriticPremiseContradictions,
  parseCompactSlateModelSignals,
} from '../swarm/tools/claimGrounding.ts';
import {
  normalizeScorecardEntry,
  normalizeScorecardsArray,
  guardManagerResponse,
} from '../swarm/parser/responseGuards.ts';
import {
  getInjuryAndRosterDeltaTool,
  scorePlayerGameLogStarterRow,
} from '../swarm/tools/dueloddsRpcTools.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { GeminiAdapter } from '../swarm/providers/gemini.ts';
import { GroqAdapter } from '../swarm/providers/groq.ts';
import { CloudflareAdapter } from '../swarm/providers/cloudflare.ts';
import { MistralAdapter } from '../swarm/providers/mistral.ts';
import { globalProviderLimiter, isGeminiProjectWideFailure } from '../swarm/providers/limiter.ts';
import { NvidiaAdapter } from '../swarm/providers/nvidia.ts';
import { buildCompactRunDiagnostics } from '../swarm/engine/runDiagnostics.ts';
import { handleSwarmSse } from '../swarm/server/streaming.ts';

describe('wf-1795631514400: S1 model_signal guard + scorecards, S2 injury parity + season stats, S3 Gemini fast-abort + a1 bounds, S4 inline diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalProviderLimiter.reset();
    ProviderRegistry.register(new GeminiAdapter());
    ProviderRegistry.register(new GroqAdapter());
    ProviderRegistry.register(new CloudflareAdapter());
    ProviderRegistry.register(new MistralAdapter());
    ProviderRegistry.register(new NvidiaAdapter());
  });

  // =========================================================================
  // S1 — Deterministic model_signal_misread Guard & Nested scorecards[]
  // =========================================================================
  describe('S1: Deterministic model_signal_misread Guard & Nested scorecards[] Normalization', () => {
    const SLATE_WITH_SIGNALS = [
      'COMPACT SLATE:',
      'nhl-401892785 | icehockey_nhl | Boston Bruins @ New York Islanders | model_signal=lean_home',
      '  R2: New York Islanders ML -135',
      '  R3: Boston Bruins ML +115',
      'nhl-401892792 | icehockey_nhl | Montreal Canadiens @ Colorado Avalanche',
      '  R95: Colorado Avalanche ML -210',
      '  R96: Montreal Canadiens ML +175',
      'nhl-401892799 | icehockey_nhl | Carolina Hurricanes @ Tampa Bay Lightning | model_signal=neutral',
      '  R110: Tampa Bay Lightning ML -120',
    ].join('\n');

    it('parses COMPACT SLATE model_signal tags accurately (lean_home, neutral, none when omitted)', () => {
      const map = parseCompactSlateModelSignals(SLATE_WITH_SIGNALS);
      expect(map.get('nhl-401892785')).toBe('lean_home');
      expect(map.get('nhl-401892792')).toBe('none');
      expect(map.get('nhl-401892799')).toBe('neutral');
    });

    it('triggers model_signal_misread when proposing R95 (nhl-401892792, no model_signal tag) with "model_signal lean_home"', () => {
      const proposal = {
        picks: [
          {
            row_id: 'R95',
            event_id: 'nhl-401892792',
            pick: 'Colorado Avalanche ML',
            odds: -210,
            reason: 'Colorado Avalanche backed by model_signal lean_home and strong home form.',
          },
        ],
        analysis: 'R95 satisfies all three pillars (form, model_signal, health).',
      };

      const audit = auditCriticPremiseContradictions(proposal, '', SLATE_WITH_SIGNALS);
      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('model_signal_misread');
      expect(audit.violations.some((v) => /model_signal_misread/i.test(v) && /nhl-401892792|R95/i.test(v))).toBe(true);
    });

    it('triggers model_signal_misread when claiming model_signal support on a neutral game (nhl-401892799)', () => {
      const proposal = {
        picks: [
          {
            row_id: 'R110',
            event_id: 'nhl-401892799',
            pick: 'Tampa Bay Lightning ML',
            odds: -120,
            reason: 'Supported by model_signal lean_home.',
          },
        ],
      };

      const audit = auditCriticPremiseContradictions(proposal, '', SLATE_WITH_SIGNALS);
      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('model_signal_misread');
    });

    it('passes cleanly when proposing R2 (New York Islanders ML, nhl-401892785, model_signal=lean_home) with "model_signal lean_home"', () => {
      const proposal = {
        picks: [
          {
            row_id: 'R2',
            event_id: 'nhl-401892785',
            pick: 'New York Islanders ML',
            odds: -135,
            reason: 'New York Islanders ML supported by model_signal lean_home.',
          },
        ],
        analysis: 'R2 aligns cleanly with the home model_signal.',
      };

      const audit = auditCriticPremiseContradictions(proposal, '', SLATE_WITH_SIGNALS);
      expect(audit.flags).not.toContain('model_signal_misread');
      expect(audit.pass).toBe(true);
    });

    it('flags model_signal_misread when backing the away team on a lean_home game while citing model_signal', () => {
      const proposal = {
        picks: [
          {
            row_id: 'R3',
            event_id: 'nhl-401892785',
            pick: 'Boston Bruins ML',
            odds: 115,
            reason: 'Boston Bruins ML backed by model_signal support.',
          },
        ],
      };

      const audit = auditCriticPremiseContradictions(proposal, '', SLATE_WITH_SIGNALS);
      expect(audit.pass).toBe(false);
      expect(audit.flags).toContain('model_signal_misread');
    });

    it('normalizes nested Cloudflare Llama scorecard { seat: "Risk Critic", scorecard: { approve: "R2 and R95", veto: "" } }', () => {
      const normalized = normalizeScorecardEntry({
        seat: 'Risk Critic',
        scorecard: { approve: 'R2 and R95', veto: '' },
      });
      expect(normalized).toEqual({
        seat: 'Risk Critic',
        verdict: 'approve',
        notes: 'R2 and R95',
      });

      const mixed = normalizeScorecardsArray([
        { seat: 'Risk Critic', scorecard: { approve: 'R2', veto: 'R95 (model_signal_misread)' } },
        { seat: 'Market Critic', scorecard: { approve: '', veto: 'R95 bad price' } },
      ]);
      expect(mixed[0]).toEqual({
        seat: 'Risk Critic',
        verdict: 'partial',
        notes: 'Approve: R2; Veto: R95 (model_signal_misread)',
      });
      expect(mixed[1]).toEqual({
        seat: 'Market Critic',
        verdict: 'veto',
        notes: 'R95 bad price',
      });

      const guarded = guardManagerResponse({
        ui_title: 'NHL Picks',
        summary: 'Backing R2 on the Islanders.',
        picks: [{ row_id: 'R2', pick: 'New York Islanders ML', odds: -135 }],
        scorecards: [
          { seat: 'Risk Critic', scorecard: { approve: 'R2 and R95', veto: '' } },
        ],
        components: [],
      });
      expect((guarded as any).scorecards).toEqual([
        { seat: 'Risk Critic', verdict: 'approve', notes: 'R2 and R95' },
      ]);
    });
  });

  // =========================================================================
  // S2 — Fix Mixed 0.5 vs 1.0 Injury Math & Season-Stats Star Resolution
  // =========================================================================
  describe('S2: Injury Coverage Parity, Unlogged Neutral 1.0 Weight, and Season-Stats Stars', () => {
    const testEnv = {
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    };

    it('mixed coverage: Team A has 1 logged game (3 OUT, all unlogged) and Team B has 0 logged games (4 OUT, all unlogged) stays [unweighted_fallback] (3 vs 4 = symmetric), NEVER 1.5 vs 4.0', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              // Only 1 game_date for Team A (MTL) with an unrelated healthy player, and 0 rows for Team B (COL)
              {
                player_id: '8477934',
                sport: 'icehockey_nhl',
                team_abbr: 'MTL',
                game_date: '2026-11-24',
                stats: { position: 'C', toi_minutes: 19.5, points: 1 },
              },
            ],
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event_id: 'nhl-401892792',
            sport: 'icehockey_nhl',
            home_team: 'Colorado Avalanche',
            away_team: 'Montreal Canadiens',
            injuries: [
              // 3 OUT on MTL (all unlogged)
              { player_id: '9001', player_name: 'Kirby Dach', team: 'Montreal Canadiens', position: 'C', status: 'OUT' },
              { player_id: '9002', player_name: 'Patrik Laine', team: 'Montreal Canadiens', position: 'RW', status: 'OUT' },
              { player_id: '9003', player_name: 'Kaiden Guhle', team: 'Montreal Canadiens', position: 'D', status: 'OUT' },
              // 4 OUT on COL (all unlogged)
              { player_id: '9101', player_name: 'Gabriel Landeskog', team: 'Colorado Avalanche', position: 'LW', status: 'OUT' },
              { player_id: '9102', player_name: 'Artturi Lehkonen', team: 'Colorado Avalanche', position: 'LW', status: 'OUT' },
              { player_id: '9103', player_name: 'Valeri Nichushkin', team: 'Colorado Avalanche', position: 'RW', status: 'OUT' },
              { player_id: '9104', player_name: 'Jonathan Drouin', team: 'Colorado Avalanche', position: 'LW', status: 'OUT' },
            ],
          }),
        };
      });

      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nhl-401892792' },
        { env: testEnv, fetchFn: mockFetch as any },
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[unweighted_fallback]');
      expect(res.summary).toContain('symmetric');
      // Never produce the bogus 1.5 vs 4.0 (+2.5 impact edge)
      expect(res.summary).not.toContain('1.5');
      expect(res.summary).not.toContain('+2.5');
      expect(res.summary).not.toContain('depth');

      const injuries = (res.data as any)?.injuries || [];
      expect(injuries).toHaveLength(7);
      for (const p of injuries) {
        expect(p.impact_weight).toBe(1.0);
        expect(p.impact_role).toBe('unlogged');
      }
    });

    it('season-stats star: Stephen Curry with source="espn_season_stats" (minutes: 33.2, points: 26.4) scores Tier 1 (3.0), never "depth"', async () => {
      const directScore = scorePlayerGameLogStarterRow(
        {
          player_id: '3975',
          player_name: 'Stephen Curry',
          team_abbr: 'GSW',
          source: 'espn_season_stats',
          stats: { position: 'PG', minutes: 33.2, points: 26.4 },
        },
        'basketball_nba',
      );
      expect(directScore).not.toBeNull();
      expect(directScore?.tier).toBe(1);
      expect(directScore?.weight).toBe(3.0);
      expect(directScore?.source).toBe('season_stats');

      const nhlScore = scorePlayerGameLogStarterRow(
        {
          player_id: '8477492',
          player_name: 'Nathan MacKinnon',
          team_abbr: 'COL',
          source: 'nhl_club_stats',
          stats: { position: 'C', toi: 22.4, goals: 34, assists: 58, games_played: 64 },
        },
        'icehockey_nhl',
      );
      expect(nhlScore).not.toBeNull();
      expect(nhlScore?.tier).toBe(1);
      expect(nhlScore?.weight).toBe(3.0);

      // End-to-end through getInjuryAndRosterDeltaTool with both teams covered via espn_season_stats
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('player_game_logs')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                player_id: '3975',
                player_name: 'Stephen Curry',
                sport: 'basketball_nba',
                team_abbr: 'GSW',
                source: 'espn_season_stats',
                stats: { position: 'PG', minutes: 33.2, points: 26.4 },
              },
              {
                player_id: '4278073',
                player_name: 'Bench Guard',
                sport: 'basketball_nba',
                team_abbr: 'LAL',
                source: 'espn_season_stats',
                stats: { position: 'SG', minutes: 9.5, points: 3.2 },
              },
            ],
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event_id: 'nba-401910555',
            sport: 'basketball_nba',
            home_team: 'Golden State Warriors',
            away_team: 'Los Angeles Lakers',
            injuries: [
              { player_id: '3975', player_name: 'Stephen Curry', team: 'Golden State Warriors', position: 'PG', status: 'OUT' },
              { player_id: '4278073', player_name: 'Bench Guard', team: 'Los Angeles Lakers', position: 'SG', status: 'OUT' },
            ],
          }),
        };
      });

      const res = await getInjuryAndRosterDeltaTool.execute(
        { game_id: 'nba-401910555' },
        { env: testEnv, fetchFn: mockFetch as any },
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain('[impact 3.0: Stephen Curry]');
      expect(res.summary).toContain('away_advantage');
      expect(res.summary).not.toContain('[unweighted_fallback]');
      const gswOut = ((res.data as any)?.injuries || []).find((p: any) => p.player_name === 'Stephen Curry');
      expect(gswOut?.player_name).toBe('Stephen Curry');
      expect(gswOut?.impact_tier).toBe(1);
      expect(gswOut?.impact_weight).toBe(3.0);
      expect(gswOut?.impact_role).toBe('star');
    });
  });

  // =========================================================================
  // S3 — Gemini Fast-Abort (400/403 vs 503) & a1 Bounded Timeout/Tokens
  // =========================================================================
  describe('S3: Gemini Fast-Abort on 400/403 (Keep Sibling Cascade on 503) & a1 30s Timeout Bound', () => {
    let origSleep: any;

    beforeEach(() => {
      origSleep = (globalProviderLimiter as any).sleep;
      (globalProviderLimiter as any).sleep = async () => {};
    });

    afterEach(() => {
      (globalProviderLimiter as any).sleep = origSleep;
    });

    it('Gemini fast-abort: primary returning 400 or 403 skips remaining Gemini siblings and jumps straight to Cloudflare in 1 hop', async () => {
      for (const statusCode of [400, 403]) {
        globalProviderLimiter.reset();
        const calledGeminiModels: string[] = [];
        const calledCloudflareModels: string[] = [];

        ProviderRegistry.register({
          providerName: 'gemini',
          async call(opts: any) {
            calledGeminiModels.push(opts.modelName);
            const err: any = new Error(
              statusCode === 400
                ? 'Gemini API Error (400): INVALID_ARGUMENT bad request'
                : 'Gemini API Error (403): PERMISSION_DENIED invalid API key',
            );
            err.status = statusCode;
            throw err;
          },
        } as any);

        ProviderRegistry.register({
          providerName: 'cloudflare',
          async call(opts: any) {
            calledCloudflareModels.push(opts.modelName);
            return JSON.stringify({ ui_title: 'OK', summary: `Recovered after ${statusCode}`, components: [] });
          },
        } as any);

        const agent = new Agent(
          'Manager Node',
          'gemini-3.5-flash-lite',
          'gemini',
          'gem-key',
          undefined,
          [
            { provider: 'gemini', modelName: 'gemini-3.1-flash-lite', apiKey: 'gem-key' },
            { provider: 'gemini', modelName: 'gemini-3.8-flash', apiKey: 'gem-key' },
            { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'acc:tok' },
          ],
        );
        agent.preserveFallbackOrder = true;

        const ctx = new SwarmContext();
        const res = await agent.run('Compile final slate', ctx, {
          responseMimeType: 'application/json',
          bypassCache: true,
        });

        expect(res.summary).toBe(`Recovered after ${statusCode}`);
        // Must have skipped gemini-3.1-flash-lite and gemini-3.8-flash in 1 hop!
        expect(calledGeminiModels).toEqual(['gemini-3.5-flash-lite']);
        expect(calledCloudflareModels).toEqual(['@cf/meta/llama-3.3-70b-instruct-fp8-fast']);

        const cascade = ctx.events.find(
          (e) => e.action === 'Provider Failover Triggered' && e.failover?.toProvider === 'cloudflare',
        );
        expect(cascade?.failover?.fromModel).toBe('gemini-3.5-flash-lite');
        expect(cascade?.failover?.status).toBe(statusCode);
      }

      // Also verify helper classification directly
      expect(isGeminiProjectWideFailure({ status: 400, message: 'INVALID_ARGUMENT' })).toBe(true);
      expect(isGeminiProjectWideFailure({ status: 403, message: 'PERMISSION_DENIED' })).toBe(true);
      expect(isGeminiProjectWideFailure({ status: 429, message: 'Quota exceeded, limit: 0' })).toBe(true);
      expect(isGeminiProjectWideFailure({ status: 503, message: 'Service Unavailable' })).toBe(false);
    });

    it('Gemini 503: primary returning 503 STILL tries sibling gemini-3.1-flash-lite before leaving Gemini', async () => {
      const calledModels: string[] = [];

      ProviderRegistry.register({
        providerName: 'gemini',
        async call(opts: any) {
          calledModels.push(`gemini/${opts.modelName}`);
          if (opts.modelName === 'gemini-3.5-flash-lite') {
            const err: any = new Error('Gemini API Error (503): Overloaded');
            err.status = 503;
            throw err;
          }
          return JSON.stringify({ ui_title: 'OK', summary: 'Recovered on Gemini sibling', components: [] });
        },
      } as any);

      ProviderRegistry.register({
        providerName: 'cloudflare',
        async call(opts: any) {
          calledModels.push(`cloudflare/${opts.modelName}`);
          return JSON.stringify({ ui_title: 'CF', summary: 'Should not be needed', components: [] });
        },
      } as any);

      const agent = new Agent(
        'Manager Node',
        'gemini-3.5-flash-lite',
        'gemini',
        'gem-key',
        undefined,
        [
          { provider: 'gemini', modelName: 'gemini-3.1-flash-lite', apiKey: 'gem-key' },
          { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'acc:tok' },
        ],
      );
      agent.preserveFallbackOrder = true;

      const ctx = new SwarmContext();
      const res = await agent.run('Compile final slate', ctx, {
        responseMimeType: 'application/json',
        bypassCache: true,
      });

      expect(res.summary).toBe('Recovered on Gemini sibling');
      expect(calledModels).toContain('gemini/gemini-3.5-flash-lite');
      expect(calledModels).toContain('gemini/gemini-3.1-flash-lite');
      expect(calledModels.some((m) => m.startsWith('cloudflare/'))).toBe(false);
    });

    it('a1 (Quant Proposer / NVIDIA 550B) bounds max_tokens <= 1800, sets reasoning_effort, caps timeout <= 30s with single attempt, and fails over cleanly on timeout', async () => {
      const capturedBodies: any[] = [];
      let nvidiaFetchCount = 0;

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
        nvidiaFetchCount++;
        if (init?.body) {
          capturedBodies.push(JSON.parse(init.body));
        }
        const abortErr: any = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }) as any;

      try {
        const adapter = new NvidiaAdapter();
        await expect(
          adapter.call({
            role: 'Quant Proposer',
            modelName: 'nvidia/llama-3.1-nemotron-ultra-550b-v1',
            apiKey: 'nvapi-test-key',
            prompt: 'Propose 2 NHL picks',
            timeoutMs: 65000,
            config: {
              responseMimeType: 'application/json',
              maxTokens: 4096,
            },
          }),
        ).rejects.toThrow(/timed out/i);

        // Single attempt (retryOnTimeout: false) — no second 30s stall!
        expect(nvidiaFetchCount).toBe(1);
        expect(capturedBodies).toHaveLength(1);
        expect(capturedBodies[0].max_tokens).toBeLessThanOrEqual(1800);
        expect(capturedBodies[0].reasoning_effort).toBe('none');
      } finally {
        globalThis.fetch = origFetch;
      }

      // Verify Agent failover for Quant Proposer on NVIDIA timeout jumps cleanly on 1st attempt
      let nvidiaAgentCalls = 0;
      let capturedTimeoutMs: number | undefined;
      let capturedMaxTokens: number | undefined;
      let groqCalls = 0;

      ProviderRegistry.register({
        providerName: 'nvidia',
        async call(opts: any) {
          nvidiaAgentCalls++;
          capturedTimeoutMs = opts.timeoutMs;
          capturedMaxTokens = opts.config?.maxTokens;
          throw new Error('NVIDIA API timed out after 30000ms.');
        },
      } as any);

      ProviderRegistry.register({
        providerName: 'groq',
        async call() {
          groqCalls++;
          return JSON.stringify({ picks: [], analysis: 'Fast Groq fallback succeeded' });
        },
      } as any);

      const quantAgent = new Agent(
        'Quant Proposer',
        'nvidia/llama-3.1-nemotron-ultra-550b-v1',
        'nvidia',
        'nvapi-key',
        undefined,
        [{ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'groq-key' }],
      );
      quantAgent.preserveFallbackOrder = true;

      const ctx = new SwarmContext();
      const res = await quantAgent.run('Propose picks', ctx, {
        responseMimeType: 'application/json',
        maxTokens: 4096,
        bypassCache: true,
      });

      expect(res.analysis).toBe('Fast Groq fallback succeeded');
      expect(nvidiaAgentCalls).toBe(1);
      expect(groqCalls).toBe(1);
      expect(capturedTimeoutMs).toBeLessThanOrEqual(30000);
      expect(capturedMaxTokens).toBeLessThanOrEqual(1800);
    });
  });

  // =========================================================================
  // S4 — Compact (< 2 KB) Inline Diagnostics on Final Payload & run_timeout
  // =========================================================================
  describe('S4: Compact (< 2 KB) Inline Diagnostics on Final Payload & run_timeout', () => {
    it('builds deduplicated, secret-redacted, < 2 KB diagnostics with seatTimings and failovers', () => {
      const longSecretError =
        'Gemini API Error (403): key=AIzaSySuperSecretKey999999 Bearer sk-secret-token-12345 ' + 'z'.repeat(300);

      const events: any[] = [
        {
          id: 'e1',
          timestamp: new Date().toISOString(),
          agentRole: 'Quant Proposer',
          action: 'Provider Failover Triggered',
          modelName: 'nvidia / nemotron-3-ultra-550b',
          error: 'NVIDIA API timed out after 30000ms.',
          failover: {
            fromProvider: 'nvidia',
            fromModel: 'nemotron-3-ultra-550b',
            status: 408,
            errorSnippet: 'NVIDIA API timed out after 30000ms.',
            durationMs: 30012,
          },
        },
        {
          id: 'e2',
          timestamp: new Date().toISOString(),
          agentRole: 'Quant Proposer',
          action: 'Provider Failover Triggered',
          modelName: 'nvidia / nemotron-3-ultra-550b -> groq / openai/gpt-oss-120b',
          failover: {
            fromProvider: 'nvidia',
            fromModel: 'nemotron-3-ultra-550b',
            toProvider: 'groq',
            toModel: 'openai/gpt-oss-120b',
            status: 408,
            errorSnippet: 'NVIDIA API timed out after 30000ms.',
            durationMs: 30012,
          },
        },
        {
          id: 'e3',
          timestamp: new Date().toISOString(),
          agentRole: 'Quant Proposer',
          action: 'Completed execution via failover (groq/openai/gpt-oss-120b)',
          modelName: 'groq / openai/gpt-oss-120b',
          prompt: 'Analyze compact slate with 8 games',
          durationMs: 32500,
        },
        {
          id: 'e4',
          timestamp: new Date().toISOString(),
          agentRole: 'Manager Node',
          action: 'Provider Failover Triggered',
          modelName: 'gemini / gemini-3.5-flash-lite -> cloudflare / @cf/meta/llama-3.3-70b-instruct-fp8-fast',
          error: longSecretError,
          failover: {
            fromProvider: 'gemini',
            fromModel: 'gemini-3.5-flash-lite',
            toProvider: 'cloudflare',
            toModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            status: 403,
            errorSnippet: longSecretError,
            durationMs: 420,
          },
        },
        {
          id: 'e5',
          timestamp: new Date().toISOString(),
          agentRole: 'Manager Node',
          action: 'Completed execution via failover (cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast)',
          modelName: 'cloudflare / @cf/meta/llama-3.3-70b-instruct-fp8-fast',
          prompt: 'Compile final analysis',
          durationMs: 6400,
        },
      ];

      const diag = buildCompactRunDiagnostics({
        events,
        totalMs: 41200,
        hop1ToolsMs: 1850,
      });

      expect(diag.totalMs).toBe(41200);
      expect(diag.hop1ToolsMs).toBe(1850);
      expect(diag.seatTimings).toHaveLength(2);
      expect(diag.seatTimings[0]).toMatchObject({
        seat: 'a1',
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        durationMs: 32500,
        status: 'failover',
      });
      expect(diag.seatTimings[1]).toMatchObject({
        seat: 'manager',
        provider: 'cloudflare',
        status: 'failover',
      });

      // Raw + cascade pair for Quant Proposer was deduplicated into 1 failover record
      expect(diag.failovers).toHaveLength(2);
      expect(diag.failovers[0]).toMatchObject({
        seat: 'a1',
        from: 'nvidia/nemotron-3-ultra-550b',
        to: 'groq/openai/gpt-oss-120b',
        status: 408,
        durationMs: 30012,
      });
      expect(diag.failovers[1].seat).toBe('manager');
      expect(diag.failovers[1].status).toBe(403);
      expect(diag.failovers[1].error.length).toBeLessThanOrEqual(160);
      expect(diag.failovers[1].error).not.toContain('AIzaSySuperSecretKey999999');
      expect(diag.failovers[1].error).not.toContain('sk-secret-token-12345');
      expect(diag.failovers[1].error).toContain('[REDACTED]');

      const serialized = JSON.stringify(diag);
      expect(new TextEncoder().encode(serialized).length).toBeLessThan(2048);
    });

    it('enforces strict < 2 KB cap even with 30 verbose failover events', () => {
      const noisyEvents: any[] = Array.from({ length: 30 }, (_, idx) => ({
        id: `fo-${idx}`,
        timestamp: new Date().toISOString(),
        agentRole: `Seat ${idx}`,
        action: 'Provider Failover Triggered',
        failover: {
          fromProvider: 'gemini',
          fromModel: `gemini-3.5-flash-lite-${idx}`,
          toProvider: 'cloudflare',
          toModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          status: 503,
          errorSnippet: `Very verbose upstream error message #${idx} ${'x'.repeat(180)}`,
          durationMs: 1200 + idx,
        },
      }));

      const diag = buildCompactRunDiagnostics({ events: noisyEvents, totalMs: 60000, hop1ToolsMs: 2500 });
      expect(new TextEncoder().encode(JSON.stringify(diag)).length).toBeLessThan(2048);
    });

    it('emits inline diagnostics (seatTimings + failovers) in swarm_error SSE payload when run_timeout fires', async () => {
      const origEnv = process.env.SWARM_RUN_DEADLINE_MS;
      process.env.SWARM_RUN_DEADLINE_MS = '50';

      try {
        const { Hono } = await import('hono');
        const app = new Hono();
        const ctx = new SwarmContext();
        (ctx as any).id = 'wf-1795631514400-timeout-test';

        app.get('/sse', async (c) => {
          return handleSwarmSse(c, {
            prompt: 'Analyze NHL slate',
            data: 'slate',
            context: ctx,
            workflowExecutor: async (p: any) => {
              await p.onStage?.({ stage: 'hop1_exec', durationMs: 920 });
              await p.onEvent?.({
                id: 'ev-fo',
                timestamp: new Date().toISOString(),
                agentRole: 'Quant Proposer',
                action: 'Provider Failover Triggered',
                modelName: 'nvidia / nemotron-3-ultra-550b -> groq / openai/gpt-oss-120b',
                failover: {
                  fromProvider: 'nvidia',
                  fromModel: 'nemotron-3-ultra-550b',
                  toProvider: 'groq',
                  toModel: 'openai/gpt-oss-120b',
                  status: 408,
                  errorSnippet: 'NVIDIA timed out after 30000ms',
                  durationMs: 30000,
                },
              });
              await p.onEvent?.({
                id: 'ev-start',
                timestamp: new Date().toISOString(),
                agentRole: 'Risk Critic',
                action: 'Started execution',
                modelName: 'groq / openai/gpt-oss-120b',
              });
              await new Promise((resolve) => setTimeout(resolve, 250));
              return { status: 'complete', finalAnalysis: {} } as any;
            },
          } as any);
        });

        const res = await app.request('/sse');
        const body = await res.text();
        expect(body).toContain('event: swarm_error');

        const match = body.match(/event: swarm_error\ndata: (\{.*\})/);
        expect(match).not.toBeNull();
        const payload = JSON.parse(match![1]);

        expect(payload.error).toBe('run_timeout');
        expect(payload.diagnostics).toBeDefined();
        expect(payload.diagnostics.hop1ToolsMs).toBe(920);
        expect(payload.diagnostics.failovers).toHaveLength(1);
        expect(payload.diagnostics.failovers[0]).toMatchObject({
          seat: 'a1',
          from: 'nvidia/nemotron-3-ultra-550b',
          to: 'groq/openai/gpt-oss-120b',
          status: 408,
        });
        expect(
          payload.diagnostics.seatTimings.some(
            (s: any) => s.seat === 'critic' && s.status === 'timeout',
          ),
        ).toBe(true);
        expect(new TextEncoder().encode(JSON.stringify(payload.diagnostics)).length).toBeLessThan(2048);
      } finally {
        if (origEnv === undefined) {
          delete process.env.SWARM_RUN_DEADLINE_MS;
        } else {
          process.env.SWARM_RUN_DEADLINE_MS = origEnv;
        }
      }
    });
  });
});
