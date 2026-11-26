import { describe, it, expect, vi } from 'vitest';
import {
  getInjuryAndRosterDeltaTool,
  scorePlayerGameLogStarterRow
} from '../swarm/tools/dueloddsRpcTools.ts';
import { syncCompilerProseWithFinalPicks } from '../swarm/tools/compilerProseSync.ts';

const env = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role'
};

describe('wf-1795647813045: 1-Game Fill-In Star Guard, Unlogged 0.5 Leak Fix & Summary Pick Count Sync', () => {
  it('S1.1: caps 1-game boxscore cameo (Yaxel Lendeborg, 31 min, 19 pts) at Tier-2 (1.5) and never emits Tier-1 Q', async () => {
    const logs = [
      {
        player_name: 'Yaxel Lendeborg',
        team_abbr: 'GSW',
        position: 'F',
        source: 'espn_boxscore',
        game_date: '2026-11-24',
        minutes: 31,
        points: 19
      }
    ];

    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(
          JSON.stringify({
            game_id: 'nba-401909324',
            sport: 'basketball_nba',
            home_team: 'Golden State Warriors',
            away_team: 'Phoenix Suns',
            injuries: [
              { team_name: 'Golden State Warriors', team_abbr: 'GSW', player_name: 'Yaxel Lendeborg', position: 'F', status: 'QUESTIONABLE' }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/rest/v1/player_game_logs')) {
        return new Response(JSON.stringify(logs), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });

    const res: any = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nba-401909324' },
      { fetchFn, env }
    );

    expect(res.success).toBe(true);
    expect(res.summary).not.toContain('Tier-1 Q');
    expect(res.summary).not.toContain('uncertain_questionable');
    const yaxel = res.data.injuries.find((i: any) => i.player_name === 'Yaxel Lendeborg');
    expect(yaxel).toBeDefined();
    expect(yaxel.impact_tier).toBe(2);
    expect(yaxel.impact_weight).toBe(1.5);
  });

  it('S1.2: thinly logged team (< 5 distinct game_dates) scores unlogged stars at 1.0 (unlogged), NEVER 0.5 (depth)', async () => {
    const logs = [
      {
        player_name: 'Aday Mara',
        team_abbr: 'OKC',
        position: 'C',
        source: 'espn_boxscore',
        game_date: '2026-11-24',
        minutes: 22,
        points: 10
      },
      {
        player_name: 'Anthony Edwards',
        team_abbr: 'MIN',
        position: 'G',
        source: 'espn_roster_meta',
        games_played: 0,
        experience_years: 6
      },
      {
        player_name: 'Donte DiVincenzo',
        team_abbr: 'MIN',
        position: 'G',
        source: 'espn_boxscore',
        game_date: '2026-11-24',
        minutes: 0,
        points: 0
      }
    ];

    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(
          JSON.stringify({
            game_id: 'nba-401909320',
            sport: 'basketball_nba',
            home_team: 'Oklahoma City Thunder',
            away_team: 'Minnesota Timberwolves',
            injuries: [
              { team_name: 'Oklahoma City Thunder', team_abbr: 'OKC', player_name: 'Aday Mara', position: 'C', status: 'OUT' },
              { team_name: 'Oklahoma City Thunder', team_abbr: 'OKC', player_name: 'Chet Holmgren', position: 'C', status: 'OUT' },
              { team_name: 'Oklahoma City Thunder', team_abbr: 'OKC', player_name: 'Jalen Williams', position: 'F', status: 'OUT' },
              { team_name: 'Minnesota Timberwolves', team_abbr: 'MIN', player_name: 'Anthony Edwards', position: 'G', status: 'OUT' },
              { team_name: 'Minnesota Timberwolves', team_abbr: 'MIN', player_name: 'Donte DiVincenzo', position: 'G', status: 'OUT' }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/rest/v1/player_game_logs')) {
        return new Response(JSON.stringify(logs), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });

    const res: any = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nba-401909320' },
      { fetchFn, env }
    );

    expect(res.success).toBe(true);
    expect(res.summary).not.toContain('depth');
    expect(res.summary).toContain('unlogged');
    for (const name of ['Chet Holmgren', 'Jalen Williams', 'Anthony Edwards', 'Donte DiVincenzo']) {
      const p = res.data.injuries.find((i: any) => i.player_name === name);
      expect(p, `Expected ${name} to be present`).toBeDefined();
      expect(p.impact_weight).toBe(1.0);
      expect(p.impact_role).toBe('unlogged');
    }
  });

  it('S1.3: NFL O-line espn_roster_meta (Kevin Zeitler, G, experience_years=14, gp=0) scores Tier-2 (1.5)', async () => {
    const unitScore = scorePlayerGameLogStarterRow(
      {
        player_name: 'Kevin Zeitler',
        position: 'G',
        source: 'espn_roster_meta',
        games_played: 0,
        stats: { experience_years: 14, games_played: 0 }
      },
      'americanfootball_nfl'
    );
    expect(unitScore).toMatchObject({ tier: 2, weight: 1.5, source: 'espn_roster_meta' });

    const logs = [
      {
        player_name: 'Kevin Zeitler',
        team_abbr: 'DET',
        position: 'G',
        source: 'espn_roster_meta',
        games_played: 0,
        stats: { experience_years: 14, games_played: 0 }
      },
      {
        player_name: 'Rookie Depth',
        team_abbr: 'DET',
        position: 'WR',
        source: 'espn_roster_meta',
        games_played: 0,
        stats: { experience_years: 0, games_played: 0 }
      },
      {
        player_name: 'Nhl Veteran',
        team_abbr: 'CHI',
        position: 'C',
        source: 'nhl_roster_meta',
        games_played: 0,
        stats: { experience_years: 5, games_played: 0 }
      }
    ];

    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('get_injury_and_roster_delta_v1')) {
        return new Response(
          JSON.stringify({
            game_id: 'nfl-401899999',
            sport: 'americanfootball_nfl',
            home_team: 'Detroit Lions',
            away_team: 'Chicago Bears',
            injuries: [
              { team_name: 'Detroit Lions', team_abbr: 'DET', player_name: 'Kevin Zeitler', position: 'G', status: 'OUT' },
              { team_name: 'Detroit Lions', team_abbr: 'DET', player_name: 'Rookie Depth', position: 'WR', status: 'OUT' },
              { team_name: 'Chicago Bears', team_abbr: 'CHI', player_name: 'Amon Backup', position: 'WR', status: 'OUT' }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/rest/v1/player_game_logs')) {
        return new Response(JSON.stringify(logs), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });

    const res: any = await (getInjuryAndRosterDeltaTool as any).execute(
      { game_id: 'nfl-401899999' },
      { fetchFn, env }
    );

    const zeitler = res.data.injuries.find((i: any) => i.player_name === 'Kevin Zeitler');
    const rookie = res.data.injuries.find((i: any) => i.player_name === 'Rookie Depth');
    expect(zeitler.impact_tier).toBe(2);
    expect(zeitler.impact_weight).toBe(1.5);
    expect(rookie.impact_tier).toBe(3);
    expect(rookie.impact_weight).toBe(0.5);
  });

  it('S2: reconciles stale summary "picks=3" to "picks=2" when compiled.picks has 2 legs', () => {
    const payload: any = {
      ui_title: '2-Leg NHL Parlay',
      summary: 'Bottom-line call: play R2 and R4. Key counts: games=20, covered=20, picks=3. The call flips if goalies change.',
      analysis: '2-leg parlay on R2 and R4. Key counts: games=20, covered=20, picks=3.',
      picks: [
        { row: 'R2', side: 'New York Islanders ML', market: 'ml' },
        { row: 'R4', side: 'Seattle Kraken ML', market: 'ml' }
      ],
      insights: [
        'R2 New York Islanders ML backed by home edge.',
        'R4 Seattle Kraken ML backed by 5v5 xGF% edge.'
      ]
    };

    const synced = syncCompilerProseWithFinalPicks(payload, { initialPicks: payload.picks });
    expect(synced.synced).toBe(true);
    expect(payload.summary).toContain('Key counts: games=20, covered=20, picks=2.');
    expect(payload.summary).not.toContain('picks=3');
    expect(payload.analysis).toContain('Key counts: games=20, covered=20, picks=2.');
  });
});
