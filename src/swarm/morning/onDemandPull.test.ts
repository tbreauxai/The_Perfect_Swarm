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

  it('enforces asOf cutoff on judged_at and snapshot_at and strips mutable result/brier/overwritten predictions in replay', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('game_judgments?')) {
        expect(u).toContain('judged_at=lte.2026-11-06T18%3A00%3A00.000Z');
        return new Response(
          JSON.stringify([
            {
              event_id: 'nfl-1',
              game_date: '2026-11-06',
              sport: 'americanfootball_nfl',
              home_team: 'KC',
              away_team: 'BUF',
              status: 'settled',
              win_prob_home: 0.62,
              fair_spread: -3.5,
              brier: 0.144,
              result: { outcome: 'win', home_score: 27, away_score: 24 },
              rejudge_count: 1,
              judged_at: '2026-11-06T17:00:00.000Z'
            },
            {
              event_id: 'nfl-1-postcutoff',
              game_date: '2026-11-06',
              sport: 'americanfootball_nfl',
              home_team: 'KC',
              away_team: 'BUF',
              status: 'active',
              win_prob_home: 0.99,
              judged_at: '2026-11-06T19:00:00.000Z'
            }
          ]),
          { status: 200 }
        );
      }
      if (u.includes('line_snapshots?')) {
        expect(u).toContain('snapshot_at=lte.2026-11-06T18%3A00%3A00.000Z');
        expect(u).toContain('game_date=eq.2026-11-06');
        expect(u).toContain('sport=eq.americanfootball_nfl');
        return new Response(
          JSON.stringify([
            {
              event_id: 'nfl-1',
              game_date: '2026-11-06',
              sport: 'americanfootball_nfl',
              book: 'fanduel',
              spread: -2.5,
              total: 48.5,
              ml_home: -140,
              ml_away: 120,
              snapshot_at: '2026-11-06T17:30:00.000Z',
              is_baseline: false
            },
            {
              event_id: 'nfl-1',
              game_date: '2026-11-06',
              sport: 'americanfootball_nfl',
              book: 'fanduel',
              spread: -6.5,
              total: 52.5,
              ml_home: -280,
              ml_away: 230,
              snapshot_at: '2026-11-06T18:30:00.000Z',
              is_baseline: false
            }
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    });

    const res = await fetchOnDemandSupabaseContext(
      cfg,
      {
        eventIds: ['nfl-1'],
        gameDate: '2026-11-06',
        sport: 'americanfootball_nfl',
        asOf: '2026-11-06T18:00:00.000Z'
      },
      fetchFn as any
    );

    expect(res.error).toBeUndefined();
    expect(res.judgments).toHaveLength(1);
    expect(res.judgments[0].event_id).toBe('nfl-1');
    expect(res.judgments[0].result).toBeUndefined();
    expect(res.judgments[0].brier).toBeUndefined();
    expect(res.judgments[0].win_prob_home).toBeUndefined();
    expect(res.judgments[0].fair_spread).toBeUndefined();
    expect(res.lineSnapshots).toHaveLength(1);
    expect(res.lineSnapshots[0].spread).toBe(-2.5);
    expect(res.formattedBlock).not.toContain('Brier=');
    expect(res.formattedBlock).not.toContain('Outcome=WIN');
  });
});
