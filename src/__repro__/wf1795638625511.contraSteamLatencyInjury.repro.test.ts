import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  evaluateQualitativePillars,
  formatUnifiedPerGameDossier,
  type UnifiedGameDossierEntry
} from '../swarm/engine/unifiedDossier.ts';
import { auditCriticPremiseContradictions } from '../swarm/tools/claimGrounding.ts';
import {
  detectOpposingSeatConflicts,
  extractAnalystConsensus,
  renderPromptConsensusBlock
} from '../swarm/engine/consensusPipeline.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { selectDecoupledVerifierAgent } from '../swarm/engine/verificationPipeline.ts';
import { QUANT_NVIDIA_TIMEOUT_MS } from '../swarm/providers/nvidia.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { dueloddsRpcTools } from '../swarm/tools/dueloddsRpcTools.ts';
import type { GameHeader } from '../swarm/context/gameHeaders.ts';

const OKC_MIN_HEADER: GameHeader = {
  eventId: 'nba-401909320',
  sport: 'nba',
  away: 'Minnesota Timberwolves',
  home: 'Oklahoma City Thunder',
  options: [
    { id: 'R20', text: 'SPREAD Oklahoma City Thunder -1.5 (-110)' },
    { id: 'R21', text: 'SPREAD Minnesota Timberwolves +1.5 (-110)' },
    { id: 'R103', text: 'ML Oklahoma City Thunder (-132)' },
    { id: 'R104', text: 'ML Minnesota Timberwolves (+112)' }
  ]
};

const OKC_MIN_SLATE =
  'event_id=nba-401909320 | sport=nba | Minnesota Timberwolves @ Oklahoma City Thunder | options: R20 SPREAD Oklahoma City Thunder -1.5 (-110), R21 SPREAD Minnesota Timberwolves +1.5 (-110), R103 ML Oklahoma City Thunder (-132), R104 ML Minnesota Timberwolves (+112)';

const OKC_MIN_SHARP_CONTRA_STEAM =
  'EVENT nba-401909320\n[MARKET MOVEMENT: nba-401909320]\nSteam: TOWARD home Oklahoma City Thunder ML (-118 -> -132, +3.3pp implied) | AGAINST away Minnesota Timberwolves ML (-102 -> +112, +3.3pp implied)';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wf-1795638625511 S1 — Contra-Steam & Split-Seat Guard', () => {
  it('S1.1: penalizes sharp AGAINST contra-steam side in TOP PILLAR CANDIDATES when model_signal is absent', () => {
    const entry: UnifiedGameDossierEntry = {
      eventId: 'nba-401909320',
      matchup: 'Minnesota Timberwolves @ Oklahoma City Thunder',
      sport: 'nba',
      market: OKC_MIN_SHARP_CONTRA_STEAM,
      injuries:
        'Summary: Oklahoma City Thunder (3 OUT, 0 Q) vs Minnesota Timberwolves (0 OUT, 0 Q) | Health Balance: away_advantage (Minnesota Timberwolves)',
      fundamentals:
        'Home OKC (2-3) | 110.0 PF/G, 112.4 PA/G | Net Margin: -2.4 | L5: 2-3\nAway MIN (4-1) | 118.4 PF/G, 108.2 PA/G | Net Margin: +10.2 | L5: 4-1',
      hasDirectionalSteam: true,
      outCountDiff: 3,
      netMarginGap: 12.6
    };

    const evalRes = evaluateQualitativePillars(entry);
    expect(evalRes.contraSteamRiskSide).toBe('away');
    expect(evalRes.contraSteamTag).toContain('contra_steam_risk');
    expect(evalRes.contraSteamTag).toContain('AGAINST away');
    // Away had form + health (2 pillars) minus 1 contra-steam penalty = 1 pillar
    expect(evalRes.awayPillarCount).toBe(1);

    const formatted = formatUnifiedPerGameDossier([entry]);
    const topBlockMatch = formatted.text.match(/=== TOP PILLAR CANDIDATES[\s\S]*?(?=\n\n=== GAME DOSSIER:)/);
    const topBlock = topBlockMatch ? topBlockMatch[0] : '';
    // Minnesota Timberwolves must NOT be ranked as a clean 2-pillar side in TOP PILLAR CANDIDATES
    expect(topBlock).not.toMatch(/Minnesota Timberwolves\s*\(2 pillars/i);
    expect(topBlock).not.toMatch(/MIN\s*\(2 pillars/i);
  });

  it('S1.1: allows contra-steam side to retain pillars when model_signal explicitly favors that side', () => {
    const entry: UnifiedGameDossierEntry = {
      eventId: 'nba-401909320',
      matchup: 'Minnesota Timberwolves @ Oklahoma City Thunder',
      sport: 'nba',
      modelSignal: 'lean_away',
      market: OKC_MIN_SHARP_CONTRA_STEAM,
      injuries:
        'Summary: Oklahoma City Thunder (3 OUT, 0 Q) vs Minnesota Timberwolves (0 OUT, 0 Q) | Health Balance: away_advantage (Minnesota Timberwolves)',
      fundamentals:
        'Home OKC (2-3) | 110.0 PF/G, 112.4 PA/G | Net Margin: -2.4 | L5: 2-3\nAway MIN (4-1) | 118.4 PF/G, 108.2 PA/G | Net Margin: +10.2 | L5: 4-1',
      hasDirectionalSteam: true,
      outCountDiff: 3,
      netMarginGap: 12.6
    };

    const evalRes = evaluateQualitativePillars(entry);
    expect(evalRes.contraSteamRiskSide ?? null).toBeNull();
    expect(evalRes.awayPillarCount).toBeGreaterThanOrEqual(2);
  });

  it('S1.2: deterministically flags sharp_contra_steam on R104 in optimal mode even when proposer omits steam', () => {
    const a2Proposal = {
      picks: [
        {
          row: 'R104',
          eventId: 'nba-401909320',
          side: 'ML Minnesota Timberwolves (+112)',
          reason: 'Timberwolves enter healthier with strong L5 road form.'
        }
      ]
    };

    const optimalAudit = auditCriticPremiseContradictions(
      a2Proposal,
      OKC_MIN_SHARP_CONTRA_STEAM,
      OKC_MIN_SLATE,
      { headers: [OKC_MIN_HEADER], riskProfile: 'optimal' }
    );
    expect(optimalAudit.pass).toBe(false);
    expect(optimalAudit.flags).toContain('sharp_contra_steam');
    expect(optimalAudit.vetoedLegs?.some(v => v.rowId === 'R104')).toBe(true);

    // Also fires with allowParlay: true and empty reason
    const reasonlessAudit = auditCriticPremiseContradictions(
      { picks: [{ row: 'R104', eventId: 'nba-401909320', side: 'ML Minnesota Timberwolves' }] },
      OKC_MIN_SHARP_CONTRA_STEAM,
      OKC_MIN_SLATE,
      { headers: [OKC_MIN_HEADER], allowParlay: true }
    );
    expect(reasonlessAudit.pass).toBe(false);
    expect(reasonlessAudit.flags).toContain('sharp_contra_steam');

    // Does NOT fire when model_signal explicitly favors away (lean_away)
    const favoredHeader: GameHeader = { ...OKC_MIN_HEADER, modelSignal: 'lean_away' };
    const favoredAudit = auditCriticPremiseContradictions(
      a2Proposal,
      OKC_MIN_SHARP_CONTRA_STEAM,
      `${OKC_MIN_SLATE} | model_signal=lean_away`,
      { headers: [favoredHeader], riskProfile: 'optimal' }
    );
    expect(favoredAudit.flags).not.toContain('sharp_contra_steam');
  });

  it('S1.2: flags sharp_contra_steam for >= 1.0pt spread move against picked side in optimal mode', () => {
    const spreadSteam =
      'EVENT nba-401909320\n[MARKET MOVEMENT: nba-401909320]\nSteam: TOWARD home Oklahoma City Thunder (-1.5 -> -2.5) | AGAINST away Minnesota Timberwolves (+1.5 -> +2.5)';
    const proposal = {
      picks: [
        {
          row: 'R21',
          eventId: 'nba-401909320',
          side: 'Minnesota Timberwolves +1.5',
          reason: 'Taking the points with Minnesota.'
        }
      ]
    };

    const audit = auditCriticPremiseContradictions(
      proposal,
      spreadSteam,
      OKC_MIN_SLATE,
      { headers: [OKC_MIN_HEADER], riskProfile: 'optimal' }
    );
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('sharp_contra_steam');
  });

  it('S1.3: tags split-seat opposing picks as seat_conflict and never places them under Majority Consensus', () => {
    const a1 = new Agent('Quant Proposer', 'nvidia/nemotron-3-ultra-550b', 'nvidia', 'nvapi-test');
    const a2 = new Agent('Market Proposer', 'llama-3.3-70b-versatile', 'groq', 'groq-test');
    const manager = new Agent('Manager', 'gemini-3.5-flash-lite', 'gemini', 'gemini-test');

    const allReports = [
      [
        {
          summary: 'Recommend R20 Oklahoma City Thunder -1.5 in nba-401909320.',
          insights: ['nba-401909320 Minnesota Timberwolves @ Oklahoma City Thunder is a key matchup for the card.'],
          picks: [{ row: 'R20', eventId: 'nba-401909320', side: 'Oklahoma City Thunder -1.5' }]
        }
      ],
      [
        {
          summary: 'Recommend R104 Minnesota Timberwolves ML in nba-401909320.',
          insights: ['nba-401909320 Minnesota Timberwolves @ Oklahoma City Thunder is a key matchup for the card.'],
          picks: [{ row: 'R104', eventId: 'nba-401909320', side: 'ML Minnesota Timberwolves (+112)' }]
        }
      ]
    ];

    const conflicts = detectOpposingSeatConflicts(allReports, [a1, a2], [OKC_MIN_HEADER]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].eventId).toBe('nba-401909320');
    expect(conflicts[0].tag).toBe('seat_conflict');
    expect(conflicts[0].seats.map(s => s.sideRole).sort()).toEqual(['away', 'home']);

    const digest = extractAnalystConsensus(allReports, [a1, a2], OKC_MIN_SLATE, [OKC_MIN_HEADER]);
    expect(digest.isContested).toBe(true);
    expect(digest.seatConflicts?.length).toBe(1);
    expect(digest.majorityFindings.join(' ')).not.toContain('nba-401909320');
    expect(digest.unanimousFindings.join(' ')).not.toContain('nba-401909320');

    const consensusBlock = renderPromptConsensusBlock(digest);
    expect(consensusBlock).toContain('seat_conflict');
    expect(consensusBlock).toContain('nba-401909320');
    expect(consensusBlock).not.toContain('• Majority Consensus');
    expect(consensusBlock).not.toContain('• Unanimous Consensus');

    const ctx = new SwarmContext();
    const synthesis = compileSynthesisPrompt({
      task: 'Build an optimal 2-leg NBA parlay.',
      rawInput: OKC_MIN_SLATE,
      analysts: [a1, a2],
      managerAgent: manager,
      allAnalystReports: allReports,
      clusterDigests: {},
      historicalContext: '',
      workflowConsensus: {
        ...digest,
        // Even if caller supplied stale majority finding for the split game, synthesis must scrub it
        majorityFindings: ['nba-401909320 Minnesota Timberwolves @ Oklahoma City Thunder'],
        seatConflicts: undefined
      },
      context: ctx,
      params: { isBettingRun: true } as any,
      bypassCache: true
    });
    expect(synthesis.effectiveDynamicPrompt).toContain('seat_conflict');
    expect(synthesis.effectiveDynamicPrompt).toContain('nba-401909320');
    expect(synthesis.effectiveDynamicPrompt).not.toContain('• Majority Consensus');
  });
});

describe('wf-1795638625511 S2 — 15s a1 NVIDIA Timeout & Verifier Routing', () => {
  it('S2.1: caps a1 NVIDIA timeout at 15,000ms and fails over immediately to gemini-3.5-flash-lite', async () => {
    expect(QUANT_NVIDIA_TIMEOUT_MS).toBe(15000);

    const prevNvidia = ProviderRegistry.get('nvidia');
    const prevGemini = ProviderRegistry.get('gemini');
    let capturedTimeoutMs: number | undefined;
    let geminiModelCalled: string | undefined;

    try {
      ProviderRegistry.register({
        providerName: 'nvidia',
        async call(opts: any) {
          capturedTimeoutMs = opts.timeoutMs;
          throw new Error('NVIDIA API timed out after 15000ms (single attempt)');
        }
      } as any);
      ProviderRegistry.register({
        providerName: 'gemini',
        async call(opts: any) {
          geminiModelCalled = opts.modelName;
          return JSON.stringify({ summary: 'Recovered on gemini-3.5-flash-lite', picks: [] });
        }
      } as any);

      const a1 = new Agent(
        'Quant Proposer',
        'nvidia/nemotron-3-ultra-550b',
        'nvidia',
        'nvapi-test',
        undefined,
        [{ provider: 'gemini', modelName: 'gemini-3.5-flash-lite', apiKey: 'gemini-test' }]
      );
      a1.preserveFallbackOrder = true;

      const ctx = new SwarmContext();
      const output = await a1.run('Evaluate NBA slate', ctx, {
        responseMimeType: 'application/json',
        timeoutMs: 28000,
        bypassCache: true
      });

      expect(capturedTimeoutMs).toBe(15000);
      expect(geminiModelCalled).toBe('gemini-3.5-flash-lite');
      expect(output.summary).toContain('gemini-3.5-flash-lite');
    } finally {
      if (prevNvidia) ProviderRegistry.register(prevNvidia);
      if (prevGemini) ProviderRegistry.register(prevGemini);
    }
  });

  it('S2.2: routes Verifier to gemini-3.5-flash-lite -> cloudflare -> groq and never calls gemini-3.1-flash-lite first', () => {
    const baseCritic = new Agent(
      'Risk Critic',
      'gemini-3.1-flash-lite',
      'gemini',
      'test-gemini',
      undefined,
      [
        { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'test-cf' },
        { provider: 'groq', modelName: 'openai/gpt-oss-20b', apiKey: 'test-groq' }
      ]
    );
    const manager = new Agent('Manager', 'gemini-3.5-flash-lite', 'gemini', 'test-gemini');
    const ctxHealthy = new SwarmContext();

    const testSettings = {
      geminiApiKey: 'test-gemini',
      cloudflareApiToken: 'test-cf',
      cloudflareAccountId: 'test-acct',
      groqApiKey: 'test-groq'
    } as any;

    const verifier = selectDecoupledVerifierAgent({
      baseCriticAgent: baseCritic,
      managerAgent: manager,
      analysts: [baseCritic],
      context: ctxHealthy,
      settings: testSettings
    });

    expect(verifier.provider).toBe('gemini');
    expect(verifier.modelName).toBe('gemini-3.5-flash-lite');
    const chain = [
      `${verifier.provider}/${verifier.modelName}`,
      ...verifier.getFallbacks().map(f => `${f.provider}/${f.modelName}`)
    ];
    const idx35 = chain.indexOf('gemini/gemini-3.5-flash-lite');
    const idxCf = chain.findIndex(x => x.startsWith('cloudflare/'));
    const idx31 = chain.findIndex(x => x.includes('gemini-3.1-flash-lite'));
    expect(idx35).toBe(0);
    expect(idxCf).toBe(1);
    if (idx31 !== -1) {
      expect(idx31).toBeGreaterThan(idxCf);
    }

    // When Manager already saw a Gemini 503, skip gemini-3.5-flash-lite first-try and route straight to Cloudflare
    const ctxGemini503 = new SwarmContext();
    ctxGemini503.addEvent({
      agentRole: 'Manager',
      action: 'Provider Failover Triggered',
      modelName: 'gemini-3.5-flash-lite',
      prompt: 'synthesis',
      error: 'Gemini 503 Service Unavailable — high demand',
      output: null,
      durationMs: 1200
    });
    const verifierAfter503 = selectDecoupledVerifierAgent({
      baseCriticAgent: baseCritic,
      managerAgent: manager,
      analysts: [baseCritic],
      context: ctxGemini503,
      settings: testSettings
    });
    expect(verifierAfter503.provider).toBe('cloudflare');
    expect(verifierAfter503.modelName).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(verifierAfter503.getFallbacks().some(f => String(f.modelName || '').includes('gemini-3.1-flash-lite'))).toBe(false);
  });
});

describe('wf-1795638625511 S3 — Per-Player Tier Weighting With Neutral 1.0 Unlogged Floor', () => {
  const injuryTool = dueloddsRpcTools.find(t => t.name === 'get_injury_and_roster_delta')!;
  const testEnv = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key'
  };

  it('activates weighted summary with 1 boxscore date + 1 logged Tier-1 star and scores unlogged OUT at neutral 1.0', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('player_game_logs')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              player_id: '4065648',
              player_name: 'Jayson Tatum',
              sport: 'basketball_nba',
              team_abbr: 'BOS',
              game_date: '2026-11-24',
              source: 'espn_boxscore',
              stats: { position: 'SF', minutes: 36, points: 29, is_starter: true }
            }
          ]
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          event_id: 'nba-999001',
          sport: 'basketball_nba',
          home_team: 'Boston Celtics',
          away_team: 'Miami Heat',
          injuries: [
            { player_id: '4065648', player_name: 'Jayson Tatum', team: 'Boston Celtics', position: 'SF', status: 'OUT' },
            { player_id: '9001', player_name: 'Unlogged Bench One', team: 'Boston Celtics', position: 'SG', status: 'OUT' },
            { player_id: '9002', player_name: 'Unlogged Bench Two', team: 'Boston Celtics', position: 'PF', status: 'OUT' },
            { player_id: '9101', player_name: 'Heat Unlogged One', team: 'Miami Heat', position: 'PG', status: 'OUT' },
            { player_id: '9102', player_name: 'Heat Unlogged Two', team: 'Miami Heat', position: 'C', status: 'OUT' },
            { player_id: '9103', player_name: 'Heat Unlogged Three', team: 'Miami Heat', position: 'SF', status: 'OUT' }
          ]
        })
      };
    });

    const res = await injuryTool.execute(
      { game_id: 'nba-999001' },
      { env: testEnv, fetchFn: mockFetch as any }
    );

    expect(res.success).toBe(true);
    expect(res.summary).not.toContain('[unweighted_fallback]');
    // Team A: 3.0 (Tatum Tier-1) + 1.0 + 1.0 (2 unlogged) = 5.0
    expect(res.summary).toContain('[impact 5.0: 1 Tier-1, 2 unlogged]');
    // Team B: 1.0 + 1.0 + 1.0 (3 unlogged) = 3.0
    expect(res.summary).toContain('[impact 3.0: 3 unlogged]');
    // Never downgrade unlogged players to 0.5 depth on < 5-date teams
    expect(res.summary).not.toContain('depth');

    const data: any = res.data;
    expect(data.injury_counts.home_out_impact).toBe(5.0);
    expect(data.injury_counts.away_out_impact).toBe(3.0);
    const unloggedItems = (data.injuries || []).filter((i: any) => i.player_name !== 'Jayson Tatum');
    expect(unloggedItems.every((i: any) => i.impact_weight === 1.0 && i.impact_role === 'unlogged')).toBe(true);
  });

  it('still falls back cleanly to [unweighted_fallback] when 0 injured players have logged rows', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('player_game_logs')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              player_id: '8888',
              player_name: 'Healthy Starter',
              sport: 'basketball_nba',
              team_abbr: 'BOS',
              game_date: '2026-11-24',
              source: 'espn_boxscore',
              stats: { position: 'SG', minutes: 34, points: 22, is_starter: true }
            }
          ]
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          event_id: 'nba-999002',
          sport: 'basketball_nba',
          home_team: 'Boston Celtics',
          away_team: 'Miami Heat',
          injuries: [
            { player_id: '9201', player_name: 'Unlogged A1', team: 'Boston Celtics', status: 'OUT' },
            { player_id: '9202', player_name: 'Unlogged A2', team: 'Boston Celtics', status: 'OUT' },
            { player_id: '9301', player_name: 'Unlogged B1', team: 'Miami Heat', status: 'OUT' },
            { player_id: '9302', player_name: 'Unlogged B2', team: 'Miami Heat', status: 'OUT' }
          ]
        })
      };
    });

    const res = await injuryTool.execute(
      { game_id: 'nba-999002' },
      { env: testEnv, fetchFn: mockFetch as any }
    );

    expect(res.success).toBe(true);
    expect(res.summary).toContain('[unweighted_fallback]');
    expect(res.summary).not.toContain('[impact ');
  });
});
