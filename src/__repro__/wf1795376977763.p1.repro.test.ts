import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { executeSwarmWorkflow } from '../swarm/engine/index.ts';
import {
  getInjuryAndRosterDeltaTool,
  getMatchupFundamentalsTool,
  getMarketMovementTool,
} from '../swarm/tools/dueloddsRpcTools.ts';
import {
  extractFirstSentenceSafe,
  guardManagerResponse,
  splitSentencesSafe,
} from '../swarm/parser/responseGuards.ts';
import {
  resolveProposedPickEventIds,
  resolveSelectedGameIds,
} from '../swarm/context/selectedGames.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

const mockEnv = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

describe('wf-1795376977763 P1-1 & P1-2 Regressions (The_Perfect_Swarm)', () => {
  it('P1-1: extracts full opening sentence without splitting on St., Mt., P.J., vs., or spreads/decimals', () => {
    const wfAnalysis =
      'Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44). The consensus rests on +3.6pp implied steam toward St. Louis and Denver form. Call flips on late scratches.';

    expect(extractFirstSentenceSafe(wfAnalysis)).toBe(
      'Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44).',
    );

    const guarded = guardManagerResponse(
      JSON.stringify({
        ui_title: '2-Leg NBA/NHL Parlay',
        analysis: wfAnalysis,
        picks: [{ row: 'R63' }, { row: 'R44' }],
      }),
    );
    expect(guarded.summary).toBe(
      'Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44).',
    );

    const abbrProse =
      "Play Mt. St. Mary's +3.5 (No. 1 seed Ft. Worth vs. P.J. Washington Jr. & A.J. Brown, 0.85 confidence, 46.5 total, -10.5 spread). Secondary note follows.";
    const splitAbbr = splitSentencesSafe(abbrProse);
    expect(splitAbbr).toEqual([
      "Play Mt. St. Mary's +3.5 (No. 1 seed Ft. Worth vs. P.J. Washington Jr. & A.J. Brown, 0.85 confidence, 46.5 total, -10.5 spread).",
      'Secondary note follows.',
    ]);

    const otherTokens = splitSentencesSafe(
      'D.J. Moore and T.J. McConnell vs. B.J. Boston Sr. and Dr. Jekyll hold edge. Second sentence.',
    );
    expect(otherTokens).toHaveLength(2);
    expect(otherTokens[0]).toBe(
      'D.J. Moore and T.J. McConnell vs. B.J. Boston Sr. and Dr. Jekyll hold edge.',
    );

    // Non-abbreviation capital letters ending a sentence must still split cleanly
    expect(
      extractFirstSentenceSafe('Bottom-line call: proceed with Option B. Quant and Market disagreed on volatility.'),
    ).toBe('Bottom-line call: proceed with Option B.');
  });

  it('P1-2: scopes Groq Risk Critic coveredEventIds strictly to proposed pick eventIds with dossierTruncated === false', async () => {
    const slate = [
      'event_id=nba-401910033 | sport=basketball_nba | Dallas Mavericks @ Miami Heat | commence=2099-11-23T00:00:00Z | rows=R47:SPR Dallas Mavericks -2.5(-110),R48:SPR Miami Heat +2.5(-110),R67:TOT Over 224.5(-110),R87:ML Dallas Mavericks ML(-138),R88:ML Miami Heat ML(+118)',
      'event_id=nhl-401892770 | sport=icehockey_nhl | Edmonton Oilers @ St. Louis Blues | commence=2099-11-23T01:00:00Z | rows=R61:SPR St. Louis Blues -1.5(+185),R62:SPR Edmonton Oilers +1.5(-225),R63:ML St. Louis Blues ML(-126),R64:ML Edmonton Oilers ML(+106)',
      'event_id=nba-401910032 | sport=basketball_nba | Denver Nuggets @ Chicago Bulls | commence=2099-11-23T01:30:00Z | rows=R43:SPR Chicago Bulls +10.5(-114),R44:SPR Denver Nuggets -10.5(-106),R45:ML Chicago Bulls ML(+390),R46:ML Denver Nuggets ML(-520)',
      'event_id=nfl-401873075 | sport=americanfootball_nfl | Las Vegas Raiders @ Kansas City Chiefs | commence=2099-11-23T02:00:00Z | rows=R75:SPR Las Vegas Raiders +11.5(-110),R76:SPR Kansas City Chiefs -11.5(-110),R77:ML Las Vegas Raiders ML(+425),R78:ML Kansas City Chiefs ML(-590)',
    ].join('\n');

    const headers = parseGameHeaders(slate);
    const a1Report = {
      analysis: 'Proposing R87 Dallas Mavericks ML, R63 St. Louis Blues ML, and R44 Denver Nuggets -10.5 while passing on nfl-401873075 Las Vegas Raiders R75.',
      picks: [
        { row: 'R87', event_id: 'nba-401910033', side: 'Dallas Mavericks ML', reason: 'Stronger than Las Vegas Raiders nfl-401873075 R75' },
        { row: 'R63', event_id: 'nhl-401892770', side: 'St. Louis Blues ML', reason: 'Steam +3.6pp implied toward Blues' },
        { row: 'R44', event_id: 'nba-401910032', side: 'Denver Nuggets -10.5', reason: 'Net margin +9.2 edge' },
      ],
    };
    const a2Report = {
      analysis: 'Confirmed R63 St. Louis Blues ML and R67 Over 224.5; skipped nfl-401873075 Kansas City Chiefs vs Las Vegas Raiders.',
      picks: [
        { row: 'R63', event_id: 'nhl-401892770', side: 'St. Louis Blues ML', reason: 'Home steam R63' },
        { row: 'R67', event_id: 'nba-401910033', side: 'Over 224.5', reason: 'Pace edge R67' },
      ],
    };

    const allProposedPicks = [...a1Report.picks, ...a2Report.picks];
    expect(resolveProposedPickEventIds(allProposedPicks, headers)).toEqual([
      'nba-401910033',
      'nhl-401892770',
      'nba-401910032',
    ]);
    expect(resolveSelectedGameIds([a1Report, a2Report], headers)).toEqual([
      'nba-401910033',
      'nhl-401892770',
      'nba-401910032',
    ]);

    const rpcFetch = vi.fn(async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const gameId = String(body.p_game_id || '');
      if (url.includes('get_injury_and_roster_delta_v1')) {
        // Verbose multi-player injury payloads to stress-test Groq 1,500-token Critic dossier fitting
        return new Response(
          JSON.stringify({
            source: 'snapshot',
            game_id: gameId,
            home_team: 'Home Team',
            away_team: 'Away Team',
            injuries: Array.from({ length: 6 }, (_, i) => ({
              team_name: i < 2 ? 'Home Team' : 'Away Team',
              team_abbr: i < 2 ? 'HME' : 'AWY',
              player_name: `Verbose Player Name Number ${i + 1} (${gameId})`,
              position: 'G',
              status: 'OUT',
            })),
          }),
          { status: 200 },
        );
      }
      if (url.includes('get_matchup_fundamentals_v1')) {
        return new Response(
          JSON.stringify({
            source: 'team_games',
            game_id: gameId,
            home: { team: 'HME', wins: 4, losses: 1, points_for_avg: 115.4, points_against_avg: 106.2, net_margin: 9.2, recent_results: ['W', 'W', 'L', 'W', 'W'] },
            away: { team: 'AWY', wins: 2, losses: 3, points_for_avg: 107.1, points_against_avg: 112.0, net_margin: -4.9, recent_results: ['L', 'W', 'L', 'L', 'W'] },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          sport: 'basketball_nba',
          home_team: 'Home Team',
          away_team: 'Away Team',
          books_tracked: 2,
          snapshots_tracked: 4,
          opening: { spread: -8.5, ml_home: -111, ml_away: -108, total: 223.5 },
          latest: { spread: -10.5, ml_home: -126, ml_away: 106, total: 224.5 },
        }),
        { status: 200 },
      );
    });

    const registry = new ToolRegistry([
      { ...getMatchupFundamentalsTool, execute: (a: any, ctx?: any) => getMatchupFundamentalsTool.execute(a, { ...ctx, fetchFn: rpcFetch, env: mockEnv }) },
      { ...getInjuryAndRosterDeltaTool, execute: (a: any, ctx?: any) => getInjuryAndRosterDeltaTool.execute(a, { ...ctx, fetchFn: rpcFetch, env: mockEnv }) },
      { ...getMarketMovementTool, execute: (a: any, ctx?: any) => getMarketMovementTool.execute(a, { ...ctx, fetchFn: rpcFetch, env: mockEnv }) },
    ]);

    const runSpy = vi.spyOn(Agent.prototype, 'run').mockImplementation(async function (this: Agent, prompt: string) {
      const idOrRole = String((this as any).id || this.role || '').toLowerCase();
      if (idOrRole.includes('a1') || idOrRole.includes('quant')) {
        return JSON.stringify(a1Report);
      }
      if (idOrRole.includes('a2') || idOrRole.includes('market')) {
        return JSON.stringify(a2Report);
      }
      if (prompt.includes('OUTPUT CONTRACT (mandatory)')) {
        return JSON.stringify({ pass: true, feedback: 'Verified.' });
      }
      if (idOrRole.includes('critic') || idOrRole.includes('risk')) {
        return JSON.stringify({
          criticApproved: true,
          wageringPass: false,
          pass: true,
          verdict: 'Approved R63 St. Louis Blues ML and R44 Denver Nuggets -10.5; vetoed R87 Dallas Mavericks ML.',
          flags: [],
        });
      }
      return JSON.stringify({
        ui_title: '2-Leg Parlay: Blues ML + Nuggets -10.5',
        analysis:
          'Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44). Both legs align with steam and form.',
        picks: [
          { row: 'R63', event_id: 'nhl-401892770', side: 'St. Louis Blues ML', market: 'moneyline', odds: -126, sportsbook: 'FanDuel', reason: 'Steam R63', reasonSource: 'R63' },
          { row: 'R44', event_id: 'nba-401910032', side: 'Denver Nuggets -10.5', market: 'spread', line: -10.5, odds: -106, sportsbook: 'FanDuel', reason: 'Form R44', reasonSource: 'R44' },
        ],
        criticApproved: true,
        wageringPass: false,
        components: [],
      });
    });

    try {
      const result: any = await executeSwarmWorkflow({
        task: "CHAT OBJECTIVE: USER PROMPT: what's the best parlay to place today?\nOperational Mode: PREGAME SLATE CHAT\nPICK OUTPUT CONTRACT:\nReturn JSON.",
        userPrompt: "what's the best parlay to place today?",
        data: slate,
        triageMode: 'two-hop',
        eventIds: ['nba-401910033', 'nhl-401892770', 'nba-401910032', 'nfl-401873075'],
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
            { id: 'critic', role: 'Risk Critic', provider: 'groq', apiKey: 'gsk_mock', modelName: 'openai/gpt-oss-120b' },
            { id: 'manager', role: 'Manager Node', provider: 'gemini', apiKey: 'mock-gem', modelName: 'gemini-2.5' },
          ],
        } as any,
      } as any);

      const criticVis = result.curatedDossier?.seat_visibility?.find((s: any) => s.seat === 'critic');
      expect(criticVis).toBeDefined();
      expect(criticVis.coveredEventIds).toEqual([
        'nba-401910033',
        'nhl-401892770',
        'nba-401910032',
      ]);
      expect(criticVis.coveredEventIds).not.toContain('nfl-401873075');
      expect(criticVis.dossierSectionsIncluded).toBe(3);
      expect(criticVis.dossierTruncated).toBe(false);
    } finally {
      runSpy.mockRestore();
    }
  }, 20000);
});
