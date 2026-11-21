import { describe, it, expect } from 'vitest';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import { filterHeadersByEventIds } from '../swarm/context/selectedGames.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { guardAnalystResponse, guardManagerResponse, guardVerificationResult } from '../swarm/parser/responseGuards.ts';
import { computeBlendWeight, rankAndFilterCandidates } from '../swarm/memory/tags.ts';
import { InMemoryStorageAdapter } from '../swarm/memory/storage/inMemoryStorage.ts';
import { runDataProfilingPipeline } from '../swarm/engine/profilingPipeline.ts';
import { HierarchicalTaskDecomposer } from '../swarm/coordination/taskDecomposer.ts';
import { getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { SwarmContext } from '../swarm/context.ts';
import { Agent } from '../swarm/agent.ts';

const WF_1795287815668_COMPACT_SLATE = `=== COMPACT SLATE ===
event_id=nba-401910027 | New Orleans Pelicans @ Dallas Mavericks | sp +15.5(-110)/-15.5(-110) | ml +980/-1800 | tot 235.5(-110)/235.5(-110) | rows=R1:ML New Orleans Pelicans(+980),R2:ML Dallas Mavericks(-1800),R3:SPR New Orleans Pelicans +15.5(-110),R4:SPR Dallas Mavericks -15.5(-110),R5:TOT Over 235.5(-110),R6:TOT Under 235.5(-110)
event_id=college-football-401858535 | South Florida Bulls @ Rice Owls | sp -14.5(-110)/+14.5(-110) | ml -650/+460 | tot 52.5(-110)/52.5(-110) | rows=R7:ML Rice Owls(+460),R8:ML South Florida Bulls(-650),R9:SPR South Florida Bulls -14.5(-110),R10:SPR Rice Owls +14.5(-110),R11:TOT Over 52.5(-110),R12:TOT Under 52.5(-110)
event_id=nhl-401892766 | Vancouver Canucks @ Minnesota Wild | sp +1.5(-115)/-1.5(-105) | ml +250/-310 | tot 6.5(-110)/6.5(-110) | rows=R13:ML Vancouver Canucks(+250),R14:ML Minnesota Wild(-310),R15:SPR Vancouver Canucks +1.5(-115),R16:SPR Minnesota Wild -1.5(-105),R17:TOT Over 6.5(-110),R18:TOT Under 6.5(-110)
event_id=college-football-401858511 | Charlotte 49ers @ Florida Atlantic Owls | sp +9.5(-110)/-9.5(-110) | ml +280/n/a | tot 48.5(-110)/48.5(-110) | rows=R19:ML Charlotte 49ers(+280),R20:SPR Charlotte 49ers +9.5(-110),R21:SPR Florida Atlantic Owls -9.5(-110)`;

describe('Flight Recorder Audit wf-1795287815668 — P0-1 Regressions (The_Perfect_Swarm)', () => {
  it('1. parseGameHeaders & renderHeaders preserve R# row IDs, market codes, sides, and prices for all activeEventIds', () => {
    const activeEventIds = [
      'nba-401910027',
      'college-football-401858535',
      'nhl-401892766',
      'college-football-401858511',
    ];
    const headers = parseGameHeaders(WF_1795287815668_COMPACT_SLATE, activeEventIds);
    const scoped = filterHeadersByEventIds(headers, activeEventIds);

    expect(scoped).toHaveLength(4);
    for (const h of scoped) {
      expect(h.options.length).toBeGreaterThan(0);
      expect(h.options.every((o) => /^R\d+$/i.test(o.id))).toBe(true);
    }

    const rendered = renderHeaders(scoped, 4200);
    expect(rendered).toContain('R1 ML New Orleans Pelicans(+980)');
    expect(rendered).toContain('R4 SPR Dallas Mavericks -15.5(-110)');
    expect(rendered).toContain('R9 SPR South Florida Bulls -14.5(-110)');
    expect(rendered).toContain('R16 SPR Minnesota Wild -1.5(-105)');
    expect(rendered).toContain('R19 ML Charlotte 49ers(+280)');
  });

  it('2. executeSwarmWorkflow in two-hop slate mode populates non-null hop1Plan and curatedDossier with seat_visibility', async () => {
    const stages: any[] = [];
    const activeEventIds = ['nba-401910027', 'college-football-401858535'];

    const mockAi = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            analysis: 'Recommended 2-leg parlay on R4 and R9.',
            picks: [
              {
                row: 'R4',
                event_id: 'nba-401910027',
                side: 'Dallas Mavericks -15.5',
                confidence: 0.61,
                reason: 'R4 spread value',
                reasonSource: 'R4',
              },
              {
                row: 'R9',
                event_id: 'college-football-401858535',
                side: 'South Florida Bulls -14.5',
                confidence: 0.63,
                reason: 'R9 spread value',
                reasonSource: 'R9',
              },
            ],
            scorecards: [{ verdict: 'approve', notes: 'No fatal issues found.' }],
            criticApproved: true,
            wageringPass: false,
            pass: true,
          }),
        }),
      },
    } as any;

    const result = await executeSwarmWorkflow({
      task: "CHAT OBJECTIVE: what's the best parlay to place today?",
      data: WF_1795287815668_COMPACT_SLATE,
      triageMode: 'two-hop',
      eventIds: activeEventIds,
      defaultAi: mockAi,
      settings: {
        agents: [
          {
            id: 'manager',
            role: 'Manager Node',
            model: 'simulated-v1',
            provider: 'simulated' as any,
          },
          {
            id: 'a1',
            role: 'Quant Proposer',
            model: 'simulated-v1',
            provider: 'simulated' as any,
          },
          {
            id: 'a2',
            role: 'Market Proposer',
            model: 'simulated-v1',
            provider: 'simulated' as any,
          },
          {
            id: 'critic',
            role: 'Risk Critic',
            model: 'simulated-v1',
            provider: 'simulated' as any,
          },
        ],
      },
      bypassCache: true,
      disableMemoryRetrieval: true,
      onStage: (st) => stages.push(st),
    });

    expect(result.hop1Plan).toBeDefined();
    expect(result.hop1Plan).not.toBeNull();
    expect(result.hop1Plan.mode).toBe('two-hop-slate');
    expect(result.hop1Plan.active_event_ids).toEqual(activeEventIds);
    expect(result.hop1Plan.r_id_count).toBeGreaterThan(0);

    expect(result.curatedDossier).toBeDefined();
    expect(result.curatedDossier).not.toBeNull();
    expect(Array.isArray(result.curatedDossier.seat_visibility)).toBe(true);
    expect(result.curatedDossier.seat_visibility.length).toBeGreaterThan(0);
    for (const vis of result.curatedDossier.seat_visibility) {
      expect(vis.rIdCount).toBeGreaterThan(0);
      expect(vis.inputPreview).toContain('R4');
    }

    expect(stages.some((s) => s.stage === 'hop1_plan')).toBe(true);
    expect(stages.some((s) => s.stage === 'curated_dossier')).toBe(true);
  });
});

describe('Flight Recorder Audit wf-1795287815668 — P0-2 Regressions (The_Perfect_Swarm)', () => {
  it('1. guardAnalystResponse & guardVerificationResult support criticApproved and scorecard verdict approve/veto', () => {
    const approvedCritic = guardAnalystResponse(
      JSON.stringify({
        analysis: 'All proposed legs verified.',
        picks: [],
        scorecards: [{ verdict: 'approve', notes: 'No fatal issues found.' }],
        criticApproved: true,
        wageringPass: false,
      }),
      'Risk Critic',
    );
    expect(approvedCritic.criticApproved).toBe(true);
    expect(approvedCritic.pass).toBe(true);

    const vetoCritic = guardAnalystResponse(
      JSON.stringify({
        analysis: 'Fatal issue found on R1.',
        picks: [],
        scorecards: [{ verdict: 'veto', notes: 'Fatal issue: uncalibrated longshot.' }],
        criticApproved: false,
        wageringPass: true,
      }),
      'Risk Critic',
    );
    expect(vetoCritic.criticApproved).toBe(false);
    expect(vetoCritic.pass).toBe(false);

    expect(
      guardVerificationResult({
        criticApproved: true,
        scorecards: [{ verdict: 'approve', notes: 'No fatal issues found.' }],
      }).pass,
    ).toBe(true);

    expect(
      guardVerificationResult({
        criticApproved: false,
        scorecards: [{ verdict: 'veto', notes: 'Fatal issue' }],
      }).pass,
    ).toBe(false);
  });

  it('2. guardManagerResponse preserves criticApproved and wageringPass fields independently', () => {
    const managerOut = guardManagerResponse({
      analysis: 'Recommended 2-leg parlay.',
      picks: [{ row: 'R4', side: 'Dallas Mavericks -15.5' }],
      scorecards: [{ verdict: 'approve', notes: 'No fatal issues found.' }],
      criticApproved: true,
      wageringPass: false,
    });
    expect((managerOut as any).criticApproved).toBe(true);
    expect((managerOut as any).wageringPass).toBe(false);
    expect((managerOut as any).picks).toHaveLength(1);
  });
});

describe('Flight Recorder Audit wf-1795287815668 — P2-1 Regressions (The_Perfect_Swarm)', () => {
  it('1. Multi-sport Qdrant/InMemory Cortex querying matches lessons across all active sports (ncaaf, nhl, nba)', async () => {
    const storage = new InMemoryStorageAdapter({ isolatedStore: true });
    await storage.initialize('duelodds');

    const nowIso = '2026-11-21T18:00:00Z';
    await storage.store({
      id: 'lesson-ncaaf',
      denseVector: [1, 0, 0],
      sparseVector: { indices: [], values: [] },
      payload: {
        originApp: 'duelodds',
        appId: 'duelodds',
        domain: 'ncaaf',
        visibility: 'public',
        memoryType: 'fact',
        content: 'Avoid unverified road favorites > 14 pts in NCAAF conference play.',
        rule: 'Avoid unverified road favorites > 14 pts in NCAAF conference play.',
        frequency: 1,
        qualityRating: 0.9,
        verified: true,
        timestamp: nowIso,
        lastSeen: nowIso,
      },
    });
    await storage.store({
      id: 'lesson-nhl',
      denseVector: [0, 1, 0],
      sparseVector: { indices: [], values: [] },
      payload: {
        originApp: 'duelodds',
        appId: 'duelodds',
        domain: 'nhl',
        visibility: 'public',
        memoryType: 'fact',
        content: 'Verify starting goalies before locking NHL puckline legs.',
        rule: 'Verify starting goalies before locking NHL puckline legs.',
        frequency: 1,
        qualityRating: 0.9,
        verified: true,
        timestamp: nowIso,
        lastSeen: nowIso,
      },
    });
    await storage.store({
      id: 'lesson-nba',
      denseVector: [0, 0, 1],
      sparseVector: { indices: [], values: [] },
      payload: {
        originApp: 'duelodds',
        appId: 'duelodds',
        domain: 'nba',
        visibility: 'public',
        memoryType: 'fact',
        content: 'Cap NBA double-digit spread legs in multi-game parlays.',
        rule: 'Cap NBA double-digit spread legs in multi-game parlays.',
        frequency: 1,
        qualityRating: 0.9,
        verified: true,
        timestamp: nowIso,
        lastSeen: nowIso,
      },
    });

    const hits = await storage.search([0.6, 0.6, 0.6], {
      appId: 'duelodds',
      domain: 'multi-sport',
      domains: ['ncaaf', 'nhl', 'nba'],
      limit: 5,
    });
    expect(hits.map((h) => h.id)).toEqual(
      expect.arrayContaining(['lesson-ncaaf', 'lesson-nhl', 'lesson-nba']),
    );

    const ranked = rankAndFilterCandidates(
      hits,
      {
        appId: 'duelodds',
        domain: 'multi-sport',
        domains: ['ncaaf', 'nhl', 'nba'],
        limit: 5,
      },
      "what's the best parlay to place today?",
      'duelodds',
    );
    expect(ranked).toHaveLength(3);
    expect(
      computeBlendWeight(
        {
          originApp: 'duelodds',
          appId: 'duelodds',
          domain: 'ncaaf',
          memoryType: 'fact',
          entityIds: [],
        },
        'duelodds',
        'multi-sport',
        [],
        true,
        ['ncaaf', 'nhl', 'nba'],
      ),
    ).toBe(1.0);
  });
});

describe('Flight Recorder Audit wf-1795287815668 — P2-2 Regressions (The_Perfect_Swarm)', () => {
  it('1. Bypasses ColumnarSketcher on === COMPACT SLATE === payloads and caps Groq seat allocation to <= 1500 tokens', () => {
    const ctx = new SwarmContext();
    const analysts = [
      new Agent('Quant Proposer', 'qwen-3.5', 'nvidia', 'k'),
      new Agent('Market Proposer', 'llama-4', 'cloudflare', 'k'),
      new Agent('Risk Critic', 'llama-3.3-70b-versatile', 'groq', 'k'),
    ];
    const prof = runDataProfilingPipeline({
      task: "CHAT OBJECTIVE: what's the best parlay to place today?\n" + 'X'.repeat(3000),
      data: WF_1795287815668_COMPACT_SLATE,
      analysts,
      optimizationEnabled: true,
      coordinationEnabled: true,
      context: ctx,
    });

    expect(prof.datasetSketch).toBeUndefined();
    expect(ctx.events.some((e) => e.modelName === 'Local/ColumnarSketcher')).toBe(false);

    const groqAlloc = prof.adaptiveShardPlan?.seatAllocations.find(
      (a) => a.provider.toLowerCase() === 'groq',
    );
    expect(groqAlloc).toBeDefined();
    expect(groqAlloc!.estimatedShardTokens).toBeLessThanOrEqual(1500);
  });

  it('2. HierarchicalTaskDecomposer caps subtask.title to <= 120 chars and strips multiline prompt bodies', () => {
    const decomposer = new HierarchicalTaskDecomposer();
    const hugePrompt =
      "CHAT OBJECTIVE: what's the best parlay to place today?\n" +
      'REQUIRED RISK CRITIC AND GODVIEW COMPILER VERDICT EXAMPLES:\n' +
      'A'.repeat(2800);
    const plan = decomposer.decompose(hugePrompt, [
      'Quant Proposer',
      'Market Proposer',
      'Risk Critic',
    ]);

    for (const sub of plan.subtasks) {
      expect(sub.title.length).toBeLessThanOrEqual(120);
      expect(sub.title).not.toContain('\n');
    }
  });

  it('3. get_injury_and_roster_delta preserves valid college injuries and keeps total_injuries equal to injuries.length', async () => {
    const mockFetch: any = async () =>
      new Response(
        JSON.stringify({
          game_id: 'college-football-401858527',
          source: 'snapshot',
          total_injuries: 1,
          injuries: [
            {
              team_id: '356',
              player_name: 'Luke Altmyer',
              position: 'QB',
              status: 'questionable',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const res: any = await getInjuryAndRosterDeltaTool.execute(
      { game_id: 'college-football-401858527' },
      {
        fetchFn: mockFetch,
        env: { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-key' },
        game: {
          event_id: 'college-football-401858527',
          sport: 'americanfootball_ncaaf',
          away_team: 'Purdue Boilermakers',
          home_team: 'Illinois Fighting Illini',
        },
      } as any,
    );

    expect(res.success).toBe(true);
    expect(res.data.injuries).toHaveLength(1);
    expect(res.data.total_injuries).toBe(res.data.injuries.length);
    expect(res.data.raw_total_injuries).toBe(1);
    expect(res.summary).toContain('Luke Altmyer (QB): QUESTIONABLE');
  });

  it('4. guardManagerResponse does not flag valid DuelOdds betting JSON as _repaired: true and avoids verbatim summary/analysis/insights duplication', () => {
    const rawCompilerJson = JSON.stringify({
      analysis:
        'Dallas Mavericks -15.5 (R4) and South Florida Bulls -14.5 (R9) form the highest-confidence 2-leg parlay on the slate. Both favorites hold verified spread value with clean injury reports.',
      picks: [
        {
          row: 'R4',
          side: 'Dallas Mavericks -15.5',
          confidence: 0.62,
          reason: 'R4 spread edge',
          reasonSource: 'R4',
        },
      ],
      scorecards: [{ verdict: 'approve', notes: 'No fatal issues found.' }],
      criticApproved: true,
      wageringPass: false,
    });

    const guarded = guardManagerResponse(rawCompilerJson);
    expect(guarded._repaired).toBeUndefined();
    expect((guarded as any).analysis).toContain('Dallas Mavericks -15.5 (R4)');
    expect(guarded.summary).not.toBe((guarded as any).analysis);
    const firstInsight = (guarded.components[0] as any)?.props?.insights?.[0]?.message;
    expect(firstInsight).not.toBe((guarded as any).analysis);
  });
});
