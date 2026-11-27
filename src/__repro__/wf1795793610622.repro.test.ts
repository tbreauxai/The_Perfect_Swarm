import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
} from '../swarm/engine/constants.ts';
import { createAnalystExecutor } from '../swarm/engine/analystExecution.ts';
import { resolveMemoryGrounding, buildEnrichedCortexQuery } from '../swarm/engine/memoryGrounding.ts';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { isFalseMissingMarketCritique } from '../swarm/tools/marketRowBinding.ts';
import {
  detectUncitedBlanketCriticVeto,
  reconcileFinalVerdictAndPicks,
} from '../swarm/tools/criticAudit.ts';
import { assemblePrompt, seatBudget } from '../swarm/context/promptBudget.ts';
import { getRoleToolNames } from '../swarm/engine/seatToolLoop.ts';
import { MemoryCortex } from '../swarm/memory/cortex.ts';
import { DeterministicLocalEmbeddingProvider } from '../swarm/memory/embeddings.ts';
import { matchesScopedMemoryFilter } from '../swarm/memory/storage/types.ts';
import { normalizeDomain, normalizeMemoryPayload } from '../swarm/memory/tags.ts';

const TEST_SLATE = [
  'event_id=americanfootball_ncaaf-1001 | sport=americanfootball_ncaaf | Texas Longhorns @ Georgia Bulldogs | commence=2026-11-28T20:30:00Z | options: R1 away Texas Longhorns +3.5 (-110), R2 home Georgia Bulldogs -3.5 (-110)',
  'event_id=icehockey_nhl-2002 | sport=icehockey_nhl | Carolina Hurricanes @ Florida Panthers | commence=2026-11-28T23:00:00Z | options: R3 away Carolina Hurricanes ML (-115), R4 home Florida Panthers ML (-105)',
].join('\n');

describe('wf-1795793610622 — Fix 1: Prevent Blanket / Uncited Risk Critic Vetoes', () => {
  it('1a. Critic prompts explicitly treat Steam: neutral (0 pts) & Divergence: single_book as valid and require cited R# row + tool field per vetoed leg while staying under Groq cap', () => {
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('Steam: neutral (0 pts)');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('Divergence: single_book');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toMatch(/cite specific row ID\(s\).*tool field/i);
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toMatch(/approve clean legs/i);

    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION.length).toBeLessThanOrEqual(1200);
    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('Steam: neutral (0 pts)');
    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('Divergence: single_book');
    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION).toMatch(/0 cited legs is invalid/i);
    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('contra_steam_misread');
    expect(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('symmetric_injury_misread');

    const reg = new ToolRegistry([
      { name: 'get_matchup_fundamentals', description: 'f', parameters: {}, execute: async () => ({}) },
      { name: 'get_injury_and_roster_delta', description: 'i', parameters: {}, execute: async () => ({}) },
      { name: 'get_market_movement', description: 'm', parameters: {}, execute: async () => ({}) },
    ]);
    const toolNames = getRoleToolNames('critic').filter((n) => reg.has(n));
    const toolSchemas = JSON.stringify(reg.scoped(toolNames).toOpenAiTools());
    const assembled = assemblePrompt({
      systemInstruction: CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      toolSchemas,
      prompt: 'Task:\nAudit picks\n\nGame Slate:\nR1 Team A -3.5 (-110)',
    });
    expect(assembled.length).toBeLessThan(seatBudget('groq').maxPromptChars);
  });

  it('1b. isFalseMissingMarketCritique catches false missing-market-data vetoes for Steam: neutral (0 pts) and Divergence: single_book on spread/ML/total', () => {
    const toolEvidence = [
      '[MARKET MOVEMENT: americanfootball_ncaaf-1001 | spread] Current: away Texas +3.5 (-110) / home Georgia -3.5 (-110) | Steam: neutral (0 pts) | Divergence: single_book',
      '[MARKET MOVEMENT: icehockey_nhl-2002 | ml] Current: away Carolina -115 / home Florida -105 | Steam: neutral (0 pts) | Divergence: single_book',
    ].join('\n');

    const proposal = {
      picks: [
        { row: 'R1', event_id: 'americanfootball_ncaaf-1001', pick: 'Texas Longhorns +3.5' },
        { row: 'R3', event_id: 'icehockey_nhl-2002', pick: 'Carolina Hurricanes ML' },
      ],
    };

    expect(
      isFalseMissingMarketCritique(
        'Veto: Missing market data for R1 spread because Steam is neutral (0 pts) and single_book divergence gives no confirmation.',
        proposal,
        toolEvidence,
        TEST_SLATE,
      ),
    ).toBe(true);

    expect(
      isFalseMissingMarketCritique(
        'Veto: Unable to verify moneyline movement due to single_book coverage on R3.',
        proposal,
        toolEvidence,
        TEST_SLATE,
      ),
    ).toBe(true);
  });

  it('1c. detectUncitedBlanketCriticVeto flags "No fatal..." contradiction and uncited 0-leg vetoes while allowing cited R# vetoes', () => {
    const noFatalVeto = detectUncitedBlanketCriticVeto({
      report: {
        pass: false,
        criticApproved: false,
        verdict: 'veto',
        summary: 'No fatal injuries or hard violations found across the slate.',
        flags: [],
      },
      vetoedLegs: [],
      vetoedClaims: [],
      hasDeterministicFailures: false,
    });
    expect(noFatalVeto).toEqual({
      isUncitedBlanketVeto: true,
      reason: 'contradictory_no_fatal_with_zero_vetoed_legs',
    });

    const blanketVeto = detectUncitedBlanketCriticVeto({
      report: {
        pass: false,
        criticApproved: false,
        verdict: 'veto',
        summary: 'Blanket slate veto: caution warranted across matchups.',
        flags: ['general_risk'],
      },
      vetoedLegs: [],
      vetoedClaims: [],
      hasDeterministicFailures: false,
    });
    expect(blanketVeto).toEqual({
      isUncitedBlanketVeto: true,
      reason: 'uncited_blanket_veto_zero_legs',
    });

    const citedLegVeto = detectUncitedBlanketCriticVeto({
      report: {
        pass: false,
        criticApproved: false,
        verdict: 'veto',
        summary: 'Veto R1 Texas Longhorns +3.5: Steam: AGAINST away Texas (+5.5 -> +3.5 contradiction).',
        flags: ['contra_steam_misread'],
      },
      vetoedLegs: [{ rowId: 'R1', eventId: 'americanfootball_ncaaf-1001', teamAliases: ['texas longhorns', 'texas'], reason: 'contra_steam_misread' }],
      vetoedClaims: [],
      hasDeterministicFailures: true,
    });
    expect(citedLegVeto.isUncitedBlanketVeto).toBe(false);
  });

  it('1d. Stage 2 Risk Critic post-processor ignores uncited blanket / "No fatal..." veto with warning and preserves grounded proposer picks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const critic = new Agent('Risk Critic', 'simulated-v1', 'simulated', 'mock-key');
      vi.spyOn(critic, 'run').mockResolvedValue(
        JSON.stringify({
          criticApproved: false,
          wageringPass: true,
          pass: false,
          verdict: 'veto',
          summary: 'No fatal issues, but issuing a blanket slate veto pending stronger steam.',
          flags: [],
          scorecards: [{ verdict: 'veto', notes: 'No fatal violations; general caution.' }],
        }),
      );

      const toolReg = new ToolRegistry([
        {
          name: 'get_matchup_fundamentals',
          description: 'fundamentals',
          parameters: { game_id: { type: 'string', description: 'id', required: true } },
          execute: async ({ game_id }: any) => ({
            success: true,
            summary: `[FUNDAMENTALS: ${game_id}] Away Net Rtg +6.4 vs Home +2.1`,
          }),
        },
        {
          name: 'get_injury_and_roster_delta',
          description: 'injuries',
          parameters: { game_id: { type: 'string', description: 'id', required: true } },
          execute: async ({ game_id }: any) => ({
            success: true,
            summary: `[INJURY & ROSTER DELTA: ${game_id}]\nSummary: Home (2 OUT, 0 Q) vs Away (0 OUT, 0 Q) | Health Balance: away_advantage`,
          }),
        },
        {
          name: 'get_market_movement',
          description: 'market',
          parameters: { game_id: { type: 'string', description: 'id', required: true } },
          execute: async ({ game_id }: any) => ({
            success: true,
            summary:
              game_id === 'americanfootball_ncaaf-1001'
                ? '[MARKET MOVEMENT: americanfootball_ncaaf-1001 | spread] Current: away Texas Longhorns +3.5 (-110) / home Georgia Bulldogs -3.5 (-110) | Steam: neutral (0 pts) | Divergence: single_book'
                : '[MARKET MOVEMENT: icehockey_nhl-2002 | ml] Current: away Carolina Hurricanes -115 / home Florida Panthers -105 | Steam: neutral (0 pts) | Divergence: single_book',
            markets_covered: game_id === 'americanfootball_ncaaf-1001' ? ['spread'] : ['ml'],
          }),
        },
      ]);

      const proposedPicks = [
        {
          row: 'R1',
          event_id: 'americanfootball_ncaaf-1001',
          pick: 'Texas Longhorns +3.5',
          side: 'away Texas Longhorns +3.5',
          reason: 'Positive Net Rtg edge with asymmetric home OUTs.',
        },
        {
          row: 'R3',
          event_id: 'icehockey_nhl-2002',
          pick: 'Carolina Hurricanes ML',
          side: 'away Carolina Hurricanes ML (-115)',
          reason: 'Superior form differential and cleaner goalie injury delta.',
        },
      ];

      const exec = createAnalystExecutor({
        task: "what's the best 2 leg parlay today?",
        chunks: [TEST_SLATE],
        profile: { name: 'test-profile' },
        historicalContext: '',
        targetAppId: 'duelodds',
        context: new SwarmContext(),
        toolRegistry: toolReg,
        analystClusterMap: new Map(),
        bypassCache: true,
        eventIds: ['americanfootball_ncaaf-1001', 'icehockey_nhl-2002'],
      });

      const report: any = await exec(critic, TEST_SLATE, 0, {
        summaryText: 'Proposers picked R1 Texas Longhorns +3.5 and R3 Carolina Hurricanes ML.',
        targetGameIds: ['americanfootball_ncaaf-1001', 'icehockey_nhl-2002'],
        proposedPicks,
        proposerReports: [
          {
            seat: 'a1',
            role: 'Quant Proposer',
            picks: proposedPicks,
            summary: 'Backed R1 Texas Longhorns +3.5 and R3 Carolina Hurricanes ML.',
          },
        ],
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring uncited blanket veto'));
      expect(report.pass).toBe(true);
      expect(report.criticApproved).toBe(true);
      expect(report.verdict).toBe('approve');

      const finalAnalysis: any = {
        ui_title: '2-Leg Parlay',
        summary: 'Backing R1 Texas Longhorns +3.5 and R3 Carolina Hurricanes ML.',
        picks: [...proposedPicks],
        wageringPass: false,
      };
      reconcileFinalVerdictAndPicks(finalAnalysis, {
        criticPass1Approved: report.criticApproved,
        criticVerdictApproved: report.criticApproved,
        deterministicVetoes: [],
        hadDeterministicVetoes: false,
        verificationSuccess: true,
        verificationApproved: true,
        initialPicks: proposedPicks,
      });

      expect(finalAnalysis.picks).toHaveLength(2);
      expect(finalAnalysis.criticApproved).toBe(true);
      expect(finalAnalysis.wageringPass).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('wf-1795793610622 — Fix 2: HybridCortex Query Enrichment & Qdrant Payload Filter Schema', () => {
  it('2a. buildEnrichedCortexQuery enriches generic parlay prompts with active sports/domains and market keywords', () => {
    const enriched = buildEnrichedCortexQuery("what's the best 3 leg parlay to place today?", {
      domains: ['americanfootball_ncaaf', 'icehockey_nhl', 'multi'],
      allowParlay: true,
    });
    expect(enriched).toContain('ncaaf');
    expect(enriched).toContain('nhl');
    expect(enriched).toContain('parlay');
    expect(enriched).toContain('spread');
    expect(enriched).toContain('moneyline');
    expect(enriched).toContain('total');

    const alreadySpecific = buildEnrichedCortexQuery('best ncaaf spread and nhl moneyline parlay', {
      domains: ['ncaaf', 'nhl'],
      allowParlay: true,
    });
    expect(alreadySpecific).toBe('best ncaaf spread and nhl moneyline parlay');
  });

  it('2b. normalizeDomain & matchesScopedMemoryFilter accept Odds-API sports, app_id, and reusable backfilled lessons when eventIds are present', () => {
    expect(normalizeDomain('americanfootball_ncaaf')).toBe('ncaaf');
    expect(normalizeDomain('icehockey_nhl')).toBe('nhl');

    const backfillPayload = {
      app_id: 'duelodds',
      sport: 'americanfootball_ncaaf',
      memory_type: 'graded_lesson',
      visibility: 'public',
      category: 'betting_lesson',
      closingLineValue: 1.5,
      eventId: 'past-ncaaf-0001',
      rule: 'In NCAAF road conference games, avoid laying over -6.5 against neutral steam.',
      timestamp: '2026-11-10T12:00:00Z',
    };

    const tags = normalizeMemoryPayload(backfillPayload, 'duelodds');
    expect(tags.originApp).toBe('duelodds');
    expect(tags.domain).toBe('ncaaf');
    expect(tags.memoryType).toBe('graded_lesson');

    // Today's slate eventIds must NOT filter out historical reusable lessons
    expect(
      matchesScopedMemoryFilter(backfillPayload, {
        appId: 'duelodds',
        eventIds: ['americanfootball_ncaaf-1001', 'icehockey_nhl-2002'],
        includeShared: false,
        publicOnly: true,
      }),
    ).toBe(true);

    // Event-locked snapshots from another game ARE still excluded
    expect(
      matchesScopedMemoryFilter(
        {
          app_id: 'duelodds',
          sport: 'ncaaf',
          memoryType: 'game_snapshot',
          snapshotHash: 'abc123',
          eventId: 'past-ncaaf-0001',
        },
        {
          appId: 'duelodds',
          eventIds: ['americanfootball_ncaaf-1001'],
          includeShared: false,
        },
      ),
    ).toBe(false);
  });

  it('2c. HybridCortex + resolveMemoryGrounding returns recordsFound > 0 on pwa_swarm_dev_cortex_v4 for generic parlay prompts with backfilled Qdrant points', async () => {
    const queryCalls: Array<{ collection: string; args: any }> = [];
    const backfilledPoints = [
      {
        id: '11111111-1111-4111-a111-111111111111',
        score: 0.032,
        payload: {
          app_id: 'duelodds',
          sport: 'americanfootball_ncaaf',
          sportKey: 'americanfootball_ncaaf',
          memory_type: 'graded_lesson',
          type: 'graded_lesson',
          visibility: 'public',
          category: 'betting_lesson',
          outcome: 'win',
          clv: 2.1,
          qualityRating: 0.92,
          verified: true,
          rule: 'NCAAF spread parlay legs with asymmetric OL injury edges and neutral/favorable steam outperform.',
          content: 'NCAAF spread parlay lesson: prioritize asymmetric OL health over late steam.',
          timestamp: '2026-11-15T18:00:00Z',
        },
      },
      {
        id: '22222222-2222-4222-a222-222222222222',
        score: 0.028,
        payload: {
          appId: 'duelodds',
          originApp: 'duelodds',
          domain: 'nhl',
          sportKey: 'icehockey_nhl',
          memoryType: 'graded_lesson',
          visibility: 'public',
          outcome: 'win',
          qualityRating: 0.88,
          verified: true,
          eventId: 'icehockey_nhl-prior-99',
          rule: 'NHL moneyline legs inside -160 to +130 outperform +200 pucklines in 3-leg parlays.',
          content: 'NHL moneyline parlay calibration lesson.',
          timestamp: '2026-11-16T19:00:00Z',
        },
      },
    ];

    const mockQdrantClient = {
      getCollections: vi.fn(async () => ({ collections: [{ name: 'pwa_swarm_dev_cortex_v4' }] })),
      getCollection: vi.fn(async () => ({
        points_count: 142,
        payload_schema: {
          originApp: { data_type: 'keyword' },
          appId: { data_type: 'keyword' },
          app_id: { data_type: 'keyword' },
          domain: { data_type: 'keyword' },
          sport: { data_type: 'keyword' },
          sportKey: { data_type: 'keyword' },
          sport_key: { data_type: 'keyword' },
        },
      })),
      createPayloadIndex: vi.fn(async () => ({})),
      query: vi.fn(async (collection: string, args: any) => {
        queryCalls.push({ collection, args });
        const filterMust: any[] = args?.prefetch?.[0]?.filter?.must || args?.filter?.must || [];
        // Assert Qdrant filter includes app_id and Odds-API sport aliases across domain/sport/sportKey/sport_key
        const hasAppIdMatch = filterMust.some(
          (clause) =>
            Array.isArray(clause?.should) &&
            clause.should.some((s: any) => s.key === 'app_id' && s.match?.value === 'duelodds'),
        );
        const hasNcaafAlias = filterMust.some(
          (clause) =>
            Array.isArray(clause?.should) &&
            clause.should.some((s: any) => s.key === 'sport' && s.match?.value === 'americanfootball_ncaaf'),
        );
        if (!hasAppIdMatch || !hasNcaafAlias) {
          return { points: [] };
        }
        return { points: backfilledPoints };
      }),
    };

    const cortex = new MemoryCortex({
      collectionName: 'pwa_swarm_dev_cortex_v4',
      defaultAppId: 'duelodds',
      isolatedStore: true,
      embeddingProvider: new DeterministicLocalEmbeddingProvider(),
    });
    cortex.qdrant = mockQdrantClient as any;

    const ctx = new SwarmContext();
    const res = await resolveMemoryGrounding({
      memoryCortex: cortex,
      task: "what's the best 3 leg parlay to place today?",
      data: TEST_SLATE,
      targetAppId: 'duelodds',
      includeShared: true,
      bypassCache: true,
      qdrantUrl: 'https://mock-qdrant.local:6333',
      toolRegistry: new ToolRegistry([]),
      context: ctx,
      allowParlay: true,
      eventIds: ['americanfootball_ncaaf-1001', 'icehockey_nhl-2002'],
    });

    const completeEvt = ctx.events.find((e) => e.action === 'Cortex Retrieval Complete');
    const summary = completeEvt?.output?.cortexSummary;
    expect(queryCalls.length).toBeGreaterThan(0);
    expect(queryCalls[0].collection).toBe('pwa_swarm_dev_cortex_v4');
    expect(summary.status).toBe('Success');
    expect(summary.recordsFound).toBeGreaterThan(0);
    expect(summary.appliedDomains).toEqual(['ncaaf', 'nhl', 'multi']);
    expect(summary.searchQuery).toContain('ncaaf');
    expect(summary.searchQuery).toContain('nhl');
    expect(summary.searchQuery).toContain('parlay');
    expect(res.historicalContext).toContain('NCAAF spread parlay legs');
  });

  it('2d. MemoryCortex.retrieve searches InMemoryStorage when Qdrant is unconfigured', async () => {
    const localCortex = new MemoryCortex({
      collectionName: 'pwa_swarm_dev_cortex_v4',
      defaultAppId: 'duelodds',
      isolatedStore: true,
      embeddingProvider: new DeterministicLocalEmbeddingProvider(),
    });
    await localCortex.store(
      'NHL moneyline parlay lesson: back home favorites inside -150 with positive CLV.',
      {
        originApp: 'duelodds',
        domain: 'nhl',
        memoryType: 'graded_lesson',
        outcome: 'win',
        qualityRating: 0.9,
      },
    );

    const hits = await localCortex.retrieve("what's the best parlay today nhl moneyline", {
      appId: 'duelodds',
      domains: ['nhl', 'multi'],
      allowParlay: true,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('NHL moneyline parlay lesson');
  });
});
