import { describe, it, expect, vi } from 'vitest';
import {
  extractFirstSentenceSafe,
  splitSentencesSafe,
  stripApproximateOdds,
  sanitizeMoneylinePriceMoves,
  sanitizeCompilerProposalOddsAndSummary,
  guardAnalystResponse,
  guardManagerResponse,
} from '../swarm/parser/responseGuards.ts';
import {
  classifyInjuryHealthBalance,
  getInjuryAndRosterDeltaTool,
  getMarketMovementTool,
} from '../swarm/tools/dueloddsRpcTools.ts';
import { auditCriticPremiseContradictions } from '../swarm/tools/claimGrounding.ts';
import {
  auditMarketCoverageAndRowBinding,
  checkPickRowSideBinding,
  extractRowOptions,
} from '../swarm/tools/marketRowBinding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';
import { buildScopedUnifiedDossier } from '../swarm/engine/unifiedDossier.ts';
import { resolveMemoryGrounding } from '../swarm/engine/memoryGrounding.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { MANAGER_SYSTEM_INSTRUCTION } from '../swarm/engine/constants.ts';

describe('Engineering Spec Parts 7 + 8 (S1–S6) Acceptance Suite', () => {
  describe('S1: Abbreviation-safe Compiler summary sentence splitter', () => {
    it('preserves full first sentence with St. Louis Blues and -10.5 spread', () => {
      const text =
        'Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44). The consensus favors St. Louis on +3.6pp steam.';
      expect(extractFirstSentenceSafe(text)).toBe(
        'Bottom-line call: utilize a 2-leg parlay consisting of St. Louis Blues ML (R63) and Denver Nuggets -10.5 (R44).',
      );
    });

    it('preserves Mt. St. Mary\'s, P.J. Washington, vs., and -10.5 without mid-name splitting', () => {
      const text =
        "Back Mt. St. Mary's +3.5 vs. P.J. Washington and Ft. Worth (No. 4 seed, -10.5 spread, 46.5 total, 0.85 score). Second sentence here.";
      const sentences = splitSentencesSafe(text);
      expect(sentences).toEqual([
        "Back Mt. St. Mary's +3.5 vs. P.J. Washington and Ft. Worth (No. 4 seed, -10.5 spread, 46.5 total, 0.85 score).",
        'Second sentence here.',
      ]);
    });
  });

  describe('S2: Scoped Critic dossier fits <= 4 proposed games with dossierTruncated === false', () => {
    it('orders strictly by proposed pick eventIds and fits 4 verbose games under tight Groq budget', () => {
      const makeVerboseEntry = (eventId: string, matchup: string) => ({
        eventId,
        matchup,
        sport: 'basketball_nba',
        rows: 'R43:SPR Home +10.5(-114), R44:SPR Away -10.5(-106), R45:ML Home ML(+390), R46:ML Away ML(-520)',
        fundamentals:
          'Home (HME): W-L 4-1 | PF 115.4 | PA 106.2 | Net Margin +9.2 | L5: W,W,L,W,W | Away (AWY): W-L 2-3 | PF 107.1 | PA 112.0 | Net Margin -4.9 | L5: L,W,L,L,W',
        injuries:
          'Summary: Home Team (3 OUT [impact 9.0: Star One, Star Two, Star Three], 0 Q) vs Away Team (5 OUT [impact 4.5: Rot One, Rot Two + 3 depth], 0 Q) | Health Balance: away_advantage (Away Team, +4.5 impact edge) | - Home Team: Star One (F): OUT; Star Two (F): OUT; Star Three (C): OUT | - Away Team: Rot One (C): OUT; Rot Two (F): OUT; Bench One (G): OUT; Bench Two (F): OUT; Bench Three (G): OUT',
        market:
          'Open: -8.5 -> Current: -10.5 | Steam: TOWARD away Away Team (-8.5 -> -10.5, 2.0 pts) | AGAINST home Home Team (+8.5 -> +10.5) | Divergence: single_book [extended_move: verify remaining value]',
        hasDirectionalSteam: true,
        outCountDiff: 4.5,
        netMarginGap: 14.1,
      });

      const entries = [
        makeVerboseEntry('nfl-401873075', 'Las Vegas Raiders @ Kansas City Chiefs'),
        makeVerboseEntry('nba-401910033', 'Dallas Mavericks @ Utah Jazz'),
        makeVerboseEntry('nhl-401892770', 'Edmonton Oilers @ St. Louis Blues'),
        makeVerboseEntry('nba-401910032', 'Denver Nuggets @ Chicago Bulls'),
        makeVerboseEntry('nba-401910036', 'Oklahoma City Thunder @ Miami Heat'),
      ];

      // Strictly 3 proposed games (no nfl-401873075), tight Groq budget ~1,600 chars
      const scoped3 = buildScopedUnifiedDossier(
        entries,
        ['nba-401910033', 'nhl-401892770', 'nba-401910032'],
        1600,
      );
      expect(scoped3.truncated).toBe(false);
      expect(scoped3.sectionsIncluded).toBe(3);
      expect(scoped3.text).not.toContain('nfl-401873075');
      expect(scoped3.text.indexOf('nba-401910033')).toBeLessThan(scoped3.text.indexOf('nhl-401892770'));
      expect(scoped3.text.indexOf('nhl-401892770')).toBeLessThan(scoped3.text.indexOf('nba-401910032'));

      // 4 proposed games under tight Groq budget (~1,600 chars) also fits with truncated === false
      const scoped4 = buildScopedUnifiedDossier(
        entries,
        ['nba-401910033', 'nhl-401892770', 'nba-401910032', 'nba-401910036'],
        1600,
      );
      expect(scoped4.truncated).toBe(false);
      expect(scoped4.sectionsIncluded).toBe(4);
      expect(scoped4.text).not.toContain('nfl-401873075');
    });
  });

  describe('S3: Starter-weighted injury impact scoring & Risk Critic alignment', () => {
    it('classifies nba-401910033 Utah (3 Tier-1 OUT = 9.0) vs Dallas (2 Tier-2 + 3 Tier-3 OUT = 4.5) as away_advantage and avoids symmetric_injury_misread on Dallas', async () => {
      const playerGameLogs = [
        // Utah Tier-1 stars (>= 28 MPG + (>= 18 PPG or >= 28 PRA), or >= 31 MPG)
        { player_name: 'Lauri Markkanen', team_abbr: 'UTA', position: 'PF', minutes: 33.4, points: 23.8 },
        { player_name: 'Jaren Jackson Jr.', team_abbr: 'UTA', position: 'PF', minutes: 30.2, points: 21.5 },
        { player_name: 'Jusuf Nurkic', team_abbr: 'UTA', position: 'C', minutes: 28.5, points: 11.4, rebounds: 11.2, assists: 5.8 },
        // Dallas Tier-2 starters (15-27 MPG)
        { player_name: 'Dereck Lively II', team_abbr: 'DAL', position: 'C', minutes: 24.0, points: 9.2 },
        { player_name: 'P.J. Washington', team_abbr: 'DAL', position: 'PF', minutes: 26.5, points: 12.1 },
        // Dallas Tier-3 depth (< 12 MPG or unlogged)
        { player_name: 'Depth Guard One', team_abbr: 'DAL', position: 'G', minutes: 8.2, points: 2.1 },
        { player_name: 'Depth Wing Two', team_abbr: 'DAL', position: 'F', minutes: 6.0, points: 1.5 },
      ];

      const fetchFn = vi.fn(async (url: string) => {
        if (url.includes('get_injury_and_roster_delta_v1')) {
          return new Response(
            JSON.stringify({
              game_id: 'nba-401910033',
              sport: 'basketball_nba',
              home_team: 'Utah Jazz',
              away_team: 'Dallas Mavericks',
              injuries: [
                { team_name: 'Utah Jazz', team_abbr: 'UTA', player_name: 'Lauri Markkanen', position: 'PF', status: 'OUT' },
                { team_name: 'Utah Jazz', team_abbr: 'UTA', player_name: 'Jaren Jackson Jr.', position: 'PF', status: 'OUT' },
                { team_name: 'Utah Jazz', team_abbr: 'UTA', player_name: 'Jusuf Nurkic', position: 'C', status: 'OUT' },
                { team_name: 'Dallas Mavericks', team_abbr: 'DAL', player_name: 'Dereck Lively II', position: 'C', status: 'OUT' },
                { team_name: 'Dallas Mavericks', team_abbr: 'DAL', player_name: 'P.J. Washington', position: 'PF', status: 'OUT' },
                { team_name: 'Dallas Mavericks', team_abbr: 'DAL', player_name: 'Depth Guard One', position: 'G', status: 'OUT' },
                { team_name: 'Dallas Mavericks', team_abbr: 'DAL', player_name: 'Depth Wing Two', position: 'F', status: 'OUT' },
                { team_name: 'Dallas Mavericks', team_abbr: 'DAL', player_name: 'Unlogged Bench Three', position: 'G', status: 'OUT' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/rest/v1/player_game_logs')) {
          return new Response(JSON.stringify(playerGameLogs), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      });

      const res: any = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'nba-401910033' },
        {
          fetchFn,
          env: {
            SUPABASE_URL: 'https://mock.supabase.co',
            SUPABASE_ANON_KEY: 'mock-anon',
            SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role',
          },
        },
      );

      expect(res.success).toBe(true);
      expect(res.summary).toContain(
        'Summary: Utah Jazz (3 OUT [impact 9.0: Lauri Markkanen, Jaren Jackson Jr., Jusuf Nurkic], 0 Q) vs Dallas Mavericks (5 OUT [impact 4.5: Dereck Lively II, P.J. Washington + 3 depth], 0 Q) | Health Balance: away_advantage (Dallas Mavericks, +4.5 impact edge)',
      );

      // Risk Critic deterministic pre-check MUST NOT trigger symmetric_injury_misread on Dallas pick
      const slate =
        'event_id=nba-401910033 | sport=basketball_nba | Dallas Mavericks @ Utah Jazz | rows=R57:ML Dallas Mavericks ML(-134),R58:ML Utah Jazz ML(+114)';
      const headers = parseGameHeaders(slate);
      const dallasAudit = auditCriticPremiseContradictions(
        {
          picks: [
            {
              row: 'R57',
              event_id: 'nba-401910033',
              side: 'Dallas Mavericks ML',
              reason: 'Dallas holds a clear health advantage with Utah missing three core starters (Markkanen, Jaren Jackson Jr., Nurkic).',
            },
          ],
        },
        res.summary,
        slate,
        { headers },
      );
      expect(dallasAudit.flags).not.toContain('symmetric_injury_misread');

      // Conversely, picking Utah and claiming Dallas depletion SHOULD trigger symmetric_injury_misread
      const utahAudit = auditCriticPremiseContradictions(
        {
          picks: [
            {
              row: 'R58',
              event_id: 'nba-401910033',
              side: 'Utah Jazz ML',
              reason: 'Utah has the injury edge with Dallas missing five players.',
            },
          ],
        },
        res.summary,
        slate,
        { headers },
      );
      expect(utahAudit.flags).toContain('symmetric_injury_misread');
    });

    it('forces uncertain_questionable when a single QUESTIONABLE NFL QB1 or NHL starting goalie is listed', async () => {
      // NFL QB1 Questionable
      const nflFetch = vi.fn(async (url: string) => {
        if (url.includes('get_injury_and_roster_delta_v1')) {
          return new Response(
            JSON.stringify({
              game_id: 'nfl-401873075',
              sport: 'americanfootball_nfl',
              home_team: 'Kansas City Chiefs',
              away_team: 'Las Vegas Raiders',
              injuries: [
                { team_name: 'Kansas City Chiefs', team_abbr: 'KC', player_name: 'Patrick Mahomes', position: 'QB', status: 'QUESTIONABLE' },
                { team_name: 'Las Vegas Raiders', team_abbr: 'LV', player_name: 'Maxx Crosby', position: 'DE', status: 'OUT' },
                { team_name: 'Las Vegas Raiders', team_abbr: 'LV', player_name: 'Davante Adams', position: 'WR', status: 'OUT' },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify([
            { player_name: 'Patrick Mahomes', team_abbr: 'KC', position: 'QB', pass_attempts: 36, games_started: 1 },
            { player_name: 'Maxx Crosby', team_abbr: 'LV', position: 'DE', is_starter: true, snap_pct: 92 },
            { player_name: 'Davante Adams', team_abbr: 'LV', position: 'WR', is_starter: true, snap_pct: 88 },
          ]),
          { status: 200 },
        );
      });

      const nflRes: any = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'nfl-401873075' },
        {
          fetchFn: nflFetch,
          env: {
            SUPABASE_URL: 'https://mock.supabase.co',
            SUPABASE_ANON_KEY: 'mock-anon',
            SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role',
          },
        },
      );
      expect(nflRes.success).toBe(true);
      expect(nflRes.summary).toContain('Health Balance: uncertain_questionable (Kansas City Chiefs: Tier-1 Q Patrick Mahomes)');

      // NHL Starting Goaltender Questionable
      const nhlFetch = vi.fn(async (url: string) => {
        if (url.includes('get_injury_and_roster_delta_v1')) {
          return new Response(
            JSON.stringify({
              game_id: 'nhl-401892770',
              sport: 'icehockey_nhl',
              home_team: 'St. Louis Blues',
              away_team: 'Edmonton Oilers',
              injuries: [
                { team_name: 'St. Louis Blues', team_abbr: 'STL', player_name: 'Jordan Binnington', position: 'G', status: 'QUESTIONABLE' },
                { team_name: 'Edmonton Oilers', team_abbr: 'EDM', player_name: 'Leon Draisaitl', position: 'C', status: 'OUT' },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify([
            { player_name: 'Jordan Binnington', team_abbr: 'STL', position: 'G', games_started: 5, toi: '59:40' },
            { player_name: 'Leon Draisaitl', team_abbr: 'EDM', position: 'C', toi: '21:15', points: 8 },
          ]),
          { status: 200 },
        );
      });

      const nhlRes: any = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'nhl-401892770' },
        {
          fetchFn: nhlFetch,
          env: {
            SUPABASE_URL: 'https://mock.supabase.co',
            SUPABASE_ANON_KEY: 'mock-anon',
            SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role',
          },
        },
      );
      expect(nhlRes.success).toBe(true);
      expect(nhlRes.summary).toContain('Health Balance: uncertain_questionable (St. Louis Blues: Tier-1 Q Jordan Binnington)');
    });

    it('falls back gracefully without errors when player_game_logs is empty (e.g., NCAAF)', async () => {
      const ncaafFetch = vi.fn(async (url: string) => {
        if (url.includes('get_injury_and_roster_delta_v1')) {
          return new Response(
            JSON.stringify({
              game_id: 'college-football-401871101',
              sport: 'americanfootball_ncaaf',
              home_team: 'New Mexico Lobos',
              away_team: 'San Jose State Spartans',
              injuries: [
                { team_name: 'San Jose State Spartans', team_abbr: 'SJSU', player_name: 'Wide Receiver A', position: 'WR', status: 'OUT' },
                { team_name: 'San Jose State Spartans', team_abbr: 'SJSU', player_name: 'Linebacker B', position: 'LB', status: 'OUT' },
                { team_name: 'San Jose State Spartans', team_abbr: 'SJSU', player_name: 'Safety C', position: 'S', status: 'OUT' },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('[]', { status: 200 });
      });

      const res: any = await (getInjuryAndRosterDeltaTool as any).execute(
        { game_id: 'college-football-401871101' },
        {
          fetchFn: ncaafFetch,
          env: {
            SUPABASE_URL: 'https://mock.supabase.co',
            SUPABASE_ANON_KEY: 'mock-anon',
            SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role',
          },
        },
      );
      expect(res.success).toBe(true);
      expect(res.summary).toContain('Health Balance: home_advantage (New Mexico Lobos)');
    });

    it('supports conditional_*_advantage when weighted OUT impact gap >= 6.0 despite non-Tier-1 Q tags', () => {
      const cond = classifyInjuryHealthBalance({
        homeTeam: 'Miami Heat',
        awayTeam: 'Oklahoma City Thunder',
        homeOut: 0,
        homeQ: 2,
        awayOut: 3,
        awayQ: 0,
        sport: 'basketball_nba',
        gameId: 'nba-401910036',
        homeOutImpact: 0.0,
        awayOutImpact: 7.5,
        homeTier1Q: [],
        awayTier1Q: [],
        weightedMode: true,
      });
      expect(cond.balance).toBe('conditional_home_advantage');
      expect(cond.label).toContain('conditional_home_advantage');
      expect(cond.label).toContain('+7.5 impact edge');
    });
  });

  describe('S4: Extended single-book move tagging in get_market_movement', () => {
    const env = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock-anon' };

    it('appends [extended_move: verify remaining value] on 2.0-pt single-book NBA spread move (-8.5 -> -10.5)', async () => {
      const fetchFn = vi.fn(async () =>
        new Response(
          JSON.stringify({
            game_id: 'nba-401910032',
            sport: 'basketball_nba',
            home_team: 'Denver Nuggets',
            away_team: 'Chicago Bulls',
            book: 'fanduel',
            books_tracked: 1,
            snapshots_tracked: 3,
            opening: { spread_home: -8.5 },
            latest: { spread_home: -10.5 },
            spread_home: -10.5,
          }),
          { status: 200 },
        ),
      );
      const res: any = await (getMarketMovementTool as any).execute(
        { game_id: 'nba-401910032', market_type: 'spread' },
        { fetchFn, env },
      );
      expect(res.success).toBe(true);
      expect(res.summary).toContain('Steam: TOWARD home Denver Nuggets (-8.5 -> -10.5, 2.0 pts)');
      expect(res.summary).toContain('Divergence: single_book [extended_move: verify remaining value]');
    });

    it('does NOT append [extended_move] on 1.0-pt spread move or +3.6pp ML move, but DOES on >= 5.0pp single-book ML move', async () => {
      const fetchSmallSpread = vi.fn(async () =>
        new Response(
          JSON.stringify({
            game_id: 'nba-401910032',
            sport: 'basketball_nba',
            home_team: 'Denver Nuggets',
            away_team: 'Chicago Bulls',
            book: 'fanduel',
            books_tracked: 1,
            snapshots_tracked: 3,
            opening: { spread_home: -8.5 },
            latest: { spread_home: -9.5 },
            spread_home: -9.5,
          }),
          { status: 200 },
        ),
      );
      const smallSpreadRes: any = await (getMarketMovementTool as any).execute(
        { game_id: 'nba-401910032', market_type: 'spread' },
        { fetchFn: fetchSmallSpread, env },
      );
      expect(smallSpreadRes.summary).toContain('Divergence: single_book');
      expect(smallSpreadRes.summary).not.toContain('[extended_move: verify remaining value]');

      const fetchSmallMl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            game_id: 'nhl-401892770',
            sport: 'icehockey_nhl',
            home_team: 'St. Louis Blues',
            away_team: 'Edmonton Oilers',
            book: 'fanduel',
            books_tracked: 1,
            snapshots_tracked: 3,
            opening: { ml_home: -111, ml_away: 101 },
            latest: { ml_home: -126, ml_away: 105 },
          }),
          { status: 200 },
        ),
      );
      const smallMlRes: any = await (getMarketMovementTool as any).execute(
        { game_id: 'nhl-401892770', market_type: 'ml' },
        { fetchFn: fetchSmallMl, env },
      );
      expect(smallMlRes.summary).toContain('Steam: TOWARD home St. Louis Blues ML');
      expect(smallMlRes.summary).not.toContain('[extended_move: verify remaining value]');

      const fetchLargeMl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            game_id: 'nhl-401892770',
            sport: 'icehockey_nhl',
            home_team: 'St. Louis Blues',
            away_team: 'Edmonton Oilers',
            book: 'fanduel',
            books_tracked: 1,
            snapshots_tracked: 3,
            opening: { ml_home: -110, ml_away: -110 },
            latest: { ml_home: -145, ml_away: 122 },
          }),
          { status: 200 },
        ),
      );
      const largeMlRes: any = await (getMarketMovementTool as any).execute(
        { game_id: 'nhl-401892770', market_type: 'ml' },
        { fetchFn: fetchLargeMl, env },
      );
      expect(largeMlRes.summary).toContain('Steam: TOWARD home St. Louis Blues ML');
      expect(largeMlRes.summary).toContain('[extended_move: verify remaining value]');
    });
  });

  describe('S5: Two-hop Cortex pull disabled, non-destructive odds scrubber, and decimal spread parser', () => {
    it('two-hop Cortex retrieval returns zero [DUELODDS SUPABASE ON-DEMAND DATA PULL] or Line Snapshots blocks', async () => {
      const mockMemoryCortex: any = {
        retrieveWithContrastive: vi.fn(async () => ({
          memories: [],
          formattedExemplars: '',
          contrastive: { wins: [], losses: [] },
        })),
      };

      const res = await resolveMemoryGrounding({
        memoryCortex: mockMemoryCortex,
        task: 'Best parlay for today spread moneyline duelodds',
        data: '=== COMPACT SLATE ===\nevent_id=nba-401910032 | Denver Nuggets @ Chicago Bulls',
        targetAppId: 'duelodds',
        includeShared: false,
        bypassCache: true,
        toolRegistry: new ToolRegistry([]),
        context: new SwarmContext(),
        domain: 'sports_betting',
        triageMode: 'two-hop',
        curatedDossierActive: true,
      });

      expect(res.historicalContext).not.toContain('[DUELODDS SUPABASE ON-DEMAND DATA PULL]');
      expect(res.historicalContext).not.toContain('Line Snapshots (');
      expect(res.historicalContext).not.toContain('[DUELODDS SUPABASE ON-DEMAND]');
    });

    it('preserves numbered list items, decimal spreads, R# citations, and H2H scores (112-100) while stripping standalone odds cleanly', () => {
      const input = '1) STL ML (R43). 2) DEN -9.5 (R24). 3) DAL ML (R57): H2H win 112-100; steam (-111 -> -126, +4.1pp)';
      const cleaned = stripApproximateOdds(input);
      expect(cleaned).toContain('1) STL ML (R43).');
      expect(cleaned).toContain('2) DEN -9.5 (R24).');
      expect(cleaned).toContain('3) DAL ML (R57): H2H win 112-100');
      expect(cleaned).toContain('(+4.1pp)');
      expect(cleaned).not.toContain('(, +4.1pp)');
      expect(cleaned).not.toContain('-111');
      expect(cleaned).not.toContain('-126');

      const guarded = guardAnalystResponse(
        JSON.stringify({
          insights: [input],
          anomalies: [],
          summary: input,
          picks: [
            { row: 'R43', side: 'STL ML', reason: 'Steam (+4.1pp)' },
            { row: 'R24', side: 'Denver Nuggets -9.5', reason: '2) DEN -9.5 (R24) strong form' },
            { row: 'R57', side: 'DAL ML', reason: 'H2H win 112-100 over UTA' },
          ],
        }),
        'Quant Proposer',
      );
      expect(guarded.insights[0]).toContain('2) DEN -9.5 (R24)');
      expect(guarded.insights[0]).toContain('112-100');
      expect(guarded.picks?.[1]?.side).toBe('Denver Nuggets -9.5');
      expect(guarded.picks?.[2]?.reason).toContain('112-100');
    });

    it('passes row_side_mismatch cleanly for { row: "R24", side: "Denver Nuggets -9.5" } against SPR Denver Nuggets -9.5(-115)', () => {
      const slate =
        'event_id=nba-401910032 | sport=basketball_nba | Denver Nuggets @ Chicago Bulls | rows=R23:SPR Chicago Bulls +9.5(-105),R24:SPR Denver Nuggets -9.5(-115),R25:ML Chicago Bulls ML(+350),R26:ML Denver Nuggets ML(-460)';
      const headers = parseGameHeaders(slate);
      const rowMap = extractRowOptions([slate], headers);

      const singleCheck = checkPickRowSideBinding(
        { row: 'R24', side: 'Denver Nuggets -9.5', market: 'spread' },
        rowMap,
      );
      expect(singleCheck.valid).toBe(true);

      const audit = auditMarketCoverageAndRowBinding(
        {
          picks: [
            { row: 'R24', event_id: 'nba-401910032', side: 'Denver Nuggets -9.5', market: 'spread', reason: 'Form edge' },
          ],
        },
        'EVENT nba-401910032 | SPR Denver Nuggets -9.5(-115)',
        slate,
        headers,
      );
      expect(audit.pass).toBe(true);
      expect(audit.flags).not.toContain('row_side_mismatch');
      expect(audit.flags).not.toContain('spread_value_mismatch');
    });
  });

  describe('S6: Stop Compiler Rule-4 odds echoes (-111 to -126) & guarantee summary field', () => {
    it('includes prompt reminder in MANAGER_SYSTEM_INSTRUCTION', () => {
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain('(-111 to -126)');
      expect(MANAGER_SYSTEM_INSTRUCTION).toContain('favorable ML steam');
    });

    it('strips (-111 to -126) from picks.reasons and insights, preserves spreads/scores, populates summary, and passes Rule 4 on Attempt 1', async () => {
      expect(sanitizeMoneylinePriceMoves('Steam TOWARD STL ML (-111 to -126)')).toBe('Steam TOWARD STL ML');
      expect(sanitizeMoneylinePriceMoves('St. Louis Blues ML (-111 to -126)')).toBe('St. Louis Blues ML (favorable ML steam)');
      expect(sanitizeMoneylinePriceMoves('DEN -9.5 (R24) with H2H win 112-100')).toBe('DEN -9.5 (R24) with H2H win 112-100');

      const rawCompilerJson = {
        ui_title: 'Single Bet: St. Louis Blues ML',
        analysis:
          'Bottom-line call: play St. Louis Blues ML (R43) backed by favorable steam and 4-1 L5 form. Steam TOWARD STL ML (-111 to -126) aligns with Dallas 112-100 H2H.',
        picks: [
          {
            row: 'R43',
            event_id: 'nhl-401892770',
            side: 'St. Louis Blues ML',
            market: 'moneyline',
            reason: 'Steam TOWARD STL ML (-111 to -126)',
            reasons: ['Home 4-1 L5 form', 'Steam TOWARD STL ML (-111 to -126)'],
          },
        ],
        components: [
          {
            id: 'default-insight-list',
            type: 'InsightList',
            props: {
              title: 'Key Insights',
              insights: [
                { type: 'info', message: 'St. Louis Blues 4-1 L5' },
                { type: 'info', message: 'Steam TOWARD STL ML (-111 to -126)' },
              ],
            },
          },
        ],
      };

      // GuardManagerResponse handles both parsed.success (with valid components) and missing summary
      const guarded: any = guardManagerResponse(JSON.stringify(rawCompilerJson));
      expect(guarded.summary).toBe(
        'Bottom-line call: play St. Louis Blues ML (R43) backed by favorable steam and 4-1 L5 form.',
      );
      expect(guarded.picks[0].reason).not.toContain('-111');
      expect(guarded.picks[0].reasons[1]).not.toContain('-111');
      expect(guarded.components[0].props.insights[1].message).not.toContain('-111');
      expect(guarded.analysis).toContain('112-100');

      // AnalysisLifecycle normalizes BEFORE Verification Critic runs, so Rule 4 passes on Attempt 1
      let verifiedPromptText = '';
      const slate =
        'event_id=nhl-401892770 | sport=icehockey_nhl | Edmonton Oilers @ St. Louis Blues | rows=R43:ML St. Louis Blues ML(-126),R44:ML Edmonton Oilers ML(+106)';
      const proposer: any = {
        role: 'Manager',
        modelName: 'gemini-2.5',
        provider: 'gemini',
        run: vi.fn(async () => JSON.stringify(rawCompilerJson)),
      };
      const critic: any = {
        role: 'Risk Critic',
        modelName: 'llama-3.3',
        provider: 'groq',
        run: vi.fn(async (prompt: string) => {
          verifiedPromptText = prompt;
          const hasRule4Violation = /\(-111\s*(?:to|->)\s*-126\)/i.test(prompt);
          if (hasRule4Violation) {
            return JSON.stringify({ pass: false, feedback: 'Rule 4 violation: raw ML odds echoed' });
          }
          return JSON.stringify({ pass: true, feedback: 'Verified cleanly on Attempt 1.' });
        }),
      };

      const lifecycle = new AnalysisLifecycle(proposer, critic, 2);
      const res = await lifecycle.executeAndVerify(
        {
          fullBoard: slate,
          allHeaders: parseGameHeaders(slate),
          toolResults:
            '[MATCHUP FUNDAMENTALS: nhl-401892770] Home (STL): W-L 4-1 | [MARKET MOVEMENT: nhl-401892770 | ml] Steam: TOWARD home St. Louis Blues ML (-111 -> -126, +3.6pp implied)',
        },
        new SwarmContext(),
        'Compile final bet',
        'Verify Rule 4 compliance',
        ['nhl-401892770'],
      );

      expect(verifiedPromptText).not.toContain('(-111 to -126)');
      expect(res.success).toBe(true);
      expect(res.attempts).toBe(1);
      expect(res.finalProposal.summary).toBe(
        'Bottom-line call: play St. Louis Blues ML (R43) backed by favorable steam and 4-1 L5 form.',
      );
      expect(res.finalProposal.picks[0].reasons[1]).not.toContain('-111');
      expect(res.finalProposal.components[0].props.insights[1].message).not.toContain('-111');

      // Direct helper smoke check on an object without summary
      const direct = sanitizeCompilerProposalOddsAndSummary({
        analysis: 'Play St. Louis Blues ML (R43). Backup note.',
        picks: [{ row: 'R43', reasons: ['STL ML (-111 -> -126)'] }],
      });
      expect((direct as any).summary).toBe('Play St. Louis Blues ML (R43).');
      expect(direct.picks[0].reasons[0]).toBe('STL ML (favorable ML steam)');
    });
  });
});
