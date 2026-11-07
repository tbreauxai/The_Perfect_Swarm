import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    getSupabaseReadOnlyConfig,
    readGameContextFromStore,
    formatGameContextForPrompt,
    verifyAndAttachJudgmentProvenance,
    type SupabaseReadOnlyConfig
} from './gameContext.ts';
import { resolveTrustedRetrievalScope } from '../engine/historyScope.ts';

const readCfg: SupabaseReadOnlyConfig = {
    supabaseUrl: 'https://mock.supabase.co',
    supabasePublishableKey: 'sb_publishable_anon_readonly_key'
};

function buildValidRpcRow(overrides: Record<string, any> = {}) {
    return {
        event_id: 'nfl-1',
        game_date: '2026-11-06',
        sport: 'americanfootball_nfl',
        status: 'ready',
        unavailable_reason: null,
        snapshot_id: '00000000-0000-4000-8000-000000000010',
        content_hash: 'a'.repeat(64),
        version: '42',
        schema_ver: 1,
        created_at: '2026-11-06T17:50:00.000Z',
        observed_at: '2026-11-06T17:52:00.000Z',
        decision_as_of: '2026-11-06T17:55:00.000Z',
        sections: {
            game: {
                event_id: 'nfl-1',
                sport: 'americanfootball_nfl',
                league: 'NFL',
                season: '2026',
                game_date: '2026-11-06',
                scheduled_start: '2026-11-06T20:15:00.000Z',
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
                    completed_at: '2026-10-30T23:00:00.000Z',
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
                    completed_at: '2025-12-10T23:00:00.000Z',
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
                    reported_at: '2026-11-06T15:00:00.000Z'
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
                    captured_at: '2026-11-06T17:50:00.000Z',
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
            game: { status: 'ok', observed_at: '2026-11-06T17:50:00.000Z', source_ref: 'odds_api' },
            venue: { status: 'ok', observed_at: '2026-11-06T17:00:00.000Z', source_ref: 'espn' },
            form: { status: 'ok', observed_at: '2026-11-06T12:00:00.000Z', source_ref: 'espn' },
            h2h: { status: 'ok', observed_at: '2026-11-06T12:00:00.000Z', source_ref: 'espn' },
            injuries: { status: 'ok', observed_at: '2026-11-06T15:00:00.000Z', source_ref: 'nfl_inj' },
            weather: { status: 'ok', observed_at: '2026-11-06T17:00:00.000Z', source_ref: 'meteo' },
            odds: { status: 'ok', observed_at: '2026-11-06T17:50:00.000Z', source_ref: 'odds_api' }
        },
        ...overrides
    };
}

describe('readGameContextFromStore & gameContext validation', () => {
    const fixedNow = new Date('2026-11-06T18:00:00.000Z');

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('enforces read-only publishable key and rejects service-role write key', () => {
        expect(
            getSupabaseReadOnlyConfig({
                SUPABASE_URL: 'https://mock.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'secret_service_role'
            })
        ).toBeNull();

        expect(
            getSupabaseReadOnlyConfig({
                SUPABASE_URL: 'https://mock.supabase.co',
                SUPABASE_PUBLISHABLE_KEY: 'secret_service_role',
                SUPABASE_SERVICE_ROLE_KEY: 'secret_service_role'
            })
        ).toBeNull();

        expect(
            getSupabaseReadOnlyConfig({
                SUPABASE_URL: 'https://mock.supabase.co',
                SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_123',
                SUPABASE_SERVICE_ROLE_KEY: 'secret_service_role'
            })
        ).toEqual({
            supabaseUrl: 'https://mock.supabase.co',
            supabasePublishableKey: 'sb_publishable_123'
        });
    });

    it('reads ready snapshot via POST /rest/v1/rpc/read_game_context_v1 and records db_rpc_verified', async () => {
        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    purpose: 'parlay',
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1'],
                            entityIds: ['KC', 'BUF']
                        }
                    ],
                    requiredContext: ['game', 'odds', 'form']
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('https://mock.supabase.co/rest/v1/rpc/read_game_context_v1');
            expect(init?.method).toBe('POST');
            const parsedBody = JSON.parse(String(init?.body));
            expect(parsedBody).toEqual({
                groups: [
                    {
                        sport: 'americanfootball_nfl',
                        date: '2026-11-06',
                        eventIds: ['nfl-1'],
                        entityIds: ['KC', 'BUF']
                    }
                ],
                as_of: '2026-11-06T18:00:00.000Z'
            });
            return new Response(
                JSON.stringify({
                    schema_ver: 1,
                    as_of: '2026-11-06T18:00:00.000Z',
                    results: [buildValidRpcRow()]
                }),
                { status: 200 }
            );
        });

        const readResult = await readGameContextFromStore(readCfg, scopeRes.scope, fetchFn as any);
        expect(readResult.status).toBe('ok');
        if (readResult.status === 'ok') {
            expect(readResult.allReadyForSlim).toBe(true);
            expect(readResult.results[0].status).toBe('ready');
            expect(readResult.results[0].integrity_source).toBe('db_rpc_verified');
            expect(readResult.formattedBlock).toContain('IMMUTABLE GAME CONTEXT SNAPSHOTS');
            expect(readResult.formattedBlock).toContain('Kansas City Chiefs');
            expect(Object.keys(readResult.missingRequiredSectionsByEvent)).toHaveLength(0);
        }
    });

    it('rejects post-cutoff timestamps, stale odds (>15m), and target-game leak in form/h2h', async () => {
        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    purpose: 'parlay',
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1']
                        }
                    ],
                    requiredContext: ['game', 'odds']
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        // 1) Stale odds (captured 30 minutes before asOf, exceeding 15m window)
        const staleOddsRow = buildValidRpcRow();
        staleOddsRow.sections.odds[0].captured_at = '2026-11-06T17:20:00.000Z';
        staleOddsRow.source_status.odds.observed_at = '2026-11-06T17:20:00.000Z';

        const staleRes = await readGameContextFromStore(
            readCfg,
            scopeRes.scope,
            vi.fn(async () =>
                new Response(
                    JSON.stringify({
                        schema_ver: 1,
                        as_of: '2026-11-06T18:00:00.000Z',
                        results: [staleOddsRow]
                    }),
                    { status: 200 }
                )
            ) as any
        );
        expect(staleRes.status).toBe('ok');
        if (staleRes.status === 'ok') {
            expect(staleRes.allReadyForSlim).toBe(false);
            expect(staleRes.results[0].status).toBe('partial');
            expect(staleRes.results[0].freshness_violations).toContain('odds');
            expect(staleRes.missingRequiredSectionsByEvent['nfl-1']).toContain('odds');
        }

        // 2) Target game leaked inside form section -> rejected as invalid_source_time
        const leakFormRow = buildValidRpcRow();
        leakFormRow.sections.form[0].event_id = 'nfl-1';

        const leakRes = await readGameContextFromStore(
            readCfg,
            scopeRes.scope,
            vi.fn(async () =>
                new Response(
                    JSON.stringify({
                        schema_ver: 1,
                        as_of: '2026-11-06T18:00:00.000Z',
                        results: [leakFormRow]
                    }),
                    { status: 200 }
                )
            ) as any
        );
        expect(leakRes.status).toBe('ok');
        if (leakRes.status === 'ok') {
            expect(leakRes.results[0].status).toBe('unavailable');
            expect(leakRes.results[0].unavailable_reason).toBe('invalid_source_time');
        }
    });

    it('handles missing RPC (PGRST202/404) as store_not_ready and SQLSTATE 22023 as 400 invalid_scope', async () => {
        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        const notReadyRes = await readGameContextFromStore(
            readCfg,
            scopeRes.scope,
            vi.fn(async () =>
                new Response(
                    JSON.stringify({
                        code: 'PGRST202',
                        message: 'Could not find the function public.read_game_context_v1'
                    }),
                    { status: 404 }
                )
            ) as any
        );
        expect(notReadyRes.status).toBe('store_not_ready');

        const sql22023Res = await readGameContextFromStore(
            readCfg,
            scopeRes.scope,
            vi.fn(async () =>
                new Response(
                    JSON.stringify({
                        code: '22023',
                        message: 'as_of cannot be in the future'
                    }),
                    { status: 400 }
                )
            ) as any
        );
        expect(sql22023Res.status).toBe('invalid_scope');
        if (sql22023Res.status === 'invalid_scope') {
            expect(sql22023Res.httpStatus).toBe(400);
        }
    });

    it('attaches context_snapshot_id and context_hash to judgment outputs and rejects mismatched echoes', async () => {
        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        if (!scopeRes.ok) return;

        const readRes = await readGameContextFromStore(
            readCfg,
            scopeRes.scope,
            vi.fn(async () =>
                new Response(
                    JSON.stringify({
                        schema_ver: 1,
                        as_of: '2026-11-06T18:00:00.000Z',
                        results: [buildValidRpcRow()]
                    }),
                    { status: 200 }
                )
            ) as any
        );
        expect(readRes.status).toBe('ok');
        if (readRes.status !== 'ok') return;

        const attached = verifyAndAttachJudgmentProvenance(
            { event_id: 'nfl-1', win_prob_home: 0.58 },
            readRes.byEventId
        );
        expect(attached.ok).toBe(true);
        if (attached.ok) {
            expect(attached.judgment.context_snapshot_id).toBe(
                '00000000-0000-4000-8000-000000000010'
            );
            expect(attached.judgment.context_hash).toBe('a'.repeat(64));
        }

        const mismatched = verifyAndAttachJudgmentProvenance(
            {
                event_id: 'nfl-1',
                context_snapshot_id: '00000000-0000-4000-8000-000000000010',
                context_hash: 'b'.repeat(64)
            },
            readRes.byEventId
        );
        expect(mismatched.ok).toBe(false);
    });

    it('never silently truncates required sections when budget is exceeded', () => {
        const row = buildValidRpcRow();
        const res = formatGameContextForPrompt({
            rows: [row as any],
            requiredContext: ['game', 'odds'],
            asOf: '2026-11-06T18:00:00.000Z',
            maxCharsPerEvent: 40
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.reason).toBe('required_context_budget_exceeded');
        }
    });
});
