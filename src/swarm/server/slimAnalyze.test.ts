import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerAnalyzeRoutes } from './routes/analyze.ts';

function mockApp(customAi?: any) {
  const app = new Hono();
  registerAnalyzeRoutes(app, {
    defaultSettings: {
      appId: 'duelodds',
      agents: [
        {
          id: 'manager',
          name: 'Manager Node',
          role: 'Manager Node',
          active: true,
          provider: 'simulated',
          model: 'simulated-manager'
        },
        {
          id: 'analyst-1',
          name: 'Analyst 1',
          role: 'Analyst',
          active: true,
          provider: 'simulated',
          model: 'simulated-analyst'
        },
        {
          id: 'critic-1',
          name: 'Critic 1',
          role: 'Critic',
          active: true,
          provider: 'simulated',
          model: 'simulated-critic'
        },
        {
          id: 'judge-1',
          name: 'Judge 1',
          role: 'Judge',
          active: true,
          provider: 'simulated',
          model: 'simulated-judge'
        }
      ]
    },
    defaultAi: customAi,
    defaultCortex: undefined,
    swarmBodyLimit: async (_c: any, next: any) => next()
  } as any);
  return app;
}

function buildValidRpcRow(overrides: Record<string, any> = {}) {
  return {
    event_id: 'nfl-1',
    game_date: '2025-11-06',
    sport: 'americanfootball_nfl',
    status: 'ready',
    unavailable_reason: null,
    snapshot_id: '00000000-0000-4000-8000-000000000010',
    content_hash: 'a'.repeat(64),
    version: '42',
    schema_ver: 1,
    created_at: '2025-11-06T17:50:00.000Z',
    observed_at: '2025-11-06T17:52:00.000Z',
    decision_as_of: '2025-11-06T17:55:00.000Z',
    sections: {
      game: {
        event_id: 'nfl-1',
        sport: 'americanfootball_nfl',
        league: 'NFL',
        season: '2025',
        game_date: '2025-11-06',
        scheduled_start: '2025-11-06T20:15:00.000Z',
        status_at_capture: 'scheduled',
        home_team_id: 'KC',
        home_team: 'Kansas City Chiefs',
        away_team_id: 'BUF',
        away_team: 'Buffalo Bills',
        neutral_site: false
      },
      venue: {
        venue_id: 'v-arrowhead',
        name: 'Arrowhead Stadium',
        city: 'Kansas City',
        region: 'MO',
        country: 'USA',
        surface: 'grass',
        indoor: false,
        timezone: 'America/Chicago',
        altitude_m: 270
      },
      form: [
        {
          team_id: 'KC',
          event_id: 'nfl-prev-1',
          completed_at: '2025-10-30T23:00:00.000Z',
          opponent_id: 'LV',
          is_home: true,
          points_for: 27,
          points_against: 20,
          margin: 7,
          result: 'W',
          rest_days: 7
        }
      ],
      h2h: [
        {
          event_id: 'nfl-h2h-1',
          completed_at: '2024-12-10T23:00:00.000Z',
          home_team_id: 'KC',
          away_team_id: 'BUF',
          home_score: 24,
          away_score: 21,
          winner_team_id: 'KC',
          margin_home: 3,
          total_points: 45
        }
      ],
      injuries: [
        {
          team_id: 'BUF',
          player_id: 'p-1',
          player_name: 'Matt Milano',
          position: 'LB',
          status: 'questionable',
          reason: 'knee',
          reported_at: '2025-11-06T15:00:00.000Z'
        }
      ],
      weather: {
        condition: 'clear',
        temp_c: 12,
        wind_kph: 14,
        wind_dir: 'NW',
        precip_prob: 0.05,
        humidity_pct: 52,
        dome_closed: false
      },
      odds: [
        {
          book: 'fanduel',
          captured_at: '2025-11-06T17:50:00.000Z',
          is_opening: false,
          spread_home: -2.5,
          spread_away: 2.5,
          spread_price_home: -110,
          spread_price_away: -110,
          total: 48.5,
          over_price: -110,
          under_price: -110,
          ml_home: -140,
          ml_away: 120,
          draw_price: null
        }
      ]
    },
    source_status: {
      game: { status: 'ok', observed_at: '2025-11-06T17:50:00.000Z', source_ref: 'odds_api' },
      venue: { status: 'ok', observed_at: '2025-11-06T17:00:00.000Z', source_ref: 'espn' },
      form: { status: 'ok', observed_at: '2025-11-06T12:00:00.000Z', source_ref: 'espn' },
      h2h: { status: 'ok', observed_at: '2025-11-06T12:00:00.000Z', source_ref: 'espn' },
      injuries: { status: 'ok', observed_at: '2025-11-06T15:00:00.000Z', source_ref: 'nfl_inj' },
      weather: { status: 'ok', observed_at: '2025-11-06T17:00:00.000Z', source_ref: 'meteo' },
      odds: { status: 'ok', observed_at: '2025-11-06T17:50:00.000Z', source_ref: 'odds_api' }
    },
    ...overrides
  };
}

describe('slim-v1 /analyze + /stream', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://mock.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 's');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key');
    vi.stubEnv('GEMINI_API_KEY', 'AIzaSyTestGeminiKey1234567890');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('full body still requires task+data (backward compatible)', async () => {
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'x' })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Missing required parameter: task and data' });
  });

  it('422 slim_pull_empty when no rows (DuelOdds S.3 token)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 }))
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Judge nfl-1',
        date: '2026-11-06',
        eventIds: ['nfl-401547417'],
        sport: 'americanfootball_nfl'
      })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('slim_pull_empty');
    expect(body.payload).toBe('slim-v1');
  });

  it('422 slim_pull_failed when Supabase errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Judge',
        date: '2026-11-06',
        eventIds: ['nfl-1'],
        sport: 'americanfootball_nfl'
      })
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('slim_pull_failed');
  });

  it('stream POST slim multi-ID: 422 empty (Pages proxy will retry full)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const app = mockApp();
    const res = await app.request('/api/swarm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Board',
        date: '2026-11-06',
        eventIds: ['nfl-1', 'nfl-2'],
        sport: 'americanfootball_nfl'
      })
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('slim_pull_empty');
  });

  function partialCoverageFetch() {
    return vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('game_judgments?')) {
        return new Response(
          JSON.stringify([
            {
              event_id: 'nfl-1',
              game_date: '2026-11-06',
              sport: 'NFL',
              home_team: 'H',
              away_team: 'A',
              status: 'active',
              win_prob_home: 0.55
            }
          ]),
          { status: 200 }
        );
      }
      if (u.includes('line_snapshots?')) return new Response('[]', { status: 200 });
      return new Response('[]', { status: 200 });
    });
  }

  it('analyze partial multi-ID coverage → 422 slim_pull_empty (Pages full-board fallback)', async () => {
    vi.stubGlobal('fetch', partialCoverageFetch());
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Judge',
        date: '2026-11-06',
        eventIds: ['nfl-1', 'nfl-2'],
        sport: 'americanfootball_nfl'
      })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('slim_pull_empty');
    expect(body.payload).toBe('slim-v1');
  });

  it('stream partial multi-ID coverage → 422 slim_pull_empty (Pages full-board fallback)', async () => {
    vi.stubGlobal('fetch', partialCoverageFetch());
    const app = mockApp();
    const res = await app.request('/api/swarm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Board',
        date: '2026-11-06',
        eventIds: ['nfl-1', 'nfl-2'],
        sport: 'americanfootball_nfl'
      })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('slim_pull_empty');
    expect(body.payload).toBe('slim-v1');
  });

  it('parlay/bet-chat slim-v1 with missing, partial, or stale odds returns 422 slim_pull_failed with reason slim_context_ineligible', async () => {
    const staleRow = buildValidRpcRow();
    staleRow.sections.odds[0].captured_at = '2025-11-06T17:10:00.000Z'; // >15m older than asOf 18:00:00Z
    staleRow.source_status.odds.observed_at = '2025-11-06T17:10:00.000Z';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            schema_ver: 1,
            as_of: '2025-11-06T18:00:00.000Z',
            results: [staleRow]
          }),
          { status: 200 }
        )
      )
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Build 2-leg parlay',
        date: '2025-11-06',
        sport: 'americanfootball_nfl',
        eventIds: ['nfl-1'],
        retrievalContext: {
          version: 1,
          purpose: 'parlay',
          asOf: '2025-11-06T18:00:00.000Z',
          requiredContext: ['game', 'odds'],
          groups: [
            {
              sport: 'americanfootball_nfl',
              date: '2025-11-06',
              eventIds: ['nfl-1']
            }
          ]
        }
      })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'slim_pull_failed',
      payload: 'slim-v1',
      reason: 'slim_context_ineligible'
    });
  });

  it('bet-chat slim-v1 with complete ready snapshot succeeds and attaches context provenance', async () => {
    const readyRow = buildValidRpcRow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            schema_ver: 1,
            as_of: '2025-11-06T18:00:00.000Z',
            results: [readyRow]
          }),
          { status: 200 }
        )
      )
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Evaluate KC vs BUF',
        date: '2025-11-06',
        sport: 'americanfootball_nfl',
        eventIds: ['nfl-1'],
        settings: { disableMemoryRetrieval: true },
        retrievalContext: {
          version: 1,
          purpose: 'bet-chat',
          asOf: '2025-11-06T18:00:00.000Z',
          requiredContext: ['game', 'odds', 'form'],
          groups: [
            {
              sport: 'americanfootball_nfl',
              date: '2025-11-06',
              eventIds: ['nfl-1']
            }
          ]
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finalAnalysis).toBeDefined();
    if (body.finalAnalysis && typeof body.finalAnalysis === 'object') {
      expect(body.finalAnalysis.context_snapshot_id).toBe('00000000-0000-4000-8000-000000000010');
      expect(body.finalAnalysis.context_hash).toBe(readyRow.content_hash);
    }
  });

  it('full request with data + requiredContext returns 422 history_context_unavailable when required section is missing', async () => {
    const partialRow = buildValidRpcRow({
      status: 'partial'
    });
    partialRow.source_status.odds = {
      status: 'missing',
      observed_at: '2025-11-06T17:50:00.000Z',
      source_ref: 'odds_api'
    };
    partialRow.sections.odds = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            schema_ver: 1,
            as_of: '2025-11-06T18:00:00.000Z',
            results: [partialRow]
          }),
          { status: 200 }
        )
      )
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Analyze KC vs BUF',
        data: 'Full game board payload',
        retrievalContext: {
          version: 1,
          purpose: 'bet-chat',
          asOf: '2025-11-06T18:00:00.000Z',
          requiredContext: ['game', 'odds'],
          groups: [
            {
              sport: 'americanfootball_nfl',
              date: '2025-11-06',
              eventIds: ['nfl-1']
            }
          ]
        }
      })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('history_context_unavailable');
    expect(body.missingRequiredSections).toEqual({ 'nfl-1': ['odds'] });
  });

  it('full request with data + requiredContext returns 503 history_context_read_failed on store outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Gateway Timeout', { status: 504 }))
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Analyze KC vs BUF',
        data: 'Full game board payload',
        retrievalContext: {
          version: 1,
          purpose: 'bet-chat',
          asOf: '2025-11-06T18:00:00.000Z',
          requiredContext: ['game', 'odds'],
          groups: [
            {
              sport: 'americanfootball_nfl',
              date: '2025-11-06',
              eventIds: ['nfl-1']
            }
          ]
        }
      })
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('history_context_read_failed');
  });

  it('full request with data + optionalContext lessons never fails the run when store/Qdrant is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Service Unavailable', { status: 503 }))
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Analyze KC vs BUF with optional lessons',
        data: 'Primary full board data payload',
        settings: { disableMemoryRetrieval: true },
        retrievalContext: {
          version: 1,
          purpose: 'morning',
          asOf: '2025-11-06T18:00:00.000Z',
          optionalContext: ['lessons'],
          groups: [
            {
              sport: 'americanfootball_nfl',
              date: '2025-11-06',
              eventIds: ['nfl-1']
            }
          ]
        }
      })
    });
    expect(res.status).toBe(200);
  });

  it('multi-group parlay slim-v1 preserves per-group (sport, date, eventIds) across NFL and NBA', async () => {
    const nflRow = buildValidRpcRow({
      snapshot_id: '00000000-0000-4000-8000-000000000010',
      sport: 'americanfootball_nfl',
      game_date: '2025-11-06',
      event_id: 'nfl-1'
    });
    const nbaRow = buildValidRpcRow({
      snapshot_id: '00000000-0000-4000-8000-000000000020',
      sport: 'basketball_nba',
      game_date: '2025-11-07',
      event_id: 'nba-1'
    });
    nbaRow.sections.game.event_id = 'nba-1';
    nbaRow.sections.game.sport = 'basketball_nba';
    nbaRow.sections.game.game_date = '2025-11-07';

    const seenRpcBodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) {
          seenRpcBodies.push(JSON.parse(String(init.body)));
        }
        return new Response(
          JSON.stringify({
            schema_ver: 1,
            as_of: '2025-11-06T18:00:00.000Z',
            results: [nflRow, nbaRow]
          }),
          { status: 200 }
        );
      })
    );
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: 'slim-v1',
        task: 'Cross-sport parlay NFL + NBA',
        settings: { disableMemoryRetrieval: true },
        retrievalContext: {
          version: 1,
          purpose: 'parlay',
          asOf: '2025-11-06T18:00:00.000Z',
          requiredContext: ['game', 'odds'],
          groups: [
            { sport: 'americanfootball_nfl', date: '2025-11-06', eventIds: ['nfl-1'] },
            { sport: 'basketball_nba', date: '2025-11-07', eventIds: ['nba-1'] }
          ]
        }
      })
    });
    expect(res.status).toBe(200);
    expect(seenRpcBodies.length).toBeGreaterThanOrEqual(1);
    expect(seenRpcBodies[0].groups).toEqual([
      { sport: 'americanfootball_nfl', date: '2025-11-06', eventIds: ['nfl-1'] },
      { sport: 'basketball_nba', date: '2025-11-07', eventIds: ['nba-1'] }
    ]);
  });
});
