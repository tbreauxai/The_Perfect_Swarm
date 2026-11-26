import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import { auditCriticPremiseContradictions } from '../swarm/tools/claimGrounding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { buildGeminiRequestConfig } from '../swarm/providers/gemini.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { globalProviderLimiter } from '../swarm/providers/limiter.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { resolveSwarmAgents } from '../swarm/engine/agentResolution.ts';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';

const SLATE_4895 = [
  'event_id=nhl-401892901 | sport=icehockey_nhl | St. Louis Blues @ New York Islanders | model_signal=none | options: R1 ML New York Islanders(-122), R20 ML St. Louis Blues(+102)',
  'event_id=nba-401910501 | sport=basketball_nba | Houston Rockets @ Minnesota Timberwolves | model_signal=lean_home | options: R2 ML Minnesota Timberwolves(-145), R21 ML Houston Rockets(+122)',
  'event_id=nhl-401892902 | sport=icehockey_nhl | Calgary Flames @ Anaheim Ducks | model_signal=none | options: R62 ML Anaheim Ducks(-130), R63 ML Calgary Flames(+110)'
].join('\n');

const EVIDENCE_4895 = [
  'EVENT nhl-401892901',
  '[MARKET MOVEMENT: nhl-401892901] Steam: TOWARD home New York Islanders ML (-110 -> -122, +2.6pp implied) | AGAINST away St. Louis Blues ML (+100 -> +102)',
  '[INJURY & ROSTER DELTA: nhl-401892901] Summary: New York Islanders (1 OUT, 0 Q) vs St. Louis Blues (1 OUT, 0 Q) | Health Balance: symmetric',
  'EVENT nba-401910501',
  '[INJURY & ROSTER DELTA: nba-401910501] Summary: Minnesota Timberwolves (0 OUT, 0 Q) vs Houston Rockets (2 OUT, 0 Q) | Health Balance: home_advantage (Minnesota Timberwolves, +3.0 impact edge)',
  'EVENT nhl-401892902',
  '[INJURY & ROSTER DELTA: nhl-401892902] Summary: Anaheim Ducks (0 OUT, 0 Q) vs Calgary Flames (2 OUT, 0 Q) | Health Balance: home_advantage (Anaheim Ducks, +3.0 impact edge)'
].join('\n');

describe('wf-1795652004895: Per-Pick Grounding Isolation, Gemini 4/3.8 Hygiene & Long-Term OUT Depth Guard', () => {
  beforeEach(() => {
    globalProviderLimiter.reset();
  });

  it('S1: 3-leg fixture with generic 3-pillar intro produces 0 symmetric_injury_misread and 0 model_signal_misread vetoes, while catching true positives', () => {
    const headers = parseGameHeaders(SLATE_4895);

    const cleanSeat = {
      seat: 'a2',
      analysis:
        'These picks satisfy at least 2 of the 3 pillars: form/diff edge, steam or model_signal lean, and clean/asymmetric health.',
      picks: [
        { row: 'R1', event_id: 'nhl-401892901', side: 'New York Islanders ML', reason: 'Strong form and steam toward NYI.' },
        { row: 'R2', event_id: 'nba-401910501', side: 'Minnesota Timberwolves ML', reason: 'model_signal lean_home and home health edge.' },
        { row: 'R62', event_id: 'nhl-401892902', side: 'Anaheim Ducks ML', reason: 'Form edge and clean home health.' }
      ]
    };

    const cleanAudit = auditCriticPremiseContradictions(
      { picks: cleanSeat.picks, seatReports: [cleanSeat] },
      EVIDENCE_4895,
      SLATE_4895,
      { headers }
    );
    expect(cleanAudit.pass).toBe(true);
    expect(cleanAudit.flags).not.toContain('symmetric_injury_misread');
    expect(cleanAudit.flags).not.toContain('model_signal_misread');

    const badInjuryAudit = auditCriticPremiseContradictions(
      {
        picks: [
          { row: 'R1', event_id: 'nhl-401892901', side: 'New York Islanders ML', reason: 'Clear health advantage over Blues.' }
        ]
      },
      EVIDENCE_4895,
      SLATE_4895,
      { headers }
    );
    expect(badInjuryAudit.pass).toBe(false);
    expect(badInjuryAudit.flags).toContain('symmetric_injury_misread');

    const badSignalAudit = auditCriticPremiseContradictions(
      {
        picks: [
          { row: 'R62', event_id: 'nhl-401892902', side: 'Anaheim Ducks ML', reason: 'Supported by model_signal lean_home.' }
        ]
      },
      EVIDENCE_4895,
      SLATE_4895,
      { headers }
    );
    expect(badSignalAudit.pass).toBe(false);
    expect(badSignalAudit.flags).toContain('model_signal_misread');
  });

  it('S2.1 & S2.2: gemini-4-hydrogen sends thinkingLevel LOW (clamping minimal->low), strips thinking_budget/temperature, uses medium on a1 3.5-flash-lite failover, and caps proposer timeout at 15,000ms', async () => {
    const cfgDefault = buildGeminiRequestConfig('gemini-4-hydrogen', {
      modelName: 'gemini-4-hydrogen',
      prompt: 'hi',
      apiKey: 'k',
      config: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        thinking_budget: 1024,
        thinkingConfig: { thinkingLevel: 'minimal' }
      }
    });
    expect(cfgDefault.thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.LOW);
    expect(cfgDefault.thinking_budget).toBeUndefined();
    expect(cfgDefault.temperature).toBeUndefined();
    expect(cfgDefault.topP).toBeUndefined();
    expect(cfgDefault.topK).toBeUndefined();

    const cfg38 = buildGeminiRequestConfig('gemini-3.8-flash', {
      modelName: 'gemini-3.8-flash',
      prompt: 'hi',
      apiKey: 'k',
      config: { temperature: 0.5, thinking_budget: 512 }
    });
    expect(cfg38.thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.LOW);
    expect(cfg38.temperature).toBeUndefined();
    expect(cfg38.thinking_budget).toBeUndefined();

    // Verify a1 Gemini sibling order: gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.5-flash-lite before cloudflare
    const resolved = resolveSwarmAgents(
      {
        geminiApiKey: 'test-gem-key',
        cloudflareApiToken: 'test-cf-key',
        cloudflareAccountId: 'test-cf-acct',
        agents: [
          { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-3.8-flash' },
          { id: 'a1', role: 'Quant Proposer', provider: 'gemini', model: 'gemini-4-hydrogen' },
          { id: 'a2', role: 'Market Proposer', provider: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }
        ]
      } as any,
      undefined
    );
    const a1 = resolved.analysts.find((a) => a.id === 'a1')!;
    expect(a1.getFallbacks().slice(0, 3).map((f) => `${f.provider}:${f.modelName}`)).toEqual([
      'gemini:gemini-3.8-flash',
      'gemini:gemini-3.5-flash-lite',
      'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    ]);

    const origGemini = ProviderRegistry.get('gemini');
    const capturedCalls: Array<{ role?: string; modelName: string; timeoutMs?: number; thinkingLevel?: unknown }> = [];
    try {
      ProviderRegistry.register({
        providerName: 'gemini',
        async call(opts) {
          capturedCalls.push({
            role: opts.role,
            modelName: opts.modelName,
            timeoutMs: opts.timeoutMs,
            thinkingLevel: opts.config?.thinkingLevel ?? opts.config?.thinkingConfig?.thinkingLevel
          });
          if (opts.modelName === 'gemini-4-hydrogen') {
            throw new Error('[TIMEOUT] Gemini request timed out after 15000ms.');
          }
          return JSON.stringify({ summary: 'OK', insights: ['ok'], picks: [] });
        }
      });

      const quantAgent = new Agent('Quant Proposer', 'gemini-4-hydrogen', 'gemini', 'k', undefined, [
        { provider: 'gemini', modelName: 'gemini-3.5-flash-lite', apiKey: 'k' }
      ]);
      quantAgent.id = 'a1';
      await quantAgent.run('Analyze slate', new SwarmContext(), { bypassCache: true });

      expect(capturedCalls[0]).toMatchObject({ modelName: 'gemini-4-hydrogen', timeoutMs: 15000 });
      expect(capturedCalls[1]).toMatchObject({ modelName: 'gemini-3.5-flash-lite', thinkingLevel: 'medium' });

      const mgrAgent = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'gemini', 'k');
      await mgrAgent.run('Compile slate', new SwarmContext(), { bypassCache: true });
      expect(capturedCalls[2]).toMatchObject({ modelName: 'gemini-3.5-flash-lite', thinkingLevel: 'low' });
    } finally {
      if (origGemini) ProviderRegistry.register(origGemini);
    }
  });

  it('S2.3: 429 free_tier limit: 0 skips retries and jumps to next Gemini sibling in < 50ms', async () => {
    const origGemini = ProviderRegistry.get('gemini');
    const calledModels: string[] = [];
    try {
      ProviderRegistry.register({
        providerName: 'gemini',
        async call(opts) {
          calledModels.push(opts.modelName);
          if (opts.modelName === 'gemini-4-argon') {
            throw new Error(
              '429 RESOURCE_EXHAUSTED: Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0'
            );
          }
          return JSON.stringify({ summary: 'Recovered on sibling', insights: ['ok'], picks: [] });
        }
      });

      const a1 = new Agent('Quant Proposer', 'gemini-4-argon', 'gemini', 'k', undefined, [
        { provider: 'gemini', modelName: 'gemini-3.8-flash', apiKey: 'k' }
      ]);
      a1.id = 'a1';
      const t0 = Date.now();
      const out = await a1.run('Analyze slate', new SwarmContext(), { bypassCache: true });
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(50);
      expect(calledModels).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
      expect(out).toContain('Recovered on sibling');
      expect(globalProviderLimiter.isAvailable('gemini', 'gemini-4-argon')).toBe(false);
      expect(globalProviderLimiter.isAvailable('gemini', 'gemini-3.8-flash')).toBe(true);
    } finally {
      if (origGemini) ProviderRegistry.register(origGemini);
    }
  });

  it('S3: team with 6 distinct logged game_dates scores 0-row OUT star at 1.0 (unlogged) while 3-game 9.2 MPG player scores 0.5 (depth)', async () => {
    const sixDates = ['2026-11-10', '2026-11-12', '2026-11-14', '2026-11-16', '2026-11-18', '2026-11-20'];
    const logs = [
      ...sixDates.map((d) => ({
        player_name: 'Rudy Gobert',
        team_abbr: 'MIN',
        position: 'C',
        source: 'espn_boxscore',
        game_date: d,
        minutes: 32,
        points: 14
      })),
      ...sixDates.slice(0, 3).map((d) => ({
        player_name: 'Deep Reserve',
        team_abbr: 'MIN',
        position: 'G',
        source: 'espn_boxscore',
        game_date: d,
        minutes: 9.2,
        points: 2.0
      }))
    ];

    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(
          JSON.stringify({
            game_id: 'nba-401909320',
            sport: 'basketball_nba',
            home_team: 'Oklahoma City Thunder',
            away_team: 'Minnesota Timberwolves',
            injuries: [
              { team_name: 'Minnesota Timberwolves', team_abbr: 'MIN', player_name: 'Anthony Edwards', position: 'G', status: 'OUT' },
              { team_name: 'Minnesota Timberwolves', team_abbr: 'MIN', player_name: 'Deep Reserve', position: 'G', status: 'OUT' }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/rest/v1/player_game_logs')) {
        return new Response(JSON.stringify(logs), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });

    const res: any = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nba-401909320' },
      {
        fetchFn,
        env: {
          SUPABASE_URL: 'https://mock.supabase.co',
          SUPABASE_ANON_KEY: 'mock-anon',
          SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role'
        }
      }
    );

    const ant = res.data.injuries.find((i: any) => i.player_name === 'Anthony Edwards');
    const reserve = res.data.injuries.find((i: any) => i.player_name === 'Deep Reserve');
    expect(ant).toMatchObject({ impact_weight: 1.0, impact_role: 'unlogged' });
    expect(reserve).toMatchObject({ impact_weight: 0.5, impact_role: 'depth' });
  });
});
