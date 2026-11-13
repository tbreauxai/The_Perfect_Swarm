import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGameContextTool } from './gameContextTool.ts';
import { globalToolRegistry } from './registry.ts';

describe('get_game_context tool', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('resolves a raw Odds API ID and returns the canonical ID from the context read', async () => {
        vi.stubEnv('SUPABASE_URL', 'https://mock.supabase.co');
        vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key');

        const rawId = 'd5c5ae8d56762b45d1ec4b85337878f3';
        const canonicalId = 'nba-401909977';
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/canonical_game_aliases')) {
                return new Response(
                    JSON.stringify([{ provider_event_id: rawId, event_id: canonicalId }]),
                    { status: 200 }
                );
            }
            if (url.includes('/rpc/read_game_context_v1')) {
                const requestBody = JSON.parse(String(init?.body));
                expect(requestBody.groups[0].eventIds).toEqual([canonicalId]);
                return new Response(JSON.stringify({ status: 'empty', items: [] }), { status: 200 });
            }
            if (url.includes('/game_judgments?') || url.includes('/line_snapshots?')) {
                if (url.includes('/game_judgments?')) {
                    expect(url).toContain(`event_id=eq.${canonicalId}`);
                    return new Response(
                        JSON.stringify([{
                            event_id: canonicalId,
                            game_date: '2026-11-12',
                            sport: 'basketball_nba',
                            home_team: 'Home',
                            away_team: 'Away',
                            status: 'active',
                            win_prob_home: 0.6,
                            fair_spread: -2,
                            judged_at: '2026-11-12T16:00:00.000Z',
                            rejudge_count: 0
                        }]),
                        { status: 200 }
                    );
                }
                return new Response('[]', { status: 200 });
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        const result = await getGameContextTool.execute(
            {
                event_id: rawId,
                sport: 'basketball_nba',
                date: '2026-11-12'
            },
            { fetchFn: fetchMock as typeof fetch }
        );

        expect(result.success).toBe(true);
        expect(result.canonical_event_ids).toEqual([canonicalId]);
        expect(result.judgments[0].event_id).toBe(canonicalId);
        expect(result.summary).toContain('Recent/Matching Game Judgments');
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(globalToolRegistry.has('get_game_context')).toBe(true);
    });
});
