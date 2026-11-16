import { describe, it, expect, vi } from 'vitest';
import { fetchLeagueScoreboard } from './espnSlate.ts';

describe('fetchLeagueScoreboard moneyline parsing (S4)', () => {
  const cfg = { sportKey: 'NBA', sport: 'basketball', league: 'nba' };

  it('parses string moneyline.home/away.close.odds ("-360") and falls back to null when absent or NaN', async () => {
    const fetchFn: any = vi.fn(async () => new Response(JSON.stringify({
      events: [
        {
          id: '401909994',
          date: '2026-11-16T23:00Z',
          competitions: [{
            competitors: [
              { homeAway: 'home', team: { displayName: 'Boston Celtics' } },
              { homeAway: 'away', team: { displayName: 'Chicago Bulls' } }
            ],
            odds: [{
              provider: { name: 'DraftKings' },
              details: 'BOS -8.5',
              overUnder: 224.5,
              spread: -8.5,
              moneyline: {
                home: { close: { odds: '-360' } },
                away: { close: { odds: '+290' } }
              }
            }]
          }]
        },
        {
          id: '401909995',
          date: '2026-11-16T23:30Z',
          competitions: [{
            competitors: [
              { homeAway: 'home', team: { displayName: 'Miami Heat' } },
              { homeAway: 'away', team: { displayName: 'New York Knicks' } }
            ],
            odds: [{
              provider: { name: 'DraftKings' },
              awayMoneyLine: 135,
              homeMoneyLine: -155
            }]
          }]
        },
        {
          id: '401909996',
          date: '2026-11-17T00:00Z',
          competitions: [{
            competitors: [
              { homeAway: 'home', team: { displayName: 'Los Angeles Lakers' } },
              { homeAway: 'away', team: { displayName: 'Phoenix Suns' } }
            ],
            odds: [{
              provider: { name: 'DraftKings' },
              moneyline: { home: { close: { odds: 'OFF' } } }
            }]
          }]
        }
      ]
    }), { status: 200 }));

    const games = await fetchLeagueScoreboard(cfg, '20261116', '2026-11-16', fetchFn);
    expect(games).toHaveLength(3);
    expect(games[0].oddsSnapshot?.homeMoneyLine).toBe(-360);
    expect(games[0].oddsSnapshot?.awayMoneyLine).toBe(290);
    expect(games[1].oddsSnapshot?.homeMoneyLine).toBe(-155);
    expect(games[1].oddsSnapshot?.awayMoneyLine).toBe(135);
    expect(games[2].oddsSnapshot?.homeMoneyLine).toBeNull();
    expect(games[2].oddsSnapshot?.awayMoneyLine).toBeNull();
  });
});
