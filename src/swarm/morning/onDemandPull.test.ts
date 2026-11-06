import { describe, it, expect, vi } from 'vitest';
import { fetchOnDemandSupabaseContext } from './supabase.ts';

const cfg = { supabaseUrl: 'https://mock.supabase.co', supabaseServiceKey: 's' };

describe('fetchOnDemandSupabaseContext hardening', () => {
  it('refuses unfiltered pulls (no eventId/date/sport/team)', async () => {
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    const res = await fetchOnDemandSupabaseContext(cfg, { task: 'hello' }, fetchFn as any);
    expect(res.error).toBe('unfiltered_refused');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fail-closed when cfg missing and requireHits', async () => {
    const res = await fetchOnDemandSupabaseContext(null, {
      eventId: 'nfl-1',
      requireHits: true
    });
    expect(res.error).toBe('supabase_not_configured');
  });

  it('returns slim_pull_empty when requireHits and no rows', async () => {
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    const res = await fetchOnDemandSupabaseContext(
      cfg,
      { eventIds: ['nfl-1'], gameDate: '2026-11-06', sport: 'americanfootball_nfl', requireHits: true },
      fetchFn as any
    );
    expect(res.error).toBe('slim_pull_empty');
  });

  it('returns slim_pull_failed when PostgREST errors', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }));
    const res = await fetchOnDemandSupabaseContext(
      cfg,
      { eventId: 'nfl-1', requireHits: true },
      fetchFn as any
    );
    expect(res.error).toBe('slim_pull_failed');
  });

  it('multi-ID in filter pulls matching judgments', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('game_judgments?')) {
        expect(u).toContain('event_id=in.');
        return new Response(
          JSON.stringify([
            { event_id: 'nfl-1', game_date: '2026-11-06', sport: 'NFL', home_team: 'A', away_team: 'B', status: 'active' },
            { event_id: 'nfl-2', game_date: '2026-11-06', sport: 'NFL', home_team: 'C', away_team: 'D', status: 'active' }
          ]),
          { status: 200 }
        );
      }
      if (u.includes('line_snapshots?')) return new Response('[]', { status: 200 });
      throw new Error(`blocked ${u}`);
    });
    const res = await fetchOnDemandSupabaseContext(
      cfg,
      { eventIds: ['nfl-1', 'nfl-2'], gameDate: '2026-11-06', sport: 'americanfootball_nfl' },
      fetchFn as any
    );
    expect(res.error).toBeUndefined();
    expect(res.judgments).toHaveLength(2);
    expect(res.formattedBlock).toContain('nfl-1');
  });
});
