import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerAnalyzeRoutes } from './routes/analyze.ts';

function mockApp() {
  const app = new Hono();
  registerAnalyzeRoutes(app, {
    defaultSettings: { appId: 'duelodds' },
    defaultAi: undefined,
    defaultCortex: undefined,
    swarmBodyLimit: async (_c: any, next: any) => next()
  } as any);
  return app;
}

describe('slim-v1 /analyze + /stream', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://mock.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 's');
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
});
