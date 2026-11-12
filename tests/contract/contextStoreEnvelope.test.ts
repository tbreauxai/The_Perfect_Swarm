import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
    getSupabaseReadOnlyConfig,
    readGameContextFromStore,
    adaptContextEnvelope,
    validateRpcResultRow,
    type SupabaseReadOnlyConfig
} from '../../src/swarm/morning/gameContext.ts';
import { resolveTrustedRetrievalScope } from '../../src/swarm/engine/historyScope.ts';

const fixturePath = resolve(__dirname, '../../fixtures/duelodds_read_game_context_v1.json');
const fixtureData = JSON.parse(readFileSync(fixturePath, 'utf8'));

const mockPublishableConfig: SupabaseReadOnlyConfig = {
    supabaseUrl: 'https://mock.supabase.co',
    supabasePublishableKey: 'sb_publishable_anon_readonly_key_12345'
};

describe('Contract: DuelOdds read_game_context_v1 Envelope & Reader Adapter', () => {
    const fixedNow = new Date('2026-11-06T18:00:00.000Z');

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('1. Adapter output: maps ready fixture with real envelope to existing Swarm section shapes', async () => {
        const readyPayload = fixtureData.ready;
        expect(readyPayload.results).toHaveLength(2);

        // Test adapter on item 1 (ready)
        const row1 = readyPayload.results[0];
        const adapted1 = adaptContextEnvelope(row1);
        expect(adapted1).not.toBeNull();
        expect(adapted1!.sections).toBeDefined();

        const sec1 = (adapted1!.sections as Record<string, any>);
        // Game section: commence_time mapped to scheduled_start
        expect(sec1.game.event_id).toBe('nba-401584793');
        expect(sec1.game.scheduled_start).toBe('2026-11-06T23:30:00.000Z');
        expect(sec1.game.home_team).toBe('Boston Celtics');

        // Venue section: TD Garden indoor=true
        expect(sec1.venue).not.toBeNull();
        expect(sec1.venue.name).toBe('TD Garden');
        expect(sec1.venue.indoor).toBe(true);

        // Form section: array of form items mapped
        expect(Array.isArray(sec1.form)).toBe(true);
        expect(sec1.form.length).toBeGreaterThan(0);
        expect(sec1.form[0].points_for).toBe(114);
        expect(sec1.form[0].result).toBe('W');

        // H2H section: derived winner, margin, total points
        expect(Array.isArray(sec1.h2h)).toBe(true);
        expect(sec1.h2h.length).toBeGreaterThan(0);
        expect(sec1.h2h[0].winner_team_id).toBe('BOS');
        expect(sec1.h2h[0].margin_home).toBe(5);
        expect(sec1.h2h[0].total_points).toBe(215);

        // Injuries section: Kristaps Porzingis
        expect(Array.isArray(sec1.injuries)).toBe(true);
        expect(sec1.injuries[0].player_name).toBe('Kristaps Porzingis');
        expect(sec1.injuries[0].reason).toBe('ankle');

        // Weather section: empty yields null without error
        expect(sec1.weather).toBeNull();

        // Odds section: aggregated from market items
        expect(Array.isArray(sec1.odds)).toBe(true);
        expect(sec1.odds[0].book).toBe('fanduel');
        expect(sec1.odds[0].ml_home).toBe(-145);
        expect(sec1.odds[0].spread_home).toBe(-3.5);

        // Source status
        const srcStatus = adapted1!.source_status as Record<string, any>;
        expect(srcStatus.game.status).toBe('ready');
        expect(srcStatus.weather.status).toBe('empty');

        // Test validateRpcResultRow on row 1
        const validated1 = validateRpcResultRow(
            row1,
            { sport: 'basketball_nba', game_date: '2026-11-06', event_id: 'nba-401584793' },
            fixedNow.getTime(),
            new Map()
        );
        expect(validated1.status).toBe('ready');
        expect(validated1.sections).not.toBeNull();
        expect(validated1.available_sections).toContain('game');
        expect(validated1.available_sections).toContain('odds');

        // Test validateRpcResultRow on row 2 (partial: missing injuries)
        const row2 = readyPayload.results[1];
        const validated2 = validateRpcResultRow(
            row2,
            { sport: 'basketball_nba', game_date: '2026-11-06', event_id: 'nba-401584794' },
            fixedNow.getTime(),
            new Map()
        );
        expect(validated2.status).toBe('partial');
        expect(validated2.unavailable_reason).toBe('sections_incomplete');
    });

    it('2. Empty path: status "empty" or items: [] yields valid no-context with no throw', async () => {
        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-06',
                            eventIds: ['nba-401584793']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        // Mock fetch returning empty fixture: { status: "empty", items: [] }
        const fetchFn = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(fixtureData.empty), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        );

        const result = await readGameContextFromStore(mockPublishableConfig, scopeRes.scope, fetchFn as any);
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.results).toHaveLength(1);
        expect(result.results[0].status).toBe('unavailable');
        expect(result.results[0].unavailable_reason).toBe('no_snapshot');
        expect(result.formattedBlock).toBe('');
    });

    it('3. Malformed path: malformed shape returns a logged reason and no context', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Malformed row: items is not an array
        const malformedRow = {
            event_id: 'nba-401584793',
            game_date: '2026-11-06',
            sport: 'basketball_nba',
            schema_ver: 1,
            status: 'ready',
            snapshot_id: '00000000-0000-4000-8000-000000000010',
            content_hash: 'a'.repeat(64),
            version: '1',
            created_at: '2026-11-06T17:55:00.000Z',
            observed_at: '2026-11-06T17:55:00.000Z',
            decision_as_of: '2026-11-06T17:55:00.000Z',
            sections: {
                game: {
                    status: 'ready',
                    items: 'not-an-array'
                }
            }
        };

        const adapted = adaptContextEnvelope(malformedRow);
        expect(adapted).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed section envelope for game'));

        // When passed to validateRpcResultRow
        const validated = validateRpcResultRow(
            malformedRow,
            { sport: 'basketball_nba', game_date: '2026-11-06', event_id: 'nba-401584793' },
            fixedNow.getTime(),
            new Map()
        );
        expect(validated.status).toBe('unavailable');
        expect(validated.unavailable_reason).toBe('sections_incomplete');
        expect(validated.sections).toBeNull();
    });

    it('4. Hex-to-canonical resolution: resolves 32-hex Odds API IDs via canonical_game_aliases', async () => {
        const hexId = '1234567890abcdef1234567890abcdef';
        const canonicalId = 'nba-401584793';

        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-06',
                            eventIds: [hexId]
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        let aliasCalled = false;
        let rpcCalledWithCanonical = false;

        const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            const urlStr = String(url);
            if (urlStr.includes('/rest/v1/canonical_game_aliases')) {
                aliasCalled = true;
                expect(urlStr).toContain('provider=eq.oddsapi');
                expect(urlStr).toContain(hexId);
                return new Response(
                    JSON.stringify([
                        {
                            provider_event_id: hexId,
                            event_id: canonicalId
                        }
                    ]),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            if (urlStr.includes('/rest/v1/rpc/read_game_context_v1')) {
                const body = JSON.parse(String(init?.body));
                if (body.groups[0].eventIds[0] === canonicalId) {
                    rpcCalledWithCanonical = true;
                }
                return new Response(
                    JSON.stringify({
                        ...fixtureData.ready,
                        results: [fixtureData.ready.results[0]]
                    }),
                    {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    }
                );
            }

            return new Response('Not found', { status: 404 });
        });

        const result = await readGameContextFromStore(mockPublishableConfig, scopeRes.scope, fetchFn as any);
        expect(aliasCalled).toBe(true);
        expect(rpcCalledWithCanonical).toBe(true);
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
    });

    it('5. Unresolved skip: unresolved 32-hex ID is skipped with logged reason (count + id), never guessed', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const unresolvableHex = 'ffffffffffffffffffffffffffffffff';

        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-06',
                            eventIds: [unresolvableHex]
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (String(url).includes('/rest/v1/canonical_game_aliases')) {
                // Return empty alias results: ID not found
                return new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response('Not found', { status: 404 });
        });

        const result = await readGameContextFromStore(mockPublishableConfig, scopeRes.scope, fetchFn as any);
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.results).toHaveLength(0); // skipped, no remaining eventIds
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`Unresolved 32-hex id skipped: count=1, id=${unresolvableHex}`)
        );
    });

    it('6. Publishable key enforcement: uses publishable key, rejects service role key and fails closed when unset', async () => {
        // Test publishable key used in headers
        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-06',
                            eventIds: ['nba-401584793']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        let capturedHeaders: Record<string, string> = {};
        const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            capturedHeaders = (init?.headers as Record<string, string>) || {};
            return new Response(JSON.stringify(fixtureData.ready), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        await readGameContextFromStore(mockPublishableConfig, scopeRes.scope, fetchFn as any);
        expect(capturedHeaders['apikey']).toBe('sb_publishable_anon_readonly_key_12345');
        expect(capturedHeaders['Authorization']).toBe('Bearer sb_publishable_anon_readonly_key_12345');

        // Test rejection of service role key
        vi.stubEnv('SUPABASE_URL', 'https://mock.supabase.co');
        vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'supabase_service_role_secret_key');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'supabase_service_role_secret_key');

        const cfgWithServiceKey = getSupabaseReadOnlyConfig();
        expect(cfgWithServiceKey).toBeNull(); // Strictly rejected!

        // Fails closed (no context) when config is null
        const closedResult = await readGameContextFromStore(null, scopeRes.scope, fetchFn as any);
        expect(closedResult.status).toBe('store_not_ready');
        if (closedResult.status !== 'store_not_ready') return;
        expect(closedResult.reason).toBe('missing_readonly_key');
    });

    it('7. historyScope gate: app tokens never unlock private history', async () => {
        // App token caller cannot pass userId or access private visibility
        const privateAttempt = resolveTrustedRetrievalScope({
            body: {
                userId: 'private-secret-user',
                retrievalContext: {
                    version: 1,
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-06',
                            eventIds: ['nba-401584793']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });

        // App token requests cannot claim private history
        if (privateAttempt.ok) {
            expect(privateAttempt.scope.callerAppId).toBe('duelodds');
            // Scope does not carry user identity
            expect((privateAttempt.scope as any).userId).toBeUndefined();
        }
    });
});
