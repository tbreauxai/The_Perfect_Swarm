import { describe, it, expect } from 'vitest';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import { filterHeadersByEventIds } from '../swarm/context/selectedGames.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { guardAnalystResponse, guardManagerResponse, guardVerificationResult } from '../swarm/parser/responseGuards.ts';
import { computeBlendWeight, rankAndFilterCandidates } from '../swarm/memory/tags.ts';
import { InMemoryStorageAdapter } from '../swarm/memory/storage/inMemoryStorage.ts';

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

    await storage.store({
      id: 'lesson-ncaaf',
      denseVector: [1, 0, 0],
      payload: {
        originApp: 'duelodds',
        appId: 'duelodds',
        domain: 'ncaaf',
        visibility: 'public',
        memoryType: 'fact',
        rule: 'Avoid unverified road favorites > 14 pts in NCAAF conference play.',
      },
    });
    await storage.store({
      id: 'lesson-nhl',
      denseVector: [0, 1, 0],
      payload: {
        originApp: 'duelodds',
        appId: 'duelodds',
        domain: 'nhl',
        visibility: 'public',
        memoryType: 'fact',
        rule: 'Verify starting goalies before locking NHL puckline legs.',
      },
    });
    await storage.store({
      id: 'lesson-nba',
      denseVector: [0, 0, 1],
      payload: {
        originApp: 'duelodds',
        appId: 'duelodds',
        domain: 'nba',
        visibility: 'public',
        memoryType: 'fact',
        rule: 'Cap NBA double-digit spread legs in multi-game parlays.',
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
