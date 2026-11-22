import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import {
  classifyInjuryHealthBalance,
  getInjuryAndRosterDeltaTool,
  getMatchupFundamentalsTool,
  getMarketMovementTool,
} from '../swarm/tools/dueloddsRpcTools.ts';
import {
  evaluateQualitativePillars,
  formatUnifiedPerGameDossier,
} from '../swarm/engine/unifiedDossier.ts';
import { auditCriticPremiseContradictions } from '../swarm/tools/claimGrounding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

describe('wf-1795373843477 P1-1 & P2-1 Regressions (The_Perfect_Swarm)', () => {
  it('P1-1 (1): never labels teams meeting/exceeding sport QUESTIONABLE cap as home_advantage or away_advantage', async () => {
    // NBA: NYK (0 OUT, 3 Q) vs IND (4 OUT, 1 Q) -> uncertain_questionable (cap = 2)
    const nykInd = classifyInjuryHealthBalance({
      homeTeam: 'New York Knicks',
      awayTeam: 'Indiana Pacers',
      homeOut: 0,
      homeQ: 3,
      awayOut: 4,
      awayQ: 1,
      sport: 'basketball_nba',
      gameId: 'nba-401910034',
    });
    expect(nykInd.balance).toBe('uncertain_questionable');
    expect(nykInd.label).not.toMatch(/home_advantage|away_advantage/i);
    expect(nykInd.label).toContain('uncertain_questionable');
    expect(nykInd.label).toContain('New York Knicks: 3 Q');

    // NBA: BOS (0 OUT, 3 Q) vs GSW (5 OUT, 0 Q) -> uncertain_questionable (NOT away_advantage)
    const bosGsw = classifyInjuryHealthBalance({
      homeTeam: 'Golden State Warriors',
      awayTeam: 'Boston Celtics',
      homeOut: 5,
      homeQ: 0,
      awayOut: 0,
      awayQ: 3,
      sport: 'basketball_nba',
      gameId: 'nba-401910035',
    });
    expect(bosGsw.balance).toBe('uncertain_questionable');
    expect(bosGsw.label).not.toMatch(/home_advantage|away_advantage/i);

    // NFL: SF (1 OUT, 4 Q) vs MIN (3 OUT, 2 Q) -> uncertain_questionable (cap = 3)
    const sfMin = classifyInjuryHealthBalance({
      homeTeam: 'San Francisco 49ers',
      awayTeam: 'Minnesota Vikings',
      homeOut: 1,
      homeQ: 4,
      awayOut: 3,
      awayQ: 2,
      sport: 'americanfootball_nfl',
      gameId: 'nfl-401873077',
    });
    expect(sfMin.balance).toBe('uncertain_questionable');
    expect(sfMin.label).not.toMatch(/home_advantage|away_advantage/i);

    // NFL: LV (2 OUT, 3 Q) vs Opp (5 OUT, 0 Q) -> uncertain_questionable (cap = 3)
    const lvOpp = classifyInjuryHealthBalance({
      homeTeam: 'Kansas City Chiefs',
      awayTeam: 'Las Vegas Raiders',
      homeOut: 5,
      homeQ: 0,
      awayOut: 2,
      awayQ: 3,
      sport: 'americanfootball_nfl',
      gameId: 'nfl-401873075',
    });
    expect(lvOpp.balance).toBe('uncertain_questionable');

    // NBA: DEN (1 OUT, 0 Q) vs CHI (2 OUT, 3 Q) -> away_advantage (Denver Nuggets)
    const denChi = classifyInjuryHealthBalance({
      homeTeam: 'Chicago Bulls',
      awayTeam: 'Denver Nuggets',
      homeOut: 2,
      homeQ: 3,
      awayOut: 1,
      awayQ: 0,
      sport: 'basketball_nba',
      gameId: 'nba-401910032',
    });
    expect(denChi.balance).toBe('away_advantage');
    expect(denChi.label).toBe('away_advantage (Denver Nuggets)');

    // NHL: STL (3 OUT, 1 Q) vs EDM (5 OUT, 1 Q) -> home_advantage (St. Louis Blues) (1 Q < 2 cap)
    const stlEdm = classifyInjuryHealthBalance({
      homeTeam: 'St. Louis Blues',
      awayTeam: 'Edmonton Oilers',
      homeOut: 3,
      homeQ: 1,
      awayOut: 5,
      awayQ: 1,
      sport: 'icehockey_nhl',
      gameId: 'nhl-401892770',
    });
    expect(stlEdm.balance).toBe('home_advantage');
    expect(stlEdm.label).toBe('home_advantage (St. Louis Blues)');

    // Severely depleted opponent vs 2 Q cap -> conditional_home_advantage
    const okcMia = classifyInjuryHealthBalance({
      homeTeam: 'Miami Heat',
      awayTeam: 'Oklahoma City Thunder',
      homeOut: 0,
      homeQ: 2,
      awayOut: 7,
      awayQ: 0,
      sport: 'basketball_nba',
      gameId: 'nba-401910036',
    });
    expect(okcMia.balance).toBe('conditional_home_advantage');
    expect(okcMia.label).toContain('conditional_home_advantage (Miami Heat');
    expect(okcMia.label).toContain('watch 2 Q');

    // Tool integration test for NYK (0 OUT, 3 Q) vs IND (4 OUT, 1 Q)
    const nykFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910034',
          sport: 'basketball_nba',
          home_team: 'New York Knicks',
          away_team: 'Indiana Pacers',
          injuries: [
            { team_name: 'New York Knicks', team_abbr: 'NYK', player_name: 'Karl-Anthony Towns', status: 'QUESTIONABLE' },
            { team_name: 'New York Knicks', team_abbr: 'NYK', player_name: 'OG Anunoby', status: 'QUESTIONABLE' },
            { team_name: 'New York Knicks', team_abbr: 'NYK', player_name: 'Jordan Clarkson', status: 'QUESTIONABLE' },
            { team_name: 'Indiana Pacers', team_abbr: 'IND', player_name: 'Player 1', status: 'OUT' },
            { team_name: 'Indiana Pacers', team_abbr: 'IND', player_name: 'Player 2', status: 'OUT' },
            { team_name: 'Indiana Pacers', team_abbr: 'IND', player_name: 'Player 3', status: 'OUT' },
            { team_name: 'Indiana Pacers', team_abbr: 'IND', player_name: 'Player 4', status: 'OUT' },
            { team_name: 'Indiana Pacers', team_abbr: 'IND', player_name: 'Player 5', status: 'QUESTIONABLE' },
          ],
        }),
        { status: 200 },
      ),
    );
    const toolRes = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nba-401910034' },
      { fetchFn: nykFetch as any, env: mockEnv },
    );
    expect(toolRes.success).toBe(true);
    expect(toolRes.summary).toContain('Health Balance: uncertain_questionable (New York Knicks: 3 Q)');

    // Verify uncertain_questionable and conditional_home_advantage are NOT counted as full health pillars
    const pillarsNyk = evaluateQualitativePillars({
      eventId: 'nba-401910034',
      matchup: 'Indiana Pacers @ New York Knicks',
      sport: 'basketball_nba',
      fundamentals: 'Home (NYK): W-L 6-4 | Net Margin 2.0 | Away (IND): W-L 5-5 | Net Margin 1.0',
      injuries: toolRes.summary,
      market: 'Steam: neutral',
      hasDirectionalSteam: false,
      outCountDiff: 4,
      netMarginGap: 1.0,
    });
    expect(pillarsNyk.tags.some((t) => t.startsWith('health='))).toBe(false);
    expect(pillarsNyk.pillarCount).toBe(0);

    const pillarsMia = evaluateQualitativePillars({
      eventId: 'nba-401910036',
      matchup: 'Oklahoma City Thunder @ Miami Heat',
      sport: 'basketball_nba',
      fundamentals: 'Home (MIA): W-L 6-4 | Net Margin 4.0 | Away (OKC): W-L 4-6 | Net Margin 0.0',
      injuries: okcMia.line,
      market: 'Steam: TOWARD home Miami Heat ML (-144 -> -172, +4.2pp implied)',
      hasDirectionalSteam: true,
      outCountDiff: 7,
      netMarginGap: 4.0,
    });
    expect(pillarsMia.tags.some((t) => t.startsWith('health='))).toBe(false);

    const formatted = formatUnifiedPerGameDossier([
      {
        eventId: 'nba-401910034',
        matchup: 'Indiana Pacers @ New York Knicks',
        sport: 'basketball_nba',
        fundamentals: 'Home (NYK): W-L 6-4 | Net Margin 2.0 | Away (IND): W-L 5-5 | Net Margin 1.0',
        injuries: nykInd.line,
        market: 'Steam: neutral',
        hasDirectionalSteam: false,
        outCountDiff: 4,
        netMarginGap: 1.0,
      },
    ]);
    expect(formatted.text).toContain('Health Balance: uncertain_questionable (New York Knicks: 3 Q)');

    // ClaimGrounding flags unacknowledged health advantage claim against NYK uncertain_questionable fallback
    const slate =
      'event_id=nba-401910034 | sport=basketball_nba | Indiana Pacers @ New York Knicks | commence=2099-11-23T00:00:00Z | options: R55 SPR New York Knicks -7.5 (-110), R56 SPR Indiana Pacers +7.5 (-110)';
    const audit = auditCriticPremiseContradictions(
      {
        picks: [
          {
            row: 'R55',
            event_id: 'nba-401910034',
            side: 'New York Knicks -7.5',
            reason: 'Knicks have a massive health advantage against Pacers.',
          },
        ],
      },
      `EVENT nba-401910034 Indiana Pacers @ New York Knicks\n${nykInd.line}`,
      slate,
      { headers: parseGameHeaders(slate) },
    );
    expect(audit.pass).toBe(false);
    expect(audit.flags).toContain('symmetric_injury_misread');
  });

  it('P2-1: two-hop executeSwarmWorkflow emits populated 3-seat seat_visibility on curated_dossier stage, result, and finalAnalysis', async () => {
    const games = [
      {
        eventId: 'nfl-401873077',
        sport: 'americanfootball_nfl',
        away: 'San Francisco 49ers',
        home: 'Minnesota Vikings',
        spHome: '-2.5',
        spAway: '+2.5',
        mlHome: '-140',
        mlAway: '+118',
        tot: '41.5',
      },
      {
        eventId: 'nba-401910034',
        sport: 'basketball_nba',
        away: 'Indiana Pacers',
        home: 'New York Knicks',
        spHome: '-7.5',
        spAway: '+7.5',
        mlHome: '-310',
        mlAway: '+250',
        tot: '229.5',
      },
    ];

    let nextR = 1;
    const slateData = games
      .map((g) => {
        const rIds = Array.from({ length: 6 }, () => `R${nextR++}`);
        const opts = [
          `${rIds[0]}:SPR ${g.home} ${g.spHome}(-110)`,
          `${rIds[1]}:SPR ${g.away} ${g.spAway}(-110)`,
          `${rIds[2]}:ML ${g.home} ML(${g.mlHome})`,
          `${rIds[3]}:ML ${g.away} ML(${g.mlAway})`,
          `${rIds[4]}:TOT Over ${g.tot}(-110)`,
          `${rIds[5]}:TOT Under ${g.tot}(-110)`,
        ].join(',');
        return `event_id=${g.eventId} | sport=${g.sport} | ${g.away} @ ${g.home} | commence=2099-11-23T00:00:00Z | rows=${opts}`;
      })
      .join('\n');

    const rpcFetch = vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gameId = String(body.p_game_id || '');
      const g = games.find((x) => x.eventId === gameId) || games[0];
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(JSON.stringify({ source: 'snapshot', game_id: gameId, injuries: [] }), { status: 200 });
      }
      if (url.includes('get_matchup_fundamentals_v1')) {
        return new Response(
          JSON.stringify({
            source: 'team_games',
            game_id: gameId,
            home: { team: g.home, wins: 5, losses: 1, net_margin: 8.5, recent_results: ['W', 'W', 'W', 'L', 'W'] },
            away: { team: g.away, wins: 2, losses: 4, net_margin: -3.5, recent_results: ['L', 'W', 'L', 'L', 'L'] },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          sport: g.sport,
          home_team: g.home,
          away_team: g.away,
          books_tracked: 2,
          snapshots_tracked: 3,
          opening: { spread: Number(g.spHome), ml_home: Number(g.mlHome), ml_away: Number(g.mlAway), total: Number(g.tot) - 1.0 },
          latest: { spread: Number(g.spHome), ml_home: Number(g.mlHome), ml_away: Number(g.mlAway), total: Number(g.tot) },
        }),
        { status: 200 },
      );
    });

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn: rpcFetch, env: mockEnv }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn: rpcFetch, env: mockEnv }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn: rpcFetch, env: mockEnv }) },
    ]);

    const stageEvents: any[] = [];
    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const idOrRole = String((this as any).id || this.role || '').toLowerCase();
      if (idOrRole.includes('a1') || idOrRole.includes('quant')) {
        return JSON.stringify({
          analysis: 'R5 Over 41.5 backed by Over total steam (40.5 -> 41.5) and R1 Minnesota Vikings -2.5 form edge.',
          picks: [{ row: 'R5', event_id: 'nfl-401873077', side: 'Over 41.5', reason: 'Steam R5', reasonSource: 'R5' }],
          scorecards: [],
        });
      }
      if (idOrRole.includes('a2') || idOrRole.includes('market')) {
        return JSON.stringify({
          analysis: 'R5 Over 41.5 confirmed by multi-book Over steam.',
          picks: [{ row: 'R5', event_id: 'nfl-401873077', side: 'Over 41.5', reason: 'Market R5', reasonSource: 'R5' }],
          scorecards: [],
        });
      }
      if (prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({ pass: true, feedback: 'Verified against dossier.' });
      }
      if (idOrRole.includes('critic') || idOrRole.includes('risk')) {
        return JSON.stringify({
          criticApproved: true,
          wageringPass: false,
          pass: true,
          verdict: 'Verified R5 Over 41.5.',
          flags: [],
        });
      }
      return JSON.stringify({
        ui_title: 'Single Edge: Over 41.5',
        summary: 'Bottom-line call: play Over 41.5 (R5) with 1-of-1 directional Over steam. Flip condition: heavy rain.',
        picks: [
          { row: 'R5', event_id: 'nfl-401873077', side: 'Over 41.5', market: 'totals', line: 41.5, odds: -110, sportsbook: 'FanDuel', reason: 'Over steam R5', reasonSource: 'R5' },
        ],
        criticApproved: true,
        wageringPass: false,
        components: [],
      });
    });

    try {
      const result: any = await executeSwarmWorkflow({
        task: 'Find the best bet tonight',
        userPrompt: 'Find the best bet tonight',
        data: slateData,
        triageMode: 'two-hop',
        eventIds: games.map((g) => g.eventId),
        allowParlay: false,
        enableDeepAnalysis: true,
        forceFullSwarm: true,
        bypassCache: true,
        disableMemoryRetrieval: true,
        tools: registry,
        onStage: (evt: any) => stageEvents.push(evt),
        defaultAi: {
          models: {
            generateContent: async () => ({ text: '{}' }),
            embedContent: async () => ({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }),
          },
        } as any,
        settings: {
          openRouterApiKey: 'sk-or-v1-mock',
          cloudflareApiKey: 'mock-cf',
          groqApiKey: 'gsk_mock',
          nvidiaApiKey: 'nv_mock',
          agents: [
            { id: 'a1', role: 'Quant Proposer', provider: 'nvidia', apiKey: 'nv_mock', modelName: 'llama-3.3' },
            { id: 'a2', role: 'Market Proposer', provider: 'cloudflare', apiKey: 'mock-cf', modelName: 'cf-llama' },
            { id: 'critic', role: 'Risk Critic', provider: 'groq', apiKey: 'gsk_mock', modelName: 'llama-3.3-70b-versatile' },
            { id: 'manager', role: 'Manager Node', provider: 'gemini', apiKey: 'mock-gem', modelName: 'gemini-2.5' },
          ],
        } as any,
      } as any);

      const dossierStages = stageEvents.filter((e) => e?.stage === 'curated_dossier');
      expect(dossierStages.length).toBeGreaterThanOrEqual(2);
      const lastDossierStage = dossierStages[dossierStages.length - 1];
      const stageSeats = lastDossierStage?.dossier?.seat_visibility;
      expect(Array.isArray(stageSeats)).toBe(true);
      expect(stageSeats).toHaveLength(3);
      for (const seatName of ['a1', 'a2', 'critic']) {
        const rec = stageSeats.find((s: any) => s.seat === seatName);
        expect(rec).toBeDefined();
        expect(rec.dossierTruncated).toBe(false);
        expect(rec.dossierChars).toBeGreaterThan(0);
      }

      expect(result.curatedDossier?.seat_visibility).toHaveLength(3);
      expect(result.finalAnalysis?.curatedDossier?.seat_visibility).toHaveLength(3);
      expect(result.seat_visibility).toHaveLength(3);
      expect(result.finalAnalysis?.seat_visibility).toHaveLength(3);
    } finally {
      runSpy.mockRestore();
    }
  }, 20000);
});
