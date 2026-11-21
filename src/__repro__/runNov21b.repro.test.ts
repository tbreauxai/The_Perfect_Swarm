import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMatchupFundamentalsTool } from '../swarm/tools/dueloddsRpcTools.ts';

describe('runNov21b repros (wf-1795274058727)', () => {
  const origUrl = process.env.SUPABASE_URL;
  const origPub = process.env.SUPABASE_PUBLISHABLE_KEY;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'anon-pub-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origPub === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = origPub;
  });

  it('H: formats snapshot d.form.items as compact per-team W-L lastN lines in first-seen order', async () => {
    const payload = {
      source: 'snapshot',
      home_team_id: 101,
      away_team_id: 202,
      home_team_abbr: 'USA',
      away_team_abbr: 'USM',
      form: {
        items: [
          { team_id: 101, game_date: '2026-11-10', result: 'W' },
          { team_id: 202, game_date: '2026-11-18', result: 'L' },
          { team_id: 101, game_date: '2026-11-20', result: 'W' },
          { team_id: 101, game_date: '2026-11-12', result: 'W' },
          { team_id: 202, game_date: '2026-11-15', result: 'L' },
          { team_id: 101, game_date: '2026-11-16', result: 'L' },
          { team_id: 202, game_date: '2026-11-11', result: 'L' },
          { team_id: 101, game_date: '2026-11-05', result: 'L' },
          { team_id: 202, game_date: '2026-11-13', result: 'W' },
          { team_id: 202, game_date: '2026-11-06', result: 'W' }
        ]
      },
      h2h: []
    };

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));

    const res: any = await getMatchupFundamentalsTool.execute({ game_id: 'college-football-401871101' });
    expect(res.success).toBe(true);
    expect(res.summary).toContain('Form: USA 3-2 last5 WLWWL; USM 2-3 last5 LLWLW');
  });
});
