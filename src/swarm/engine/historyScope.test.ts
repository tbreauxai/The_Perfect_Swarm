import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
    resolveTrustedRetrievalScope,
    parseAndValidateAsOf,
    isValidCalendarDate
} from './historyScope.ts';
import { registerAnalyzeRoutes } from '../server/routes/analyze.ts';
import { MemoryCortex } from '../memory.ts';
import { SwarmContext } from '../context.ts';
import { ToolRegistry } from '../tools/index.ts';
import { resolveMemoryGrounding } from './memoryGrounding.ts';

function createTestAnalyzeApp(callerAppId?: string) {
    const app = new Hono();
    if (callerAppId) {
        app.use('*', async (c: any, next: any) => {
            c.set('callerAppId', callerAppId);
            await next();
        });
    }
    registerAnalyzeRoutes(app, {
        defaultSettings: { appId: 'duelodds' },
        defaultAi: undefined,
        defaultCortex: undefined,
        swarmBodyLimit: async (_c: any, next: any) => next()
    } as any);
    return app;
}

describe('historyScope validation and trusted scope binding', () => {
    const fixedNow = new Date('2026-11-06T18:00:00.000Z');

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('normalizes past RFC3339 timestamps to UTC and rejects future cutoffs or invalid dates', () => {
        expect(isValidCalendarDate('2026-11-06')).toBe(true);
        expect(isValidCalendarDate('2026-02-30')).toBe(false);

        const defaultCutoff = parseAndValidateAsOf(undefined, fixedNow);
        expect(defaultCutoff).toEqual({
            ok: true,
            asOf: '2026-11-06T18:00:00.000Z',
            asOfMs: fixedNow.getTime()
        });

        const offsetCutoff = parseAndValidateAsOf('2026-11-06T11:30:00-06:00', fixedNow);
        expect(offsetCutoff).toEqual({
            ok: true,
            asOf: '2026-11-06T17:30:00.000Z',
            asOfMs: Date.parse('2026-11-06T17:30:00.000Z')
        });

        const futureCutoff = parseAndValidateAsOf('2026-11-06T18:00:01Z', fixedNow);
        expect(futureCutoff.ok).toBe(false);
        if (!futureCutoff.ok) {
            expect(futureCutoff.reason).toBe('future_as_of_cutoff');
        }

        const badCalendar = parseAndValidateAsOf('2026-02-29T12:00:00Z', fixedNow);
        expect(badCalendar.ok).toBe(false);
    });

    it('binds callerAppId to middleware identity and ignores untrusted body/settings appId or userId', () => {
        const res = resolveTrustedRetrievalScope({
            body: {
                appId: 'evil-tenant',
                userId: 'private-user-99',
                settings: { appId: 'evil-tenant', userId: 'private-user-99' },
                retrievalContext: {
                    version: 1,
                    requestId: 'req-123',
                    purpose: 'parlay',
                    asOf: '2026-11-06T17:00:00Z',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1', 'nfl-2'],
                            entityIds: ['KC', 'BUF']
                        }
                    ],
                    requiredContext: ['game', 'odds', 'form'],
                    optionalContext: ['lessons']
                }
            },
            callerAppId: 'duelodds',
            defaultAppId: 'perfect-swarm',
            now: fixedNow
        });

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.scope.callerAppId).toBe('duelodds');
            expect(res.scope.asOf).toBe('2026-11-06T17:00:00.000Z');
            expect(res.scope.requestId).toBe('req-123');
            expect(res.scope.purpose).toBe('parlay');
            expect(res.scope.eventIds).toEqual(['nfl-1', 'nfl-2']);
            expect(res.scope.entityIds).toEqual(['KC', 'BUF']);
            expect(res.scope.requiredContext).toEqual(['game', 'odds', 'form']);
            expect(res.scope.optionalContext).toEqual(['lessons']);
            expect(res.scope.usesContextStore).toBe(true);
        }
    });

    it('preserves multi-group scope without silent collapse and rejects conflicting root fields', () => {
        const multiGroup = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    purpose: 'parlay',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1'],
                            entityIds: ['KC']
                        },
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-07',
                            eventIds: ['nba-1'],
                            entityIds: ['BOS']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });

        expect(multiGroup.ok).toBe(true);
        if (multiGroup.ok) {
            expect(multiGroup.scope.groups).toHaveLength(2);
            expect(multiGroup.scope.sport).toBeUndefined();
            expect(multiGroup.scope.date).toBeUndefined();
            expect(multiGroup.scope.eventIds).toEqual(['nfl-1', 'nba-1']);
            expect(multiGroup.scope.entityIds).toEqual(['KC', 'BOS']);
        }

        const conflictingSport = resolveTrustedRetrievalScope({
            body: {
                sport: 'americanfootball_nfl',
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1']
                        },
                        {
                            sport: 'basketball_nba',
                            date: '2026-11-06',
                            eventIds: ['nba-1']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(conflictingSport.ok).toBe(false);
        if (!conflictingSport.ok) {
            expect(conflictingSport.reason).toBe('conflicting_sport_scope');
        }

        const conflictingEvents = resolveTrustedRetrievalScope({
            body: {
                eventIds: ['nfl-1'],
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1', 'nfl-2']
                        }
                    ]
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(conflictingEvents.ok).toBe(false);
        if (!conflictingEvents.ok) {
            expect(conflictingEvents.reason).toBe('conflicting_event_ids_scope');
        }
    });

    it('enforces group, event, entity, and 4096-byte metadata caps', () => {
        const fiveGroups = Array.from({ length: 5 }, (_, i) => ({
            sport: 'americanfootball_nfl',
            date: '2026-11-06',
            eventIds: [`ev-${i + 1}`]
        }));
        const tooManyGroups = resolveTrustedRetrievalScope({
            body: { retrievalContext: { version: 1, groups: fiveGroups } },
            now: fixedNow
        });
        expect(tooManyGroups.ok).toBe(false);
        if (!tooManyGroups.ok) {
            expect(tooManyGroups.reason).toBe('invalid_groups_count');
        }

        const twentyOneEvents = Array.from({ length: 21 }, (_, i) => `ev-${i + 1}`);
        const tooManyEvents = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: twentyOneEvents
                        }
                    ]
                }
            },
            now: fixedNow
        });
        expect(tooManyEvents.ok).toBe(false);
        if (!tooManyEvents.ok) {
            expect(tooManyEvents.reason).toBe('event_ids_limit_exceeded');
        }

        const fortyOneEntities = Array.from({ length: 41 }, (_, i) => `TEAM_${i + 1}`);
        const tooManyEntities = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['ev-1'],
                            entityIds: fortyOneEntities
                        }
                    ]
                }
            },
            now: fixedNow
        });
        expect(tooManyEntities.ok).toBe(false);
        if (!tooManyEntities.ok) {
            expect(tooManyEntities.reason).toBe('entity_ids_limit_exceeded');
        }

        const hugeEntities = Array.from({ length: 38 }, (_, i) => `ENTITY_${i}_${'X'.repeat(100)}`);
        const oversizedMeta = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['ev-1'],
                            entityIds: hugeEntities
                        }
                    ]
                }
            },
            now: fixedNow
        });
        expect(oversizedMeta.ok).toBe(false);
        if (!oversizedMeta.ok) {
            expect(oversizedMeta.reason).toBe('envelope_metadata_too_large');
        }
    });

    it('validates snapshotRefs and rejects untrusted fields in retrievalContext or snapshotRefs', () => {
        const validHash = 'a'.repeat(64);
        const okRefs = resolveTrustedRetrievalScope({
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
                },
                snapshotRefs: [
                    {
                        event_id: 'nfl-1',
                        game_date: '2026-11-06',
                        sport: 'americanfootball_nfl',
                        snapshot_id: '00000000-0000-4000-8000-000000000001',
                        content_hash: validHash
                    }
                ]
            },
            now: fixedNow
        });
        expect(okRefs.ok).toBe(true);

        const untrustedField = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    userId: 'attacker',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1']
                        }
                    ]
                }
            },
            now: fixedNow
        });
        expect(untrustedField.ok).toBe(false);
        if (!untrustedField.ok) {
            expect(untrustedField.reason).toBe('unexpected_retrieval_context_field');
        }
    });

    it('returns 400 on /api/swarm/analyze and /api/swarm/stream for future asOf or conflicting group scope', async () => {
        const app = createTestAnalyzeApp('duelodds');

        const futureRes = await app.request('/api/swarm/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                task: 'Analyze NFL game',
                data: 'Game data',
                retrievalContext: {
                    version: 1,
                    asOf: '2099-01-01T00:00:00Z',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1']
                        }
                    ]
                }
            })
        });
        expect(futureRes.status).toBe(400);
        const futureJson = await futureRes.json();
        expect(futureJson.reason).toBe('future_as_of_cutoff');

        const conflictStreamRes = await app.request('/api/swarm/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                task: 'Stream NFL game',
                data: 'Game data',
                sport: 'basketball_nba',
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
            })
        });
        expect(conflictStreamRes.status).toBe(400);
        const conflictJson = await conflictStreamRes.json();
        expect(conflictJson.reason).toBe('conflicting_sport_scope');
    });

    it('isolates derived lessons in MemoryCortex and resolveMemoryGrounding by trusted scope and asOf cutoff', async () => {
        const cortex = new MemoryCortex({
            defaultAppId: 'duelodds',
            isolatedStore: true
        });

        await cortex.upsertGradedLesson('lesson-valid', {
            app_id: 'duelodds',
            visibility: 'public',
            sport: 'americanfootball_nfl',
            entityIds: ['KC'],
            rule: 'KC covers short spreads off a 7-day rest window.',
            available_at: '2026-11-05T12:00:00.000Z',
            graded_at: '2026-11-05T12:00:00.000Z',
            date: '2026-11-05T12:00:00.000Z',
            outcome: 'win'
        });

        await cortex.upsertGradedLesson('lesson-future', {
            app_id: 'duelodds',
            visibility: 'public',
            sport: 'americanfootball_nfl',
            entityIds: ['KC'],
            rule: 'Post-game future leak lesson for KC.',
            available_at: '2026-11-06T22:00:00.000Z',
            graded_at: '2026-11-06T22:00:00.000Z',
            date: '2026-11-06T22:00:00.000Z',
            outcome: 'loss'
        });

        await cortex.upsertGradedLesson('lesson-private', {
            app_id: 'duelodds',
            visibility: 'private',
            userId: 'user-secret',
            sport: 'americanfootball_nfl',
            entityIds: ['KC'],
            rule: 'Private user lesson must never be retrieved.',
            available_at: '2026-11-05T12:00:00.000Z',
            date: '2026-11-05T12:00:00.000Z'
        });

        const scopeRes = resolveTrustedRetrievalScope({
            body: {
                retrievalContext: {
                    version: 1,
                    asOf: '2026-11-06T18:00:00.000Z',
                    groups: [
                        {
                            sport: 'americanfootball_nfl',
                            date: '2026-11-06',
                            eventIds: ['nfl-1'],
                            entityIds: ['KC', 'BUF']
                        }
                    ],
                    optionalContext: ['lessons']
                }
            },
            callerAppId: 'duelodds',
            now: fixedNow
        });
        expect(scopeRes.ok).toBe(true);
        if (!scopeRes.ok) return;

        const grounding = await resolveMemoryGrounding({
            memoryCortex: cortex,
            task: 'Evaluate KC vs BUF spread',
            targetAppId: 'duelodds',
            includeShared: false,
            bypassCache: false,
            toolRegistry: new ToolRegistry(),
            context: new SwarmContext(),
            retrievalScope: scopeRes.scope,
            retrievalContext: scopeRes.retrievalContext
        });

        expect(grounding.historicalContext).toContain('KC covers short spreads');
        expect(grounding.historicalContext).not.toContain('Post-game future leak');
        expect(grounding.historicalContext).not.toContain('Private user lesson');
    });

    it('rejects parlay slim-v1 on /api/swarm/stream with 422 slim_context_ineligible when store is unconfigured', async () => {
        const app = createTestAnalyzeApp('duelodds');
        const res = await app.request('/api/swarm/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                payload: 'slim-v1',
                task: 'Stream 2-leg parlay',
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
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body).toMatchObject({
            error: 'slim_pull_failed',
            payload: 'slim-v1',
            reason: 'slim_context_ineligible'
        });
    });
});
