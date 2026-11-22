import { describe, it, expect, vi } from 'vitest';
import {
  formatUnifiedPerGameDossier,
  evaluateQualitativePillars,
  type UnifiedGameDossierEntry,
} from '../swarm/engine/unifiedDossier.ts';
import { getMatchupFundamentalsTool, normalizeSportTeamAbbr } from '../swarm/tools/dueloddsRpcTools.ts';
import { seatBudget } from '../swarm/context/promptBudget.ts';

function makeEntry(
  eventId: string,
  matchup: string,
  sport: string,
  fundamentals: string,
  injuries: string,
  market: string,
): UnifiedGameDossierEntry {
  return {
    eventId,
    matchup,
    sport,
    fundamentals,
    injuries,
    market,
    hasDirectionalSteam: /Steam:\s*TOWARD/i.test(market),
    outCountDiff: 0,
    netMarginGap: 0,
  };
}

describe('wf-1795367633040 P1-1 & P1-2: Unbiased Pillar Ranking, Budget Fit, Sport-Scoped Abbrs & H2H Dedup', () => {
  it('P1-1: prepends TOP PILLAR CANDIDATES (QUALITATIVE), ranks multi-pillar games first without numeric EV/prob, and fits 20 games in both Nvidia & Cloudflare budgets', () => {
    const entries: UnifiedGameDossierEntry[] = [
      // Index 0: Hawks @ Pistons — symmetric injuries + contra-steam (must rank BELOW 3-pillar games)
      makeEntry(
        'nba-401910034',
        'Detroit Pistons @ Atlanta Hawks',
        'basketball_nba',
        '[MATCHUP FUNDAMENTALS: nba-401910034 (L10)] Home (ATL): W-L 5-5 | PF/PA 114.2 / 113.8 | Net Margin 0.4 | L5: 3-2 WLWWL | Away (DET): W-L 5-5 | PF/PA 112.9 / 113.1 | Net Margin -0.2 | L5: 2-3 LLWLW',
        '[INJURY & ROSTER DELTA: nba-401910034] Summary: Atlanta Hawks (5 OUT, 0 Q) vs Detroit Pistons (5 OUT, 0 Q) | Health Balance: symmetric\n- ATL: Trae Young: OUT; Player 2: OUT; Player 3: OUT; Player 4: OUT; Player 5: OUT\n- DET: Cade Cunningham: OUT; Player 2: OUT; Player 3: OUT; Player 4: OUT; Player 5: OUT',
        '[MARKET MOVEMENT: nba-401910034] Spread: Open -4.5 -> Latest -3.5 (-110/-110) | Steam: TOWARD Detroit Pistons | AGAINST Atlanta Hawks | Books Tracked: 2 | Divergence: slight_movement',
      ),
      // Index 1..15: 15 realistic neutral / single-pillar NBA, NHL, NFL games
      ...Array.from({ length: 15 }, (_, idx) =>
        makeEntry(
          idx % 3 === 0 ? `nba-4019100${10 + idx}` : idx % 3 === 1 ? `nhl-4018927${10 + idx}` : `nfl-4018730${10 + idx}`,
          `Away Team ${idx + 1} @ Home Team ${idx + 1}`,
          idx % 3 === 0 ? 'basketball_nba' : idx % 3 === 1 ? 'icehockey_nhl' : 'americanfootball_nfl',
          `[MATCHUP FUNDAMENTALS: gm-${idx}] Home (H${idx}): W-L 5-5 | PF/PA 110.0 / 109.5 | Net Margin 0.5 | L5: 3-2 WLWWL | Away (A${idx}): W-L 5-5 | PF/PA 108.5 / 109.0 | Net Margin -0.5 | L5: 2-3 LLWLW`,
          `Summary: Home Team ${idx + 1} (1 OUT, 1 Q) vs Away Team ${idx + 1} (1 OUT, 1 Q) | Health Balance: symmetric\n- H${idx}: Bench: OUT\n- A${idx}: Bench: OUT`,
          'Spread: Open -2.5 -> Latest -2.5 (-110/-110) | Steam: NEUTRAL | Books Tracked: 1 | Divergence: single_book',
        ),
      ),
      // Index 16: Hurricanes — 2 aligned pillars (form + health)
      makeEntry(
        'nhl-401892768',
        'Winnipeg Jets @ Carolina Hurricanes',
        'icehockey_nhl',
        'Home (CAR): W-L 8-2 | PF/PA 3.7 / 2.2 | Net Margin 1.5 | Season 14-4-1 (8-1 Home, Diff +1.6) | L5: 4-1 WWWLW | Away (WPG): W-L 4-6 | PF/PA 2.5 / 3.1 | Net Margin -0.6 | Season 9-9-1 (3-6 Away, Diff -0.5) | L5: 1-4 LLLWL',
        'Summary: Carolina Hurricanes (0 OUT, 0 Q) vs Winnipeg Jets (3 OUT, 0 Q) | Health Balance: home_advantage (Carolina Hurricanes)\n- WPG: Defenseman 1: OUT; Wing 1: OUT; Center 2: OUT',
        'Spread: Open -1.5 -> Latest -1.5 (-110/-110) | Steam: TOWARD Carolina Hurricanes | AGAINST Winnipeg Jets | Books Tracked: 2 | Divergence: multi_book_aligned',
      ),
      // Index 17: Nuggets — 3 aligned pillars (form=DEN, steam=TOWARD Denver Nuggets, health=away_advantage)
      makeEntry(
        'nba-401910032',
        'Denver Nuggets @ Chicago Bulls',
        'basketball_nba',
        '[MATCHUP FUNDAMENTALS: nba-401910032 (L10)] Home (CHI): W-L 3-7 | PF/PA 108.4 / 116.2 | Net Margin -7.8 | Season 7-13 (4-6 Home, Diff -5.9) | L5: 1-4 LLLWL | Away (DEN): W-L 8-2 | PF/PA 120.1 / 110.3 | Net Margin 9.8 | Season 16-4 (8-2 Away, Diff +8.4) | L5: 4-1 WWWLW',
        '[INJURY & ROSTER DELTA: nba-401910032] Summary: Chicago Bulls (3 OUT, 0 Q) vs Denver Nuggets (1 OUT, 0 Q) | Health Balance: away_advantage (Denver Nuggets)\n- CHI: Zach LaVine: OUT; Josh Giddey: OUT; Lonzo Ball: OUT\n- DEN: Bench Wing: OUT',
        '[MARKET MOVEMENT: nba-401910032] Spread: Open +4.5 -> Latest +5.5 (-110/-110) | Steam: TOWARD Denver Nuggets (-4.5 -> -5.5) | AGAINST Chicago Bulls | Books Tracked: 3 | Divergence: multi_book_aligned',
      ),
      // Index 18: Filler neutral NBA game
      makeEntry(
        'nba-401910035',
        'Charlotte Hornets @ Orlando Magic',
        'basketball_nba',
        'Home (ORL): W-L 5-5 | PF/PA 106.0 / 105.0 | Net Margin 1.0 | L5: 3-2 WLWWL | Away (CHA): W-L 4-6 | PF/PA 105.0 / 106.0 | Net Margin -1.0 | L5: 2-3 LWLLL',
        'Summary: Orlando Magic (2 OUT, 1 Q) vs Charlotte Hornets (2 OUT, 1 Q) | Health Balance: symmetric',
        'Spread: Open -3.5 -> Latest -3.5 | Steam: NEUTRAL | Books Tracked: 1 | Divergence: single_book',
      ),
      // Index 19 (LAST in input!): Blues — 3 aligned pillars (form=STL, steam=TOWARD STL, health=home_advantage)
      makeEntry(
        'nhl-401892770',
        'Buffalo Sabres @ St. Louis Blues',
        'icehockey_nhl',
        'Home (STL): W-L 7-3 | PF/PA 3.4 / 2.3 | Net Margin 1.1 | Season 12-6 (7-2 Home, Diff +1.2) | L5: 4-1 WWWWL | Away (BUF): W-L 3-7 | PF/PA 2.2 / 3.5 | Net Margin -1.3 | Season 6-12 (2-7 Away, Diff -1.4) | L5: 1-4 LLLLW',
        'Summary: St. Louis Blues (0 OUT, 0 Q) vs Buffalo Sabres (2 OUT, 0 Q) | Health Balance: home_advantage (St. Louis Blues)\n- BUF: Starting D: OUT; Top-6 Winger: OUT',
        'Spread: Open -1.5 -> Latest -1.5 (-125/+105) | Steam: TOWARD St. Louis Blues | AGAINST Buffalo Sabres | Books Tracked: 2 | Divergence: multi_book_aligned',
      ),
    ];

    expect(entries).toHaveLength(20);
    const denEval = evaluateQualitativePillars(entries[17]);
    expect(denEval.alignedPillarCount).toBe(3);
    expect(denEval.tags).toEqual(['form=DEN', 'steam=TOWARD Denver Nuggets', 'health=away_advantage']);

    const fullFormatted = formatUnifiedPerGameDossier(entries);
    expect(fullFormatted.text).toContain('=== TOP PILLAR CANDIDATES (QUALITATIVE) ===');
    // Rule 4 invariant: no numeric EV or implied probability leakage
    expect(fullFormatted.text).not.toMatch(/\b(?:ev|implied|trueWinProb|fairProb)\b/i);

    const headerSection = fullFormatted.text.split('=== GAME DOSSIER:')[0];
    expect(headerSection).toContain('nba-401910032');
    expect(headerSection).toContain('nhl-401892770');
    expect(headerSection).toContain('nhl-401892768');

    // Strong 3-pillar games (including nhl-401892770 which was LAST in raw input) must appear BEFORE nba-401910034
    const posDen = fullFormatted.text.indexOf('=== GAME DOSSIER: nba-401910032');
    const posStl = fullFormatted.text.indexOf('=== GAME DOSSIER: nhl-401892770');
    const posCar = fullFormatted.text.indexOf('=== GAME DOSSIER: nhl-401892768');
    const posAtl = fullFormatted.text.indexOf('=== GAME DOSSIER: nba-401910034');
    expect(posDen).toBeGreaterThan(-1);
    expect(posStl).toBeGreaterThan(-1);
    expect(posCar).toBeGreaterThan(-1);
    expect(posDen).toBeLessThan(posAtl);
    expect(posStl).toBeLessThan(posAtl);
    expect(posCar).toBeLessThan(posAtl);

    // Must fit all 20 games inside BOTH nvidia (a1) and cloudflare (a2) realistic dossier rooms with truncated: false
    const nvidiaRoom = seatBudget('nvidia').maxPromptChars - 9000;
    const cloudflareRoom = seatBudget('cloudflare').maxPromptChars - 8500;
    expect(cloudflareRoom).toBe(13500);

    const a1Out = formatUnifiedPerGameDossier(entries, nvidiaRoom);
    const a2Out = formatUnifiedPerGameDossier(entries, cloudflareRoom);
    expect(a1Out.sectionsIncluded).toBe(20);
    expect(a1Out.truncated).toBe(false);
    expect(a2Out.sectionsIncluded).toBe(20);
    expect(a2Out.truncated).toBe(false);
    expect(a2Out.text).toContain('=== GAME DOSSIER: nhl-401892770');
    expect(a2Out.text).toContain('Health Balance: away_advantage (Denver Nuggets)');
    expect(a2Out.text).toContain('Steam: TOWARD Denver Nuggets');
  });

  it('P1-1 & P1-2: sports-scopes NO vs NOP, omits redundant Recent when L5 is present, and deduplicates H2H rows', async () => {
    expect(normalizeSportTeamAbbr('NO', 'nfl-401873071')).toBe('NO');
    expect(normalizeSportTeamAbbr('NO', 'americanfootball_nfl')).toBe('NO');
    expect(normalizeSportTeamAbbr('NOP', 'nfl-401873071')).toBe('NO');
    expect(normalizeSportTeamAbbr('NO', 'nba-401910027')).toBe('NOP');
    expect(normalizeSportTeamAbbr('NO', 'basketball_nba')).toBe('NOP');
    expect(normalizeSportTeamAbbr('TB', 'americanfootball_nfl')).toBe('TB');
    expect(normalizeSportTeamAbbr('TB', 'icehockey_nhl')).toBe('TBL');

    const mockEnv = {
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon',
    };

    // 1. NFL Saints vs Panthers + L5 present -> Away (NO), never NOP, and Recent W,W,... omitted
    const nflFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nfl-401873071',
          source: 'team_games',
          window: 'L10',
          home: {
            team: 'CAR',
            wins: 5,
            losses: 5,
            points_for_avg: 21.4,
            points_against_avg: 22.0,
            net_margin: -0.6,
            recent_results: ['W', 'L', 'W', 'L', 'W', 'L', 'W', 'L', 'W', 'L'],
            last5_wins: 3,
            last5_losses: 2,
            last5_results: ['W', 'L', 'W', 'L', 'W'],
          },
          away: {
            team: 'NO',
            wins: 4,
            losses: 6,
            points_for_avg: 20.1,
            points_against_avg: 23.2,
            net_margin: -3.1,
            recent_results: ['L', 'W', 'L', 'L', 'W', 'L', 'W', 'L', 'L', 'W'],
            last5_wins: 2,
            last5_losses: 3,
            last5_results: ['L', 'W', 'L', 'L', 'W'],
          },
          h2h: [],
        }),
        { status: 200 },
      ),
    );
    const nflRes = await (getMatchupFundamentalsTool as any).execute(
      { game_id: 'nfl-401873071', window: 'L10' },
      { fetchFn: nflFetch as any, env: mockEnv },
    );
    expect(nflRes.success).toBe(true);
    expect(nflRes.summary).toContain('Away (NO):');
    expect(nflRes.summary).not.toContain('NOP');
    expect(nflRes.summary).toContain('L5: 3-2 WLWLW');
    expect(nflRes.summary).not.toContain('Recent ');

    // 2. NHL H2H duplicate perspectives (TB vs TBL + BUF) deduplicate to 1 row
    const nhlFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nhl-401892769',
          source: 'team_games',
          home: { team: 'TBL', wins: 6, losses: 4, points_for_avg: 3.4, points_against_avg: 2.7, net_margin: 0.7 },
          away: { team: 'BUF', wins: 4, losses: 6, points_for_avg: 2.8, points_against_avg: 3.3, net_margin: -0.5 },
          h2h: [
            { game_date: '2026-10-20', team_abbr: 'BUF', opponent_abbr: 'TB', team_score: 3, opponent_score: 8, result: 'L' },
            { game_date: '2026-10-20', team_abbr: 'BUF', opponent_abbr: 'TBL', team_score: 3, opponent_score: 8, result: 'L' },
            { game_date: '2026-10-20', team_abbr: 'TBL', opponent_abbr: 'BUF', team_score: 8, opponent_score: 3, result: 'W' },
          ],
        }),
        { status: 200 },
      ),
    );
    const nhlRes = await (getMatchupFundamentalsTool as any).execute(
      { game_id: 'nhl-401892769' },
      { fetchFn: nhlFetch as any, env: mockEnv },
    );
    expect(nhlRes.summary).toContain('H2H: 2026-10-20: TBL vs BUF 8-3 (W)');
    expect(nhlRes.summary).not.toContain('BUF vs TB 3-8');
    expect(nhlRes.summary).not.toContain('BUF vs TBL 3-8');

    // 3. NBA H2H duplicate perspectives (NY vs NYK + DET) deduplicate to 1 row
    const nbaFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          game_id: 'nba-401910034',
          source: 'team_games',
          home: { team: 'DET', wins: 6, losses: 4, points_for_avg: 114.0, points_against_avg: 110.0, net_margin: 4.0 },
          away: { team: 'NY', wins: 5, losses: 5, points_for_avg: 112.0, points_against_avg: 111.5, net_margin: 0.5 },
          h2h: [
            { game_date: '2026-10-28', team_abbr: 'NY', opponent_abbr: 'DET', team_score: 108, opponent_score: 115, result: 'L' },
            { game_date: '2026-10-28', team_abbr: 'NYK', opponent_abbr: 'DET', team_score: 108, opponent_score: 115, result: 'L' },
            { game_date: '2026-10-28', team_abbr: 'DET', opponent_abbr: 'NYK', team_score: 115, opponent_score: 108, result: 'W' },
          ],
        }),
        { status: 200 },
      ),
    );
    const nbaRes = await (getMatchupFundamentalsTool as any).execute(
      { game_id: 'nba-401910034' },
      { fetchFn: nbaFetch as any, env: mockEnv },
    );
    expect(nbaRes.summary).toContain('Away (NYK):');
    expect(nbaRes.summary).toContain('H2H: 2026-10-28: DET vs NYK 115-108 (W)');
    expect(nbaRes.summary).not.toContain('NY vs DET');
  });
});
