import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createSwarmServer } from './app.ts';
import {
  sanitizeDateStrings,
  getDefaultSlateDate,
  buildJudgePrompt,
  formatGameToColumnar,
  parseAndValidateJudgeOutput,
  computeModelSnapshot,
  partitionSlateGames,
  insertBaselineLineSnapshots,
  gradeAndRecordFinalGames,
  runMorningSlate,
  type SlateGame,
  type SupabaseConfig
} from '../morning/index.ts';
import { observationsForApp } from '../feedback/probabilityCalibration.ts';

describe('Morning Slate Engine - Unit & Integration Tests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Date Sanitation & Columnar Formatting', () => {
    it('generates valid Central Time default date', () => {
      const defaultDate = getDefaultSlateDate();
      expect(defaultDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('sanitizes various date formats', () => {
      const s1 = sanitizeDateStrings('2026-10-15');
      expect(s1.gameDate).toBe('2026-10-15');
      expect(s1.espnDate).toBe('20261015');

      const s2 = sanitizeDateStrings('20261015');
      expect(s2.gameDate).toBe('2026-10-15');
      expect(s2.espnDate).toBe('20261015');
    });

    it('formats game data into columnar string without prior verdict', () => {
      const mockGame: SlateGame = {
        eventId: 'nhl-401892506',
        sport: 'icehockey_nhl',
        league: 'nhl',
        homeTeam: 'Chicago Blackhawks',
        awayTeam: 'Detroit Red Wings',
        commenceTime: '2026-10-15T23:00:00Z',
        gameDate: '2026-10-15',
        weatherSnapshot: null,
        oddsSnapshot: {
          provider: 'DraftKings',
          details: 'CHI -1.5',
          overUnder: 6.0,
          spread: -1.5,
          homeMoneyLine: -130,
          awayMoneyLine: 110
        }
      };

      const columnar = formatGameToColumnar(mockGame);
      expect(columnar).toContain('#GAME:EVENT_ID|SPORT|MATCHUP|COMMENCE|WEATHER|POSTED_ODDS');
      expect(columnar).toContain('nhl-401892506');
      expect(columnar).toContain('Detroit Red Wings @ Chicago Blackhawks');
      expect(columnar).not.toContain('verdict');
      expect(columnar).not.toContain('prior');
    });

    it('builds judge prompt without prior verdict', () => {
      const mockGame: SlateGame = {
        eventId: 'nfl-401765432',
        sport: 'americanfootball_nfl',
        league: 'nfl',
        homeTeam: 'Kansas City Chiefs',
        awayTeam: 'Denver Broncos',
        commenceTime: '2026-10-15T18:00:00Z',
        gameDate: '2026-10-15',
        weatherSnapshot: { displayValue: 'Clear', temperature: 65 },
        oddsSnapshot: { details: 'KC -7.0', spread: -7.0, overUnder: 47.5 }
      };

      const prompt = buildJudgePrompt(mockGame);
      expect(prompt).toContain('Denver Broncos @ Kansas City Chiefs');
      expect(prompt).toContain('OUTPUT REQUIREMENT');
      expect(prompt).toContain('STRICT CONVENTIONS');
      expect(prompt).not.toContain('priorVerdict');
    });
  });

  describe('Judge Output Parsing & Model Snapshots', () => {
    it('parses valid judge JSON and clamps probabilities', () => {
      const rawJson = JSON.stringify({
        likelyWinner: 'Chicago Blackhawks',
        winProbHome: 0.62,
        winProbAway: 0.38,
        fairSpread: -1.5,
        fairTotal: 6.0,
        totalLean: 'over',
        arguments: [
          { claim: 'Strong home record', advocate: 'quant', weight: 'high' }
        ],
        invalidationConditions: ['Starting goalie scratch']
      });

      const parsed = parseAndValidateJudgeOutput(
        rawJson,
        'Chicago Blackhawks',
        'Detroit Red Wings',
        'icehockey_nhl',
        'wf-test-123'
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.likelyWinner).toBe('Chicago Blackhawks');
      expect(parsed?.winProbHome).toBe(0.62);
      expect(parsed?.winProbAway).toBe(0.38);
      expect(parsed?.fairSpread).toBe(-1.5);
      expect(parsed?.fairTotal).toBe(6.0);
      expect(parsed?.totalLean).toBe('over');
      expect(parsed?.workflowId).toBe('wf-test-123');
      expect(parsed?.arguments.length).toBe(1);
    });

    it('handles markdown fences in judge response', () => {
      const rawText = `Here is the verdict:
\`\`\`json
{
  "likelyWinner": "Detroit Red Wings",
  "winProbHome": 0.40,
  "winProbAway": 0.60,
  "fairSpread": 1.5,
  "fairTotal": 5.5,
  "totalLean": "under",
  "arguments": []
}
\`\`\``;

      const parsed = parseAndValidateJudgeOutput(
        rawText,
        'Chicago Blackhawks',
        'Detroit Red Wings',
        'icehockey_nhl',
        'wf-456'
      );

      expect(parsed).not.toBeNull();
      expect(parsed?.likelyWinner).toBe('Detroit Red Wings');
      expect(parsed?.winProbHome).toBe(0.40);
      expect(parsed?.fairSpread).toBe(1.5);
    });

    it('computes model snapshot correctly', () => {
      const mockGame: SlateGame = {
        eventId: 'nba-401584000',
        sport: 'basketball_nba',
        league: 'nba',
        homeTeam: 'Los Angeles Lakers',
        awayTeam: 'Boston Celtics',
        commenceTime: '2026-10-15T02:30:00Z',
        gameDate: '2026-10-15',
        weatherSnapshot: null,
        oddsSnapshot: { spread: -3.5, overUnder: 224.5 }
      };

      const snapshot = computeModelSnapshot(mockGame, 0.58);
      expect(snapshot.model_win_prob_home).toBe(0.58);
      expect(snapshot.projected_margin).toBe(3.5);
      expect(snapshot.projected_total).toBe(224.5);
      expect(snapshot.derived_from).toBe('swarm_analysis_composite');
    });
  });

  describe('Supabase Partitioning & Line Snapshots', () => {
    const mockCfg: SupabaseConfig = {
      supabaseUrl: 'https://mock.supabase.co',
      supabaseServiceKey: 'mock-key'
    };

    it('skips swarm judgments and replaces direct or null rows', async () => {
      const games: SlateGame[] = [
        {
          eventId: 'nfl-1',
          sport: 'americanfootball_nfl',
          league: 'nfl',
          homeTeam: 'Team A',
          awayTeam: 'Team B',
          commenceTime: '2026-10-15T18:00:00Z',
          gameDate: '2026-10-15',
          weatherSnapshot: null,
          oddsSnapshot: null
        },
        {
          eventId: 'nfl-2',
          sport: 'americanfootball_nfl',
          league: 'nfl',
          homeTeam: 'Team C',
          awayTeam: 'Team D',
          commenceTime: '2026-10-15T18:00:00Z',
          gameDate: '2026-10-15',
          weatherSnapshot: null,
          oddsSnapshot: null
        },
        {
          eventId: 'nfl-3',
          sport: 'americanfootball_nfl',
          league: 'nfl',
          homeTeam: 'Team E',
          awayTeam: 'Team F',
          commenceTime: '2026-10-15T18:00:00Z',
          gameDate: '2026-10-15',
          weatherSnapshot: null,
          oddsSnapshot: null
        }
      ];

      // Mock Supabase returning existing rows:
      // nfl-1: swarm (should be skipped)
      // nfl-2: direct (should be replaced)
      // nfl-3: not present (should be judged)
      const mockFetch: typeof fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('game_judgments?game_date=')) {
          return new Response(JSON.stringify([
            { event_id: 'nfl-1', judge_source: 'swarm', status: 'judged' },
            { event_id: 'nfl-2', judge_source: 'direct', status: 'judged' }
          ]), { status: 200 });
        }
        return new Response(null, { status: 200 });
      });

      const { gamesToJudge, gamesToReplace, skippedCount } = await partitionSlateGames(
        mockCfg,
        games,
        '2026-10-15',
        mockFetch
      );

      expect(skippedCount).toBe(1);
      expect(gamesToReplace.map(g => g.eventId)).toEqual(['nfl-2']);
      expect(gamesToJudge.map(g => g.eventId)).toEqual(['nfl-3']);
    });

    it('inserts baseline line snapshots and avoids game_id column', async () => {
      const games: SlateGame[] = [
        {
          eventId: 'mlb-100',
          sport: 'baseball_mlb',
          league: 'mlb',
          homeTeam: 'Yankees',
          awayTeam: 'Red Sox',
          commenceTime: '2026-10-15T18:00:00Z',
          gameDate: '2026-10-15',
          weatherSnapshot: null,
          oddsSnapshot: {
            provider: 'DraftKings',
            spread: -1.5,
            overUnder: 8.5,
            homeMoneyLine: -150,
            awayMoneyLine: 130
          }
        }
      ];

      const insertedBodies: any[] = [];
      const mockFetch: typeof fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('line_snapshots?event_id=') && init?.method === 'GET') {
          // No prior line snapshot exists
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes('line_snapshots') && init?.method === 'POST') {
          insertedBodies.push(JSON.parse(String(init.body)));
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 200 });
      });

      const count = await insertBaselineLineSnapshots(mockCfg, games, mockFetch);
      expect(count).toBe(1);
      expect(insertedBodies.length).toBe(1);

      const inserted = insertedBodies[0];
      expect(inserted.event_id).toBe('mlb-100');
      expect(inserted.market).toBe('all');
      expect(inserted.is_baseline).toBe(true);
      expect(inserted.game_date).toBe('2026-10-15');
      expect(inserted.spread).toBe(-1.5);
      expect(inserted.total).toBe(8.5);
      expect(inserted.ml_home).toBe(-150);
      expect(inserted.ml_away).toBe(130);
      expect(inserted).not.toHaveProperty('game_id');
    });

    it('skips line snapshot if identical line exists', async () => {
      const games: SlateGame[] = [
        {
          eventId: 'mlb-101',
          sport: 'baseball_mlb',
          league: 'mlb',
          homeTeam: 'Dodgers',
          awayTeam: 'Giants',
          commenceTime: '2026-10-15T18:00:00Z',
          gameDate: '2026-10-15',
          weatherSnapshot: null,
          oddsSnapshot: {
            provider: 'DraftKings',
            spread: -1.5,
            overUnder: 8.0,
            homeMoneyLine: -140,
            awayMoneyLine: 120
          }
        }
      ];

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('line_snapshots?event_id=') && init?.method === 'GET') {
          // Exactly matching line exists
          return new Response(JSON.stringify([{
            spread: -1.5,
            total: 8.0,
            ml_home: -140,
            ml_away: 120
          }]), { status: 200 });
        }
        return new Response(null, { status: 200 });
      });

      const count = await insertBaselineLineSnapshots(mockCfg, games, mockFetch);
      expect(count).toBe(0);
    });
  });

  describe('Final Game Settlement & Calibration Feedback', () => {
    it('records probability observation with win_prob_home and appId duelodds', async () => {
      const mockCfg: SupabaseConfig = {
        supabaseUrl: 'https://mock.supabase.co',
        supabaseServiceKey: 'mock-key'
      };

      const games: SlateGame[] = [
        {
          eventId: 'nhl-final-1',
          sport: 'icehockey_nhl',
          league: 'nhl',
          homeTeam: 'Avalanche',
          awayTeam: 'Stars',
          commenceTime: '2026-10-15T01:00:00Z',
          gameDate: '2026-10-15',
          weatherSnapshot: null,
          oddsSnapshot: null,
          rawEvent: {
            completed: true,
            homeScore: 4,
            awayScore: 2
          }
        }
      ];

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('game_judgments?game_date=') && init?.method === 'GET') {
          return new Response(JSON.stringify([{
            event_id: 'nhl-final-1',
            workflow_id: 'wf-learn-999',
            win_prob_home: 0.65,
            sport: 'icehockey_nhl',
            home_team: 'Avalanche',
            away_team: 'Stars'
          }]), { status: 200 });
        }
        if (url.includes('game_judgments?') && init?.method === 'PATCH') {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 200 });
      });

      const settled = await gradeAndRecordFinalGames(mockCfg, games, '2026-10-15', mockFetch);
      expect(settled.length).toBe(1);
      expect(settled[0].outcome).toBe('win');
      expect(settled[0].workflowId).toBe('wf-learn-999');
      expect(settled[0].winProbHome).toBe(0.65);

      const duelObs = observationsForApp('duelodds');
      const found = duelObs.find(o => o.workflowId === 'wf-learn-999');
      expect(found).toBeDefined();
      expect(found?.predictedProbability).toBe(0.65);
      expect(found?.outcome).toBe(1.0);
    });
  });

  describe('POST /api/swarm/morning Route Endpoint', () => {
    let app: any;

    beforeEach(() => {
      const baseApp = createSwarmServer({
        defaultSettings: { appId: 'duelodds' }
      });

      app = new Hono();
      app.use('*', async (c: any, next: any) => {
        c.set('callerAppId', 'duelodds');
        c.env = {
          SWARM_APP_TOKENS: 'duelodds:test-token-123',
          SWARM_AUTH_REQUIRED: 'true'
        };
        await next();
      });
      app.route('/', baseApp);
    });

    it('returns structured batch output without direct fallback', async () => {
      const req = new Request('http://localhost/api/swarm/morning', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-123'
        },
        body: JSON.stringify({ date: '2026-10-15' })
      });

      // Mock fetch for ESPN and Supabase
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('apis/site/v2/sports/')) {
          return new Response(JSON.stringify({ events: [] }), { status: 200 });
        }
        return new Response(null, { status: 200 });
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json).toHaveProperty('ok', true);
      expect(json).toHaveProperty('gameDate', '2026-10-15');
      expect(json).toHaveProperty('judged', 0);
      expect(json).toHaveProperty('replaced', 0);
      expect(json).toHaveProperty('skipped', 0);
      expect(json).toHaveProperty('snapshots', 0);
      expect(json).toHaveProperty('errors');
      expect(Array.isArray(json.errors)).toBe(true);
    });

    it('records error and avoids direct fallback when swarm analysis fails', async () => {
      const mockGame: SlateGame = {
        eventId: 'nfl-fail-1',
        sport: 'americanfootball_nfl',
        league: 'nfl',
        homeTeam: 'Cowboys',
        awayTeam: 'Eagles',
        commenceTime: '2026-10-15T18:00:00Z',
        gameDate: '2026-10-15',
        weatherSnapshot: null,
        oddsSnapshot: { details: 'DAL -3.0', spread: -3.0, overUnder: 48.0 }
      };

      const failingExecuteWorkflow = vi.fn().mockRejectedValue(new Error('Swarm provider 429 rate limit'));

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('/sports/football/nfl/')) {
          return new Response(JSON.stringify({
            events: [{
              id: 'fail-1',
              date: '2026-10-15T18:00:00Z',
              competitions: [{
                competitors: [
                  { homeAway: 'home', team: { displayName: 'Cowboys' } },
                  { homeAway: 'away', team: { displayName: 'Eagles' } }
                ],
                odds: [{ details: 'DAL -3.0', spread: -3.0, overUnder: 48.0 }]
              }]
            }]
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      });

      const result = await runMorningSlate({
        dateInput: '2026-10-15',
        fetchFn: mockFetch,
        executeWorkflowFn: failingExecuteWorkflow
      });

      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].eventId).toBe('nfl-fail-1');
      expect(result.errors[0].error).toContain('Swarm provider 429 rate limit');
      expect(result.judged).toBe(0);
      expect(result.replaced).toBe(0);
    });
  });
});
