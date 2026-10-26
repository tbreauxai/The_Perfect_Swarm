import type { EspnLeagueConfig, SlateGame } from './types.ts';

export const ESPN_LEAGUES: readonly EspnLeagueConfig[] = [
  { sport: 'football', league: 'nfl', sportKey: 'americanfootball_nfl' },
  { sport: 'basketball', league: 'nba', sportKey: 'basketball_nba' },
  { sport: 'baseball', league: 'mlb', sportKey: 'baseball_mlb' },
  { sport: 'hockey', league: 'nhl', sportKey: 'icehockey_nhl' },
  { sport: 'basketball', league: 'wnba', sportKey: 'basketball_wnba' },
  { sport: 'football', league: 'college-football', sportKey: 'americanfootball_ncaaf' },
  { sport: 'basketball', league: 'mens-college-basketball', sportKey: 'basketball_ncaab' }
] as const;

/** From this America/Chicago hour on, the default slate is the NEXT day (the 10 PM CT morning cron judges tomorrow). */
export const NEXT_DAY_SLATE_HOUR_CT = 22;

/**
 * Returns the slate date as YYYY-MM-DD in America/Chicago: today, or tomorrow from 10 PM CT on.
 */
export function getDefaultSlateDate(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
    const day = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
    if (get('hour') >= NEXT_DAY_SLATE_HOUR_CT) day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().split('T')[0];
  } catch {
    return now.toISOString().split('T')[0];
  }
}

/**
 * Normalizes input date string into YYYY-MM-DD and ESPN YYYYMMDD string.
 */
export function sanitizeDateStrings(dateInput?: string): { gameDate: string; espnDate: string } {
  const raw = dateInput?.trim() || getDefaultSlateDate();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 8) {
    const yyyy = digits.slice(0, 4);
    const mm = digits.slice(4, 6);
    const dd = digits.slice(6, 8);
    return {
      gameDate: `${yyyy}-${mm}-${dd}`,
      espnDate: digits
    };
  }
  const parts = raw.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return {
      gameDate: raw,
      espnDate: `${parts[0]}${parts[1].padStart(2, '0')}${parts[2].padStart(2, '0')}`
    };
  }
  const fallback = getDefaultSlateDate();
  return {
    gameDate: fallback,
    espnDate: fallback.replace(/-/g, '')
  };
}

/**
 * Fetches games for a single league from the ESPN scoreboard API.
 */
export async function fetchLeagueScoreboard(
  cfg: EspnLeagueConfig,
  espnDate: string,
  gameDate: string,
  fetchFn: typeof fetch = fetch
): Promise<SlateGame[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/scoreboard?dates=${espnDate}`;
  try {
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ThePerfectSwarm/1.0',
        Accept: 'application/json'
      }
    });

    if (!res.ok) {
      return [];
    }

    const data: any = await res.json();
    const events: any[] = Array.isArray(data?.events) ? data.events : [];
    const games: SlateGame[] = [];

    for (const evt of events) {
      if (!evt?.id) continue;
      const competition = evt.competitions?.[0];
      if (!competition) continue;

      const competitors: any[] = competition.competitors || [];
      const homeComp = competitors.find((c: any) => c.homeAway === 'home');
      const awayComp = competitors.find((c: any) => c.homeAway === 'away');

      if (!homeComp || !awayComp) continue;

      const homeTeam = homeComp.team?.displayName || homeComp.team?.name || '';
      const awayTeam = awayComp.team?.displayName || awayComp.team?.name || '';

      if (!homeTeam || !awayTeam) continue;

      const commenceTime = evt.date || competition.date || new Date().toISOString();
      const eventId = String(evt.id).startsWith(`${cfg.league}-`) ? String(evt.id) : `${cfg.league}-${evt.id}`;

      // Weather snapshot if outdoor venue
      let weatherSnapshot: Record<string, any> | null = null;
      if (evt.weather) {
        weatherSnapshot = {
          displayValue: evt.weather.displayValue || null,
          temperature: evt.weather.temperature ?? null,
          conditionId: evt.weather.conditionId || null,
          highTemperature: evt.weather.highTemperature ?? null
        };
      }

      // Odds snapshot if available
      let oddsSnapshot: SlateGame['oddsSnapshot'] = null;
      const primaryOdds = competition.odds?.[0];
      if (primaryOdds) {
        oddsSnapshot = {
          provider: primaryOdds.provider?.name || 'ESPN/DraftKings',
          details: primaryOdds.details || null,
          overUnder: primaryOdds.overUnder != null ? Number(primaryOdds.overUnder) : null,
          spread: primaryOdds.spread != null ? Number(primaryOdds.spread) : null,
          awayMoneyLine: primaryOdds.awayMoneyLine != null ? Number(primaryOdds.awayMoneyLine) : null,
          homeMoneyLine: primaryOdds.homeMoneyLine != null ? Number(primaryOdds.homeMoneyLine) : null
        };
      }

      const isCompleted = Boolean(evt.status?.type?.completed);
      const homeScore = homeComp.score != null ? Number(homeComp.score) : undefined;
      const awayScore = awayComp.score != null ? Number(awayComp.score) : undefined;

      games.push({
        eventId,
        sport: cfg.sportKey,
        league: cfg.league,
        homeTeam,
        awayTeam,
        commenceTime,
        gameDate,
        weatherSnapshot,
        oddsSnapshot,
        rawEvent: {
          id: evt.id,
          completed: isCompleted,
          homeScore,
          awayScore,
          status: evt.status?.type?.name
        }
      });
    }

    return games;
  } catch (err) {
    return [];
  }
}

/**
 * Fetches the day's full slate across all configured ESPN leagues.
 */
export async function fetchDaySlate(
  dateInput?: string,
  fetchFn: typeof fetch = fetch
): Promise<{ gameDate: string; activeSports: string[]; games: SlateGame[] }> {
  const { gameDate, espnDate } = sanitizeDateStrings(dateInput);

  const results = await Promise.allSettled(
    ESPN_LEAGUES.map((cfg) => fetchLeagueScoreboard(cfg, espnDate, gameDate, fetchFn))
  );

  const allGames: SlateGame[] = [];
  const activeSportsSet = new Set<string>();

  results.forEach((res, index) => {
    if (res.status === 'fulfilled' && res.value.length > 0) {
      const cfg = ESPN_LEAGUES[index];
      activeSportsSet.add(cfg.sportKey);
      allGames.push(...res.value);
    }
  });

  allGames.sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());

  return {
    gameDate,
    activeSports: Array.from(activeSportsSet),
    games: allGames
  };
}
