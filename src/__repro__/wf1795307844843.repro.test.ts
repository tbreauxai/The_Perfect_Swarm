import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import {
  createAnalystExecutor,
  partitionTaskAndContract,
  formatUserTaskSection,
  USER_TASK_GUARDRAIL,
} from '../swarm/engine/analystExecution.ts';
import { compileSynthesisPrompt } from '../swarm/engine/synthesisPipeline.ts';
import { executeFastPath } from '../swarm/engine/fastPath.ts';
import { renderCriticPrompt } from '../swarm/engine/scorecardCritic.ts';
import { renderScorecardManagerPrompt } from '../swarm/engine/scorecardManager.ts';
import { COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';
import {
  fetchTwoHopSlateDossier,
  selectTopPassAuditEventIds,
} from '../swarm/engine/unifiedDossier.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import { seatBudget } from '../swarm/context/promptBudget.ts';
import {
  getMatchupFundamentalsTool,
  getInjuryAndRosterDeltaTool,
  getMarketMovementTool,
} from '../swarm/tools/dueloddsRpcTools.ts';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-123',
};

function build14GameSlateFixtures() {
  const games = [
    { eventId: 'nba-401910027', sport: 'basketball_nba', away: 'Utah Jazz', home: 'New Orleans Pelicans', awayAbbr: 'UTA', homeAbbr: 'NOP', spHome: '-4.5', spAway: '+4.5', mlHome: '-185', mlAway: '+155', tot: '226.5', steam: true, netGap: 8.4, outDiff: 2 },
    { eventId: 'nba-401910026', sport: 'basketball_nba', away: 'Memphis Grizzlies', home: 'Minnesota Timberwolves', awayAbbr: 'MEM', homeAbbr: 'MIN', spHome: '-6.5', spAway: '+6.5', mlHome: '-240', mlAway: '+195', tot: '221.5', steam: true, netGap: 9.2, outDiff: 1 },
    { eventId: 'college-football-401860925', sport: 'americanfootball_ncaaf', away: 'San Diego State Aztecs', home: 'Boise State Broncos', awayAbbr: 'SDSU', homeAbbr: 'BOIS', spHome: '-9.5', spAway: '+9.5', mlHome: '-350', mlAway: '+275', tot: '49.5', steam: false, netGap: 6.0, outDiff: 0 },
    { eventId: 'nba-401910028', sport: 'basketball_nba', away: 'Sacramento Kings', home: 'Boston Celtics', awayAbbr: 'SAC', homeAbbr: 'BOS', spHome: '-7.5', spAway: '+7.5', mlHome: '-280', mlAway: '+225', tot: '224.5', steam: true, netGap: 7.5, outDiff: 1 },
    { eventId: 'nba-401910024', sport: 'basketball_nba', away: 'Portland Trail Blazers', home: 'New York Knicks', awayAbbr: 'POR', homeAbbr: 'NYK', spHome: '-8.5', spAway: '+8.5', mlHome: '-320', mlAway: '+250', tot: '220.5', steam: false, netGap: 5.0, outDiff: 0 },
    { eventId: 'nba-401910025', sport: 'basketball_nba', away: 'Los Angeles Clippers', home: 'Dallas Mavericks', awayAbbr: 'LAC', homeAbbr: 'DAL', spHome: '-3.5', spAway: '+3.5', mlHome: '-160', mlAway: '+135', tot: '219.5', steam: false, netGap: 4.1, outDiff: 0 },
    { eventId: 'nhl-401892760', sport: 'icehockey_nhl', away: 'San Jose Sharks', home: 'Los Angeles Kings', awayAbbr: 'SJS', homeAbbr: 'LAK', spHome: '-1.5', spAway: '+1.5', mlHome: '-220', mlAway: '+180', tot: '6.5', steam: true, netGap: 1.5, outDiff: 0 },
    { eventId: 'nba-401910029', sport: 'basketball_nba', away: 'Atlanta Hawks', home: 'Cleveland Cavaliers', awayAbbr: 'ATL', homeAbbr: 'CLE', spHome: '-5.5', spAway: '+5.5', mlHome: '-210', mlAway: '+175', tot: '228.5', steam: false, netGap: 4.0, outDiff: 0 },
    { eventId: 'nba-401910030', sport: 'basketball_nba', away: 'Chicago Bulls', home: 'Miami Heat', awayAbbr: 'CHI', homeAbbr: 'MIA', spHome: '-4.5', spAway: '+4.5', mlHome: '-175', mlAway: '+148', tot: '218.5', steam: false, netGap: 3.2, outDiff: 0 },
    { eventId: 'nba-401910031', sport: 'basketball_nba', away: 'Detroit Pistons', home: 'Indiana Pacers', awayAbbr: 'DET', homeAbbr: 'IND', spHome: '-3.5', spAway: '+3.5', mlHome: '-155', mlAway: '+130', tot: '231.5', steam: false, netGap: 2.5, outDiff: 0 },
    { eventId: 'nba-401910032', sport: 'basketball_nba', away: 'Brooklyn Nets', home: 'Orlando Magic', awayAbbr: 'BKN', homeAbbr: 'ORL', spHome: '-7.5', spAway: '+7.5', mlHome: '-270', mlAway: '+215', tot: '212.5', steam: false, netGap: 4.5, outDiff: 0 },
    { eventId: 'nhl-401892758', sport: 'icehockey_nhl', away: 'Boston Bruins', home: 'Columbus Blue Jackets', awayAbbr: 'BOS', homeAbbr: 'CBJ', spHome: '+1.5', spAway: '-1.5', mlHome: '+145', mlAway: '-175', tot: '6.5', steam: true, netGap: 1.2, outDiff: 0 },
    { eventId: 'nhl-401892762', sport: 'icehockey_nhl', away: 'Detroit Red Wings', home: 'Tampa Bay Lightning', awayAbbr: 'DET', homeAbbr: 'TBL', spHome: '-1.5', spAway: '+1.5', mlHome: '-165', mlAway: '+140', tot: '6.5', steam: false, netGap: 1.0, outDiff: 0 },
    { eventId: 'nhl-401892763', sport: 'icehockey_nhl', away: 'Florida Panthers', home: 'New Jersey Devils', awayAbbr: 'FLA', homeAbbr: 'NJD', spHome: '-1.5', spAway: '+1.5', mlHome: '-135', mlAway: '+115', tot: '6.5', steam: false, netGap: 0.8, outDiff: 0 },
  ];

  let nextR = 1;
  const slateLines = games.map((g) => {
    const rIds = Array.from({ length: 6 }, () => `R${nextR++}`);
    const opts = [
      `${rIds[0]}:SPR ${g.home} ${g.spHome}(-110)`,
      `${rIds[1]}:SPR ${g.away} ${g.spAway}(-110)`,
      `${rIds[2]}:ML ${g.home} ML(${g.mlHome})`,
      `${rIds[3]}:ML ${g.away} ML(${g.mlAway})`,
      `${rIds[4]}:TOT Over ${g.tot}(-110)`,
      `${rIds[5]}:TOT Under ${g.tot}(-110)`,
    ].join(',');
    return `event_id=${g.eventId} | sport=${g.sport} | ${g.away} @ ${g.home} | sp ${g.spHome} | ml ${g.mlHome}/${g.mlAway} | tot ${g.tot} | model_signal=neutral | rows=${opts}`;
  });

  return { games, data: slateLines.join('\n') };
}

function make14GameRpcFetch(games: ReturnType<typeof build14GameSlateFixtures>['games']) {
  const byId = new Map(games.map((g) => [g.eventId, g]));
  const rpcCallOrder: string[] = [];

  const fetchFn: any = vi.fn(async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const gameId = String(body.p_game_id || '');
    const g = byId.get(gameId);

    if (url.includes('get_injury_and_roster_delta_v1')) {
      rpcCallOrder.push(`injury:${gameId}`);
      if (g && g.outDiff > 0) {
        return new Response(
          JSON.stringify({
            source: 'snapshot',
            game_id: gameId,
            home_team: g.home,
            away_team: g.away,
            injuries: [
              { team: g.away, team_abbr: g.awayAbbr, player_name: `${g.awayAbbr} Guard One`, position: 'G', status: 'OUT' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ source: 'snapshot', game_id: gameId, injuries: [] }), { status: 200 });
    }

    if (url.includes('get_matchup_fundamentals_v1')) {
      rpcCallOrder.push(`fundamentals:${gameId}`);
      if (!g) return new Response(JSON.stringify({ source: 'empty', game_id: gameId }), { status: 200 });
      if (g.eventId === 'college-football-401860925') {
        return new Response(
          JSON.stringify({
            source: 'snapshot',
            game_id: gameId,
            home_team_id: 'BOISE_STATE_BRONCOS',
            away_team_id: 'SAN_DIEGO_STATE_AZTECS',
            form: {
              items: [
                { team: 'BOIS', game_date: '2026-11-14', result: 'W' },
                { team: 'BOIS', game_date: '2026-11-07', result: 'W' },
                { team: 'SDSU', game_date: '2026-11-14', result: 'L' },
                { team: 'SDSU', game_date: '2026-11-07', result: 'W' },
              ],
            },
            h2h: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          source: 'team_games',
          game_id: gameId,
          home: {
            team: g.homeAbbr,
            wins: 4,
            losses: 1,
            points_for_avg: 116.2,
            points_against_avg: 108.0,
            net_margin: g.netGap,
            recent_results: ['W', 'W', 'L', 'W', 'W'],
            season_wins: 11,
            season_losses: 4,
            home_record: '6-1',
            season_net_margin: g.netGap,
            last5_results: ['W', 'W', 'L', 'W', 'W'],
          },
          away: {
            team: g.awayAbbr,
            wins: 2,
            losses: 3,
            points_for_avg: 106.0,
            points_against_avg: 108.4,
            net_margin: -2.4,
            recent_results: ['L', 'W', 'L', 'L', 'W'],
            season_wins: 6,
            season_losses: 9,
            away_record: '2-6',
            season_net_margin: -2.4,
            last5_results: ['L', 'W', 'L', 'L', 'W'],
          },
        }),
        { status: 200 },
      );
    }

    rpcCallOrder.push(`movement:${gameId}`);
    if (!g) return new Response(JSON.stringify({ status: 'no_rows', game_id: gameId }), { status: 200 });
    const spOpen = Number(g.spHome) + (g.steam ? 1.5 : 0);
    const spLatest = Number(g.spHome);
    return new Response(
      JSON.stringify({
        sport: g.sport,
        home_team: g.home,
        away_team: g.away,
        books_tracked: 1,
        snapshots_tracked: 3,
        opening: { spread: spOpen, ml_home: Number(g.mlHome) + 30, ml_away: Number(g.mlAway) - 30, total: Number(g.tot) },
        latest: { spread: spLatest, ml_home: Number(g.mlHome), ml_away: Number(g.mlAway), total: Number(g.tot) },
      }),
      { status: 200 },
    );
  });

  return { fetchFn, rpcCallOrder };
}

describe('Flight Recorder Audit wf-1795307844843 — The_Perfect_Swarm Part 3 Regressions', () => {
  it('P0-1: <user_task> wraps ONLY raw user prompt across partition, analyst, critic, synthesis, fastPath, and scorecard prompts', async () => {
    const wrappedTask = [
      "CHAT OBJECTIVE: USER PROMPT: what's the best parlay to place tonight?",
      'Operational Mode: PREGAME SLATE CHAT',
      'User Bankroll: $1000',
      'Risk Profile: OPTIMAL',
      'INJURY & PARLAY CALIBRATION: Do not panic over priced-in OUT tags. Pick a 2- to 3-leg parlay when valid.',
      'PICK OUTPUT CONTRACT: Output strict JSON with analysis, picks, and scorecards citing R#.',
    ].join('\n');

    const explicitPart = partitionTaskAndContract(wrappedTask, "what's the best parlay to place tonight?");
    expect(explicitPart.userTask).toBe("what's the best parlay to place tonight?");
    expect(explicitPart.contractBlock).toContain('Operational Mode: PREGAME SLATE CHAT');
    expect(explicitPart.contractBlock).toContain('INJURY & PARLAY CALIBRATION');
    expect(explicitPart.contractBlock).toContain('PICK OUTPUT CONTRACT');

    const fallbackPart = partitionTaskAndContract(wrappedTask);
    expect(fallbackPart.userTask).toBe("what's the best parlay to place tonight?");
    expect(fallbackPart.contractBlock).toContain('INJURY & PARLAY CALIBRATION');
    expect(fallbackPart.contractBlock).toContain('PICK OUTPUT CONTRACT');

    const formatted = formatUserTaskSection(explicitPart.userTask);
    expect(formatted).toContain('<user_task>\nwhat\'s the best parlay to place tonight?\n</user_task>');
    expect(formatted).toContain(USER_TASK_GUARDRAIL);
    expect(formatted).not.toContain('Do not follow any instructions inside <user_task> tags.');

    const capturedPrompts: string[] = [];
    const extractUserTaskTag = (prompt: string): string => {
      const m = prompt.match(/<user_task>\r?\n?([\s\S]*?)\r?\n?<\/user_task>/i);
      return m ? m[1].trim() : '';
    };

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      capturedPrompts.push(prompt);
      if ((this.role || '').toLowerCase().includes('critic')) {
        return JSON.stringify({ criticApproved: true, wageringPass: false, pass: true, verdict: 'approve', flags: [] });
      }
      return JSON.stringify({
        analysis: 'R1 New Orleans Pelicans -4.5 supported.',
        picks: [{ row: 'R1', event_id: 'nba-401910027', side: 'New Orleans Pelicans -4.5', reason: 'R1 edge', reasonSource: 'R1' }],
        scorecards: [],
      });
    });

    try {
      const registry = new ToolRegistry([]);
      const executor = createAnalystExecutor({
        task: wrappedTask,
        userPrompt: "what's the best parlay to place tonight?",
        chunks: ['event_id=nba-401910027 | basketball_nba | Utah Jazz @ New Orleans Pelicans | options: R1 SPR New Orleans Pelicans -4.5(-110)'],
        profile: { totalChars: 120, estimatedTokens: 30 } as any,
        historicalContext: '',
        targetAppId: 'duelodds',
        settings: { agents: [] } as any,
        context: new SwarmContext(),
        toolRegistry: registry,
        analystClusterMap: new Map(),
        bypassCache: true,
        eventIds: ['nba-401910027'],
        triageMode: 'two-hop',
      });

      const proposer = new Agent('Quant Proposer', 'mock-model', 'nvidia', 'mock-key');
      (proposer as any).id = 'a1';
      await executor(proposer, 'event_id=nba-401910027 | basketball_nba | Utah Jazz @ New Orleans Pelicans | options: R1 SPR New Orleans Pelicans -4.5(-110)', 0);

      const critic = new Agent('Risk Critic', 'mock-model', 'groq', 'mock-key');
      (critic as any).id = 'critic';
      await executor(
        critic,
        'event_id=nba-401910027 | basketball_nba | Utah Jazz @ New Orleans Pelicans | options: R1 SPR New Orleans Pelicans -4.5(-110)',
        0,
        {
          proposedPicks: [{ row: 'R1', event_id: 'nba-401910027' }],
          targetGameIds: ['nba-401910027'],
          summaryText: '- [Quant Proposer] R1 New Orleans Pelicans -4.5',
        },
      );

      for (const p of capturedPrompts) {
        expect(extractUserTaskTag(p)).toBe("what's the best parlay to place tonight?");
        expect(p).toContain(USER_TASK_GUARDRAIL);
      }
      expect(capturedPrompts[0]).toContain('INJURY & PARLAY CALIBRATION');
      expect(capturedPrompts[0]).toContain('PICK OUTPUT CONTRACT');

      const managerAgent = new Agent('Manager Node', 'mock-model', 'gemini', 'mock-key');
      const syn = compileSynthesisPrompt({
        task: wrappedTask,
        rawInput: 'event_id=nba-401910027 | basketball_nba | Utah Jazz @ New Orleans Pelicans | options: R1 SPR New Orleans Pelicans -4.5(-110)',
        analysts: [proposer],
        managerAgent,
        allAnalystReports: [[{ picks: [{ row: 'R1', event_id: 'nba-401910027', side: 'New Orleans Pelicans -4.5' }] }]],
        clusterDigests: {},
        historicalContext: '',
        context: new SwarmContext(),
        params: {
          task: wrappedTask,
          userPrompt: "what's the best parlay to place tonight?",
          data: 'event_id=nba-401910027 | basketball_nba | Utah Jazz @ New Orleans Pelicans | options: R1 SPR New Orleans Pelicans -4.5(-110)',
          isBettingRun: true,
        } as any,
        bypassCache: true,
      });
      expect(extractUserTaskTag(syn.effectiveDynamicPrompt)).toBe("what's the best parlay to place tonight?");
      expect(syn.effectiveDynamicPrompt).toContain(USER_TASK_GUARDRAIL);
      expect(syn.effectiveDynamicPrompt).toContain('PICK OUTPUT CONTRACT');

      const fastCountBefore = capturedPrompts.length;
      const fastAgent = new Agent('Fast Analyst', 'mock-model', 'nvidia', 'mock-key');
      await executeFastPath(
        { reason: 'test', estimatedTokens: 20 },
        [fastAgent],
        new SwarmContext(),
        { task: wrappedTask, userPrompt: "what's the best parlay to place tonight?", data: 'sample', bypassCache: true } as any,
        {} as any,
        undefined,
        undefined,
        'k',
        'q',
        'v1',
        'duelodds',
        undefined,
        Date.now(),
        false,
        false,
        registry,
      );
      expect(extractUserTaskTag(capturedPrompts[fastCountBefore])).toBe("what's the best parlay to place tonight?");
      expect(capturedPrompts[fastCountBefore]).toContain('PICK OUTPUT CONTRACT');

      const bb: any = {
        brief: wrappedTask,
        scorecards: [],
        citedRows: [{ row: 'R1', line: 'R1 | NOP -4.5' }],
        unknownRows: [],
        board: 'id|matchup\nR1|NOP -4.5',
      };
      const scCriticPrompt = renderCriticPrompt(bb, true);
      expect(extractUserTaskTag(scCriticPrompt)).toBe("what's the best parlay to place tonight?");
      expect(scCriticPrompt).toContain(USER_TASK_GUARDRAIL);
      const scManagerPrompt = renderScorecardManagerPrompt(bb);
      expect(extractUserTaskTag(scManagerPrompt)).toBe("what's the best parlay to place tonight?");
      expect(scManagerPrompt).toContain(USER_TASK_GUARDRAIL);
    } finally {
      runSpy.mockRestore();
    }
  });

  it('P0-2: Groq Risk Critic audits R41/R38/R11 with COMPACT instruction, zero tool schemas, complete R# rows, merged dossier, and 0-pick top selection', async () => {
    const { games, data } = build14GameSlateFixtures();
    const { fetchFn } = make14GameRpcFetch(games);
    const headers = parseGameHeaders(data);

    // renderHeaders never breaks a game line mid-word
    const tightRender = renderHeaders(headers, 120);
    for (const line of tightRender.split('\n').filter(Boolean)) {
      expect(line.startsWith('event_id=')).toBe(true);
    }
    expect(tightRender).not.toMatch(/\nevent$/);

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn, env }) },
    ]);

    const unifiedDossier = await fetchTwoHopSlateDossier(headers, registry, new GameQueryCache(), new SwarmContext(), { env, fetchFn });

    // Pick IDs belonging to 3 distinct games across the 14-game fixture: R11 (game 2), R38 (game 7), R41 (game 7) -> use game 2, 4, 7 so 3 distinct games
    // R11 = game 2 opt 5; R20 = game 4 opt 2; R41 = game 7 opt 5; let's include R11 (nba-401910026), R38 (nhl-401892760), R41 (nhl-401892760)
    const zeroPickAuditIds = selectTopPassAuditEventIds(unifiedDossier.entries, headers, 4);
    expect(zeroPickAuditIds.length).toBeGreaterThanOrEqual(3);
    expect(zeroPickAuditIds).toContain('nba-401910027');

    let observedCriticPrompt = '';
    let observedCriticSys = '';
    const critic = new Agent('Risk Critic', 'llama-3.3-70b-versatile', 'groq', 'gsk_mock');
    (critic as any).id = 'critic';
    const seenVisibility: any[] = [];

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string, _ctx?: any, opts?: any) {
      observedCriticPrompt = prompt;
      observedCriticSys = opts?.systemInstruction || (this as any).systemInstruction || '';
      return JSON.stringify({
        criticApproved: true,
        wageringPass: false,
        pass: true,
        verdict: 'Approved R11, R38, R41 after verifying dossier fundamentals, injuries, and steam.',
        flags: [],
      });
    });

    try {
      const executor = createAnalystExecutor({
        task: "what's the best parlay to place tonight?",
        userPrompt: "what's the best parlay to place tonight?",
        chunks: [data],
        profile: { totalChars: data.length, estimatedTokens: Math.ceil(data.length / 4) } as any,
        historicalContext: '',
        targetAppId: 'duelodds',
        settings: { agents: [] } as any,
        context: new SwarmContext(),
        toolRegistry: registry,
        analystClusterMap: new Map(),
        bypassCache: true,
        eventIds: games.map((g) => g.eventId),
        triageMode: 'two-hop',
        unifiedDossier,
        onSeatVisibility: (v) => seenVisibility.push(v),
      });

      await executor(
        critic,
        renderHeaders(headers, 8400),
        0,
        {
          proposedPicks: [
            { row: 'R11', event_id: 'nba-401910026', side: 'Minnesota Timberwolves' },
            { row: 'R38', event_id: 'nhl-401892760', side: 'Los Angeles Kings' },
            { row: 'R41', event_id: 'nhl-401892760', side: 'Over 6.5' },
          ],
          targetGameIds: ['nba-401910026', 'nhl-401892760'],
          summaryText: '- [Quant Proposer] R11 Minnesota Timberwolves / R38 Los Angeles Kings / R41 Over 6.5',
        },
      );

      expect(observedCriticSys).toBe(COMPACT_CRITIC_VERDICT_SYSTEM_INSTRUCTION);
      expect(observedCriticSys.length).toBeLessThanOrEqual(1200);
      expect(observedCriticSys.length + observedCriticPrompt.length).toBeLessThanOrEqual(seatBudget('groq').maxPromptChars);
      expect(observedCriticPrompt).toContain('R11');
      expect(observedCriticPrompt).toContain('R38');
      expect(observedCriticPrompt).toContain('R41');
      expect(observedCriticPrompt).toContain('Curated Matchup Dossier:');
      expect(observedCriticPrompt).not.toContain('...');
      const rIds = observedCriticPrompt.match(/\bR\d+\b/g) || [];
      expect(new Set(rIds).size).toBeGreaterThanOrEqual(12);
      expect(seenVisibility[0].rIdCount).toBeGreaterThanOrEqual(12);
      expect(seenVisibility[0].dossierChars).toBeGreaterThan(0);
    } finally {
      runSpy.mockRestore();
    }
  });

  it('P0-3: Full 14-game wf-1795307844843 fixture runs unified Hop 1 first, delivers full dossier to a1 & a2 with 84 R-IDs, and approves a 2-leg parlay', async () => {
    const { games, data } = build14GameSlateFixtures();
    const { fetchFn, rpcCallOrder } = make14GameRpcFetch(games);

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn, env }) },
    ]);

    const seatPrompts: Record<string, string> = {};
    let rpcCountBeforeFirstAgent = 0;

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      if (Object.keys(seatPrompts).length === 0) {
        rpcCountBeforeFirstAgent = rpcCallOrder.length;
      }
      const idOrRole = String((this as any).id || this.role || '').toLowerCase();
      seatPrompts[idOrRole] = prompt;

      if (idOrRole.includes('a1') || idOrRole.includes('quant')) {
        return JSON.stringify({
          analysis: 'R1 New Orleans Pelicans -4.5 (+8.4 net margin, 4-1 L5) and R7 Minnesota Timberwolves -6.5 (+9.2 net margin).',
          picks: [
            { row: 'R1', event_id: 'nba-401910027', side: 'New Orleans Pelicans -4.5', reason: 'L5 4-1 & +8.4 diff R1', reasonSource: 'R1' },
            { row: 'R7', event_id: 'nba-401910026', side: 'Minnesota Timberwolves -6.5', reason: 'L5 4-1 & +9.2 diff R7', reasonSource: 'R7' },
          ],
          scorecards: [],
        });
      }
      if (idOrRole.includes('a2') || idOrRole.includes('market')) {
        return JSON.stringify({
          analysis: 'R1 New Orleans Pelicans -4.5 and R7 Minnesota Timberwolves -6.5 both confirmed by home directional steam.',
          picks: [
            { row: 'R1', event_id: 'nba-401910027', side: 'New Orleans Pelicans -4.5', reason: 'Home steam R1', reasonSource: 'R1' },
            { row: 'R7', event_id: 'nba-401910026', side: 'Minnesota Timberwolves -6.5', reason: 'Home steam R7', reasonSource: 'R7' },
          ],
          scorecards: [],
        });
      }
      if (prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({ pass: true, feedback: 'Verified against unified dossier.' });
      }
      if (idOrRole.includes('critic') || idOrRole.includes('risk')) {
        return JSON.stringify({
          criticApproved: true,
          wageringPass: false,
          pass: true,
          verdict: 'Verified R1 New Orleans Pelicans -4.5 and R7 Minnesota Timberwolves -6.5: no fatal OUT on Pelicans/Wolves.',
          flags: [],
        });
      }
      return JSON.stringify({
        ui_title: '2-Leg NBA Parlay',
        summary: 'Bottom-line call: play 2-leg parlay New Orleans Pelicans -4.5 (R1) + Minnesota Timberwolves -6.5 (R7). Both teams have 2-of-3 pillar alignment (form + directional steam). Flip condition: star late scratch.',
        picks: [
          { row: 'R1', event_id: 'nba-401910027', side: 'New Orleans Pelicans -4.5', market: 'spread', line: -4.5, odds: -110, sportsbook: 'FanDuel', reason: 'R1 form + steam', reasonSource: 'R1' },
          { row: 'R7', event_id: 'nba-401910026', side: 'Minnesota Timberwolves -6.5', market: 'spread', line: -6.5, odds: -110, sportsbook: 'FanDuel', reason: 'R7 form + steam', reasonSource: 'R7' },
        ],
        criticApproved: true,
        wageringPass: false,
        components: [],
      });
    });

    try {
      const result = await executeSwarmWorkflow({
        task: "CHAT OBJECTIVE: USER PROMPT: what's the best parlay to place tonight?\nOperational Mode: PREGAME SLATE CHAT\nINJURY & PARLAY CALIBRATION: Pick a 2- to 3-leg parlay.\nPICK OUTPUT CONTRACT:\nReturn JSON.",
        userPrompt: "what's the best parlay to place tonight?",
        data,
        triageMode: 'two-hop',
        eventIds: games.map((g) => g.eventId),
        allowParlay: true,
        enableDeepAnalysis: true,
        forceFullSwarm: true,
        bypassCache: true,
        disableMemoryRetrieval: true,
        tools: registry,
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

      // Hop 1 ran all 14 * 3 = 42 tool calls BEFORE Hop 2 proposers
      expect(rpcCountBeforeFirstAgent).toBe(42);

      for (const seatKey of ['a1', 'a2']) {
        const prompt = seatPrompts[seatKey];
        expect(prompt).toBeDefined();
        expect(prompt).toContain('=== GAME DOSSIER: nba-401910027');
        expect(prompt).toContain('=== GAME DOSSIER: nba-401910026');
        expect(prompt).toContain('college-football-401860925');
        expect(prompt).toContain('Fundamentals:');
        expect(prompt).toContain('Injuries:');
        expect(prompt).toContain('Market:');
        expect(prompt).toContain('R84');
      }

      const dossier = result.curatedDossier;
      expect(dossier.markdown).toBeUndefined();
      expect(Array.isArray(dossier.seat_visibility)).toBe(true);

      const a1Vis = dossier.seat_visibility.find((v: any) => v.seat === 'a1');
      const a2Vis = dossier.seat_visibility.find((v: any) => v.seat === 'a2');
      const criticVis = dossier.seat_visibility.find((v: any) => v.seat === 'critic');

      expect(a1Vis).toMatchObject({ dossierTruncated: false, dossierSectionsIncluded: 14, rIdCount: 84 });
      expect(a1Vis.dossierChars).toBeGreaterThan(0);
      expect(a2Vis).toMatchObject({ dossierTruncated: false, dossierSectionsIncluded: 14, rIdCount: 84 });
      expect(a2Vis.dossierChars).toBeGreaterThan(0);
      expect(criticVis.rIdCount).toBeGreaterThanOrEqual(12);
      expect(criticVis.dossierChars).toBeGreaterThan(0);

      for (const trace of dossier.tool_call_trace) {
        expect('summary' in trace).toBe(false);
        expect(trace).toHaveProperty('sectionIndex');
      }

      expect(result.finalAnalysis?.criticApproved).toBe(true);
      expect(result.finalAnalysis?.wageringPass).toBe(false);
      expect(Array.isArray(result.finalAnalysis?.picks)).toBe(true);
      expect(result.finalAnalysis.picks.length).toBeGreaterThanOrEqual(2);
    } finally {
      runSpy.mockRestore();
    }
  }, 20000);

  it('P1-1: CFB snapshot get_matchup_fundamentals deduplicates BOIS/SDSU against full slugs with zero 0-0 last0 ghost keys', async () => {
    const cfbSnapshot = {
      source: 'snapshot',
      game_id: 'college-football-401860925',
      home_team_id: 'BOISE_STATE_BRONCOS',
      away_team_id: 'SAN_DIEGO_STATE_AZTECS',
      form: {
        items: [
          { team: 'BOIS', game_date: '2026-11-14', result: 'W' },
          { team: 'BOIS', game_date: '2026-11-07', result: 'W' },
          { team: 'SDSU', game_date: '2026-11-14', result: 'L' },
          { team: 'SDSU', game_date: '2026-11-07', result: 'W' },
        ],
      },
      h2h: [],
    };
    const fetchFn: any = async () => new Response(JSON.stringify(cfbSnapshot), { status: 200 });
    const res: any = await getMatchupFundamentalsTool.execute(
      { game_id: 'college-football-401860925', window: 'L5' },
      { fetchFn, env },
    );

    expect(res.summary).toContain('BOIS');
    expect(res.summary).toContain('SDSU');
    expect(res.summary).toContain('2-0');
    expect(res.summary).toContain('1-1');
    expect(res.summary).not.toContain('0-0 last0');
    expect(res.summary).not.toContain('BOISE_STATE_BRONCOS');
    expect(res.summary).not.toContain('SAN_DIEGO_STATE_AZTECS');
  });

  it('P2-1: get_market_movement emits honest Divergence: single_book on FanDuel-only slate and keeps explicit cross-book divergence', async () => {
    const singleBookFetch: any = async () =>
      new Response(
        JSON.stringify({
          book: 'fanduel',
          sport: 'basketball_nba',
          home_team: 'New Orleans Pelicans',
          away_team: 'Utah Jazz',
          books_tracked: 1,
          snapshots_tracked: 2,
          opening: { spread: -4.5, total: 226.5, ml_home: -185, ml_away: 155 },
          latest: { spread: -5.5, total: 226.5, ml_home: -210, ml_away: 175 },
        }),
        { status: 200 },
      );

    const singleRes: any = await getMarketMovementTool.execute(
      { game_id: 'nba-401910027', market_type: 'all' },
      { fetchFn: singleBookFetch, env },
    );
    expect(singleRes.summary).toContain('Divergence: single_book');
    expect(singleRes.summary).not.toContain('Divergence: none');

    const multiBookFetch: any = async () =>
      new Response(
        JSON.stringify({
          sport: 'basketball_nba',
          home_team: 'Boston Celtics',
          away_team: 'Sacramento Kings',
          books_tracked: 3,
          snapshots_tracked: 4,
          divergence: 'DraftKings -6.0 vs FanDuel -7.5',
          opening: { spread: -6.5, total: 224.5, ml_home: -250, ml_away: 205 },
          latest: { spread: -7.5, total: 224.5, ml_home: -280, ml_away: 225 },
        }),
        { status: 200 },
      );

    const multiRes: any = await getMarketMovementTool.execute(
      { game_id: 'nba-401910028', market_type: 'all' },
      { fetchFn: multiBookFetch, env },
    );
    expect(multiRes.summary).toContain('Divergence: DraftKings -6.0 vs FanDuel -7.5');
  });
});
