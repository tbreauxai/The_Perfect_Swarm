import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMarketMovementTool, getMatchupFundamentalsTool, getInjuryAndRosterDeltaTool } from '../swarm/tools/dueloddsRpcTools.ts';
import { buildVerifierEvidence } from '../swarm/engine/verifierEvidence.ts';
import {
  CRITIC_VERDICT_SYSTEM_INSTRUCTION,
  ANALYST_SYSTEM_INSTRUCTION,
} from '../swarm/engine/constants.ts';
import { seatBudget, assemblePrompt } from '../swarm/context/promptBudget.ts';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { Agent } from '../swarm/agent.ts';

const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon-key' };

describe('Flight Recorder Audit wf-1795298894431 — The_Perfect_Swarm Regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('P0-1: get_market_movement fires sport-aware directional steam, single_book_only divergence, zero (N/A), full team names, and preserves steam in verifierEvidence', async () => {
    const scenarios: Record<string, any> = {
      'college-football-401856865': {
        sport: 'americanfootball_ncaaf',
        away_team: 'Kansas State Wildcats',
        home_team: 'Utah Utes',
        books_tracked: 1,
        snapshots_tracked: 4,
        opening: { spread_home: -7.5, spread_away: 7.5, spread_home_price: -110, ml_home: -300, ml_away: 240, total: 54.5 },
        latest: { spread_home: -10.5, spread_away: 10.5, spread_home_price: -112, ml_home: -410, ml_away: 320, total: 54.5 },
      },
      'nba-401910024': {
        sport: 'basketball_nba',
        away_team: 'Portland Trail Blazers',
        home_team: 'New York Knicks',
        books_tracked: 1,
        snapshots_tracked: 6,
        opening: { spread_home: -5.5, spread_away: 5.5, ml_home: -210, ml_away: 175, total: 226.5 },
        latest: { spread_home: -3.5, spread_away: 3.5, ml_home: -154, ml_away: 130, total: 226.5 },
      },
      'nhl-401892758': {
        sport: 'icehockey_nhl',
        away_team: 'Boston Bruins',
        home_team: 'Columbus Blue Jackets',
        books_tracked: 1,
        snapshots_tracked: 5,
        opening: { ml_home: 100, ml_away: -120, total: 6.0 },
        latest: { ml_home: 114, ml_away: -134, total: 6.0 },
      },
      'college-football-401856870': {
        sport: 'americanfootball_ncaaf',
        away_team: 'Fresno State Bulldogs',
        home_team: 'San Jose State Spartans',
        books_tracked: 2,
        snapshots_tracked: 3,
        opening: { spread: -3.5, total: 52.5 },
        latest: { spread: -5.5, total: 53.0 },
      },
    };

    const fetchFn: any = async (_url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const payload = scenarios[body.p_game_id];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const cfbRes: any = await getMarketMovementTool.execute(
      { game_id: 'college-football-401856865', market_type: 'all' },
      { fetchFn, env },
    );
    expect(cfbRes.summary).toContain('Kansas State Wildcats');
    expect(cfbRes.summary).toContain('Utah Utes');
    expect(cfbRes.summary).toContain('Divergence: single_book');
    expect(cfbRes.summary).not.toContain('Steam: neutral');
    expect(cfbRes.summary).not.toContain('(N/A)');

    const nbaRes: any = await getMarketMovementTool.execute(
      { game_id: 'nba-401910024', market_type: 'all' },
      { fetchFn, env },
    );
    expect(nbaRes.summary).toContain('New York Knicks');
    expect(nbaRes.summary).toContain('TOWARD away Portland Trail Blazers (+5.5 -> +3.5, 2.0 pts) | AGAINST home New York Knicks (-5.5 -> -3.5)');
    expect(nbaRes.summary).toContain('Divergence: single_book');
    expect(nbaRes.summary).not.toContain('Steam: neutral');
    expect(nbaRes.summary).not.toContain('(N/A)');

    const nhlRes: any = await getMarketMovementTool.execute(
      { game_id: 'nhl-401892758', market_type: 'all' },
      { fetchFn, env },
    );
    expect(nhlRes.summary).toContain('away Boston Bruins ML (-120 -> -134');
    expect(nhlRes.summary).toContain('Divergence: single_book');
    expect(nhlRes.summary).not.toContain('Steam: neutral');
    expect(nhlRes.summary).not.toContain('(N/A)');

    const bareRes: any = await getMarketMovementTool.execute(
      { game_id: 'college-football-401856870', market_type: 'spread' },
      { fetchFn, env },
    );
    expect(bareRes.summary).toContain('Fresno State Bulldogs @ San Jose State Spartans');
    expect(bareRes.summary).toContain('Divergence: none');
    expect(bareRes.summary).not.toContain('(N/A)');

    const evidence = buildVerifierEvidence(
      [
        {
          toolEvidenceItems: [
            { tool: 'get_market_movement', eventId: 'nhl-401892758', summary: nhlRes.summary },
          ],
        },
      ],
      'Compact slate context',
    );
    expect(evidence).toContain('Steam: TOWARD away Boston Bruins ML');
    expect(evidence).toContain('single_book');
  });

  it('P0-3: calibrates Risk Critic & Analyst instructions within Groq 5600 budget and preserves model_signal headers', () => {
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('OUT');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('QUESTIONABLE');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('zero injuries');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).toContain('spread under 3.5');
    expect(CRITIC_VERDICT_SYSTEM_INSTRUCTION).not.toContain('Never propose');

    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('OUT');
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('QUESTIONABLE');
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('zero injuries');
    expect(ANALYST_SYSTEM_INSTRUCTION).toContain('spread under 3.5');

    const groqMax = seatBudget('groq').maxPromptChars;
    expect(groqMax).toBe(5600);
    const criticToolsSchema = JSON.stringify(
      new ToolRegistry([
        getMatchupFundamentalsTool,
        getMarketMovementTool,
        getInjuryAndRosterDeltaTool,
      ]).toOpenAiTools(),
    );
    const assembledCritic = assemblePrompt({
      systemInstruction: CRITIC_VERDICT_SYSTEM_INSTRUCTION,
      toolSchemas: criticToolsSchema,
      prompt: 'Audit R1 and R4 on nba-401910025 and college-football-401856865.',
    });
    expect(assembledCritic.length).toBeLessThan(groqMax);

    const parsed = parseGameHeaders(
      [
        'event_id=nba-401910025 | Los Angeles Clippers @ Dallas Mavericks | sp -3.5 | ml -160/+135 | tot 224.5 | model_signal=lean_home | rows=R1:SPR Dallas Mavericks -3.5(-110)',
        'event_id=nba-401910024 | Portland Trail Blazers @ New York Knicks | sp -5.5 | ml -210/+175 | tot 226.5 | model_signal=neutral | rows=R2:ML New York Knicks(-210)',
      ].join('\n'),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].modelSignal).toBe('lean_home');
    expect(parsed[1].modelSignal).toBe('neutral');

    const rendered = renderHeaders(parsed, 1600);
    expect(rendered).toContain('model_signal=lean_home');
    expect(rendered).not.toContain('model_signal=neutral');
  });

  it('P1-1: get_matchup_fundamentals returns BOTH BOS and SAC with L5 form, season record, splits, and diff for nba-401910028', async () => {
    const snapshotResponse = {
      source: 'snapshot',
      game_id: 'nba-401910028',
      home_team_abbr: 'BOS',
      away_team_abbr: 'SAC',
      home: {
        team: 'BOS',
        season_wins: 13,
        season_losses: 4,
        home_record: '7-2',
        season_net_margin: 8.4,
      },
      away: {
        team: 'SAC',
        season_wins: 6,
        season_losses: 10,
        away_record: '3-5',
        season_net_margin: -3.1,
      },
      form: {
        items: [
          { team: 'BOS', game_date: '2026-11-19', result: 'W' },
          { team: 'BOS', game_date: '2026-11-17', result: 'W' },
          { team: 'BOS', game_date: '2026-11-15', result: 'L' },
          { team: 'BOS', game_date: '2026-11-13', result: 'W' },
          { team: 'BOS', game_date: '2026-11-11', result: 'W' },
          { team: 'SAC', game_date: '2026-11-19', result: 'L' },
          { team: 'SAC', game_date: '2026-11-17', result: 'L' },
          { team: 'SAC', game_date: '2026-11-15', result: 'L' },
          { team: 'SAC', game_date: '2026-11-13', result: 'W' },
          { team: 'SAC', game_date: '2026-11-11', result: 'L' },
        ],
      },
      h2h: [],
    };

    const fetchSnapshot: any = async () =>
      new Response(JSON.stringify(snapshotResponse), { status: 200 });

    const snapRes: any = await getMatchupFundamentalsTool.execute(
      { game_id: 'nba-401910028', window: 'L5' },
      { fetchFn: fetchSnapshot, env },
    );
    expect(snapRes.summary).toContain('BOS 13-4 (7-2 Home, Diff +8.4) | L5: 4-1 WWLWW');
    expect(snapRes.summary).toContain('SAC 6-10 (3-5 Away, Diff -3.1) | L5: 1-4 LLLWL');

    const teamGamesResponse = {
      source: 'team_games',
      game_id: 'nba-401910028',
      home: {
        team: 'BOS',
        wins: 4,
        losses: 1,
        points_for_avg: 118.4,
        points_against_avg: 110.0,
        net_margin: 8.4,
        recent_results: ['W', 'W', 'L', 'W', 'W'],
        season_wins: 13,
        season_losses: 4,
        home_record: '7-2',
        season_net_margin: 8.4,
        last5_results: ['W', 'W', 'L', 'W', 'W'],
      },
      away: {
        team: 'SAC',
        wins: 1,
        losses: 4,
        points_for_avg: 109.2,
        points_against_avg: 112.3,
        net_margin: -3.1,
        recent_results: ['L', 'L', 'L', 'W', 'L'],
        season_wins: 6,
        season_losses: 10,
        away_record: '3-5',
        season_net_margin: -3.1,
        last5_results: ['L', 'L', 'L', 'W', 'L'],
      },
    };
    const fetchTeamGames: any = async () =>
      new Response(JSON.stringify(teamGamesResponse), { status: 200 });

    const tgRes: any = await getMatchupFundamentalsTool.execute(
      { game_id: 'nba-401910028', window: 'L5' },
      { fetchFn: fetchTeamGames, env },
    );
    expect(tgRes.summary).toContain('Home (BOS):');
    expect(tgRes.summary).toContain('Season 13-4 (7-2 Home, Diff +8.4) | L5: 4-1 WWLWW');
    expect(tgRes.summary).toContain('Away (SAC):');
    expect(tgRes.summary).toContain('Season 6-10 (3-5 Away, Diff -3.1) | L5: 1-4 LLLWL');
  });

  it('P2-2: two-hop slate curatedDossier keeps summary in sections only and strips summary from tool_call_trace', async () => {
    const fetchFn: any = vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gId = body.p_game_id;
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(JSON.stringify({ source: 'snapshot', game_id: gId, injuries: [] }), { status: 200 });
      }
      if (url.includes('get_matchup_fundamentals_v1')) {
        return new Response(
          JSON.stringify({
            source: 'team_games',
            home: { team: 'BOS', wins: 4, losses: 1, points_for_avg: 118, points_against_avg: 110, net_margin: 8.0, recent_results: ['W', 'W', 'L', 'W', 'W'] },
            away: { team: 'SAC', wins: 1, losses: 4, points_for_avg: 108, points_against_avg: 112, net_margin: -4.0, recent_results: ['L', 'L', 'L', 'W', 'L'] },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          sport: 'basketball_nba',
          home_team: 'Boston Celtics',
          away_team: 'Sacramento Kings',
          books_tracked: 1,
          snapshots_tracked: 3,
          opening: { spread_home: -6.5, ml_home: -240, ml_away: 195, total: 222.5 },
          latest: { spread_home: -8.0, ml_home: -300, ml_away: 245, total: 222.5 },
        }),
        { status: 200 },
      );
    });

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn, env }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn, env }) },
    ]);

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const role = (this.id || this.role || '').toLowerCase();
      if (role.includes('a1') || role.includes('quant')) {
        return JSON.stringify({
          analysis: 'R1 Boston Celtics -6.5 supported by net margin edge.',
          picks: [{ row: 'R1', event_id: 'nba-401910028', side: 'Boston Celtics -6.5', reason: 'L5 edge R1', reasonSource: 'R1' }],
          scorecards: [],
        });
      }
      if (role.includes('a2') || role.includes('market')) {
        return JSON.stringify({
          analysis: 'R1 Boston Celtics -6.5 confirmed by -1.5 pt home steam.',
          picks: [{ row: 'R1', event_id: 'nba-401910028', side: 'Boston Celtics -6.5', reason: 'Steam R1', reasonSource: 'R1' }],
          scorecards: [],
        });
      }
      if (role.includes('critic') || role.includes('risk') || prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        if (prompt.includes('OUTPUT CONTRACT (mandatory)')) {
          return JSON.stringify({ pass: true, feedback: 'Verified.' });
        }
        return JSON.stringify({ criticApproved: true, pass: true, verdict: 'approve', flags: [] });
      }
      return JSON.stringify({
        ui_title: 'BOS Spot',
        summary: 'Bottom-line call: play Boston Celtics -6.5 (R1). Both Quant and Market analysts aligned on net margin +8.0 and 1.5 pt spread move. Call flips only if Tatum ruled out.',
        picks: [{ row: 'R1', event_id: 'nba-401910028', side: 'Boston Celtics -6.5', market: 'spread', line: -6.5, odds: -110, sportsbook: 'FanDuel', reason: 'R1', reasonSource: 'R1' }],
        criticApproved: true,
        wageringPass: false,
        components: [],
      });
    });

    try {
      const result = await executeSwarmWorkflow({
        task: "CHAT OBJECTIVE: what's the best pick tonight?\nPICK OUTPUT CONTRACT:\nReturn JSON with analysis, picks, scorecards.",
        data: 'event_id=nba-401910028 | sport=basketball_nba | Sacramento Kings @ Boston Celtics | sp -6.5 | ml -240/+195 | tot 222.5 | model_signal=lean_home | rows=R1:SPR Boston Celtics -6.5(-110)',
        triageMode: 'two-hop',
        eventIds: ['nba-401910028'],
        enableDeepAnalysis: true,
        forceFullSwarm: true,
        bypassCache: true,
        disableMemoryRetrieval: true,
        tools: registry,
        settings: {
          openRouterApiKey: 'sk-or-v1-mock',
          groqApiKey: 'gsk_mock',
          agents: [
            { id: 'a1', role: 'Quant Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a1' },
            { id: 'a2', role: 'Market Proposer', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-a2' },
            { id: 'critic', role: 'Risk Critic', provider: 'groq', apiKey: 'gsk_mock', modelName: 'mock-critic' },
            { id: 'manager', role: 'Manager Node', provider: 'openrouter', apiKey: 'sk-or-v1-mock', modelName: 'mock-manager' },
          ],
        } as any,
      });

      const dossier = result.curatedDossier;
      expect(result.finalAnalysis?.criticApproved).toBe(true);
      expect(dossier).toBeDefined();
      expect(dossier.mode).toBe('two-hop-slate');
      expect(dossier.markdown).toBeUndefined();
      expect(Array.isArray(dossier.sections)).toBe(true);
      expect(dossier.sections.length).toBeGreaterThan(0);
      for (const sec of dossier.sections) {
        expect(typeof sec.summary).toBe('string');
        expect(sec.summary.length).toBeGreaterThan(0);
        expect(sec.tokenCost).toBeGreaterThan(0);
      }

      expect(Array.isArray(dossier.tool_call_trace)).toBe(true);
      expect(dossier.tool_call_trace.length).toBeGreaterThan(0);
      for (const trace of dossier.tool_call_trace) {
        expect('summary' in trace).toBe(false);
        expect(trace).toHaveProperty('tool');
        expect(trace).toHaveProperty('eventId');
        expect(trace).toHaveProperty('status');
        expect(trace).toHaveProperty('tokenCost');
        expect(trace).toHaveProperty('sectionIndex');
      }
    } finally {
      runSpy.mockRestore();
    }
  });
});
