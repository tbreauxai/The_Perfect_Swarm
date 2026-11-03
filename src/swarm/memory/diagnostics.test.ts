import { describe, it, expect, vi } from 'vitest';
import { collectCortexDiagnostics } from './diagnostics.ts';
import type { DiagnosticsContext } from './diagnostics.ts';

describe('collectCortexDiagnostics', () => {
    const defaultContext = (overrides: Partial<DiagnosticsContext> = {}): DiagnosticsContext => ({
        qdrant: null,
        isAvailable: true,
        collectionName: 'test_collection',
        fallbackStore: [],
        defaultAppId: 'test-app',
        withTimeout: async <T>(p: Promise<T>): Promise<T> => p,
        ...overrides
    });

    describe('native client.count() API', () => {
        it('uses parallel client.count() calls when count is supported', async () => {
            const countCalls: Array<{ collection: string; options: any }> = [];

            const mockQdrant = {
                count: vi.fn(async (collection: string, options: any) => {
                    countCalls.push({ collection, options });
                    // Return different counts based on filter
                    const filterStr = JSON.stringify(options?.filter || {});
                    if (filterStr.includes('"outcome"')) {
                        if (filterStr.includes('"win"')) return { count: 8 };
                        if (filterStr.includes('"loss"')) return { count: 2 };
                        if (filterStr.includes('"push"')) return { count: 1 };
                    }
                    if (filterStr.includes('"gradedAt"')) {
                        return { count: 11 };
                    }
                    return { count: 20 }; // Total points
                })
            };

            const ctx = defaultContext({
                qdrant: mockQdrant as any,
                isAvailable: true
            });

            const diag = await collectCortexDiagnostics(ctx);

            expect(mockQdrant.count).toHaveBeenCalledTimes(5);
            expect(diag.pointCount).toBe(20);
            expect(diag.gradedCount).toBe(11);
            expect(diag.ungradedCount).toBe(9);
            expect(diag.gradedWins).toBe(8);
            expect(diag.gradedLosses).toBe(2);
            expect(diag.gradedPushes).toBe(1);
            expect(diag.headlineAccuracy).toBeCloseTo(8 / 11);
        });

        it('applies DuelOdds safeguard with appId and originApp disjunction filter', async () => {
            const recordedFilters: any[] = [];

            const mockQdrant = {
                count: vi.fn(async (_collection: string, options: any) => {
                    recordedFilters.push(options?.filter);
                    return { count: 5 };
                })
            };

            const ctx = defaultContext({
                qdrant: mockQdrant as any,
                isAvailable: true
            });

            await collectCortexDiagnostics(ctx, 'duelodds');

            expect(mockQdrant.count).toHaveBeenCalledTimes(5);

            // Verify each count query includes the DuelOdds appId/originApp should match
            for (const filter of recordedFilters) {
                expect(filter).toBeDefined();
                expect(filter.must).toBeDefined();
                const appIdCondition = filter.must.find((c: any) =>
                    c.should &&
                    c.should.some((s: any) => s.key === 'appId' && s.match?.value === 'duelodds') &&
                    c.should.some((s: any) => s.key === 'originApp' && s.match?.value === 'duelodds')
                );
                expect(appIdCondition).toBeDefined();
            }
        });

        it('does not apply appIdCondition when filter is global or undefined', async () => {
            const recordedFilters: any[] = [];

            const mockQdrant = {
                count: vi.fn(async (_collection: string, options: any) => {
                    recordedFilters.push(options?.filter);
                    return { count: 10 };
                })
            };

            const ctx = defaultContext({
                qdrant: mockQdrant as any,
                isAvailable: true
            });

            await collectCortexDiagnostics(ctx, 'global');

            // Total filter should be undefined for global
            expect(recordedFilters[0]).toBeUndefined();
        });

        it('performs targeted scroll only when includeBreakdown is true', async () => {
            const mockQdrant = {
                count: vi.fn(async () => ({ count: 15 })),
                scroll: vi.fn(async () => ({
                    points: [
                        { payload: { domain: 'sports', agentRole: 'analyst', appId: 'duelodds' } },
                        { payload: { domain: 'finance', agentRole: 'trader', originApp: 'duelodds' } }
                    ],
                    next_page_offset: null
                }))
            };

            const ctx = defaultContext({
                qdrant: mockQdrant as any,
                isAvailable: true
            });

            // Without includeBreakdown
            const diagBasic = await collectCortexDiagnostics(ctx, 'duelodds');
            expect(mockQdrant.scroll).not.toHaveBeenCalled();
            expect(diagBasic.pointCount).toBe(15);

            // With includeBreakdown: true
            const diagBreakdown = await collectCortexDiagnostics(ctx, 'duelodds', { includeBreakdown: true });
            expect(mockQdrant.scroll).toHaveBeenCalledWith(
                'test_collection',
                expect.objectContaining({
                    limit: 1000,
                    with_payload: ['domain', 'agentRole', 'appId', 'originApp']
                })
            );
            expect(diagBreakdown.storageByDomain['sports']).toBe(1);
            expect(diagBreakdown.storageByDomain['finance']).toBe(1);
            expect(diagBreakdown.storageByRole['analyst']).toBe(1);
            expect(diagBreakdown.storageByRole['trader']).toBe(1);
        });
    });

    describe('fallback path when client.count() is absent', () => {
        it('gracefully falls back to scroll iteration', async () => {
            const mockQdrantNoCount = {
                scroll: vi.fn(async () => ({
                    points: [
                        {
                            payload: {
                                appId: 'duelodds',
                                domain: 'sports',
                                agentRole: 'analyst',
                                feedbackProcessed: true,
                                outcome: 'win'
                            }
                        },
                        {
                            payload: {
                                originApp: 'duelodds',
                                domain: 'sports',
                                agentRole: 'analyst',
                                outcome: 'loss',
                                gradedAt: '2026-11-01'
                            }
                        },
                        {
                            payload: {
                                appId: 'duelodds',
                                domain: 'sports',
                                agentRole: 'analyst',
                                qualityRating: 0.8 // ungraded
                            }
                        }
                    ],
                    next_page_offset: null
                }))
            };

            const ctx = defaultContext({
                qdrant: mockQdrantNoCount as any,
                isAvailable: true
            });

            const diag = await collectCortexDiagnostics(ctx, 'duelodds');

            expect(mockQdrantNoCount.scroll).toHaveBeenCalled();
            expect(diag.pointCount).toBe(3);
            expect(diag.gradedCount).toBe(2);
            expect(diag.ungradedCount).toBe(1);
            expect(diag.gradedWins).toBe(1);
            expect(diag.gradedLosses).toBe(1);
            expect(diag.gradedPushes).toBe(0);
            expect(diag.headlineAccuracy).toBe(0.5);
        });
    });

    describe('in-memory fallbackStore', () => {
        it('aggregates stats correctly from fallbackStore when Qdrant is unavailable', async () => {
            const ctx = defaultContext({
                qdrant: null,
                isAvailable: false,
                fallbackStore: [
                    {
                        id: 'pt-1',
                        denseVector: [],
                        sparseVector: { indices: [], values: [] },
                        payload: {
                            content: 'point 1',
                            appId: 'duelodds',
                            frequency: 1,
                            qualityRating: 1.0,
                            verified: true,
                            outcome: 'win',
                            gradedAt: '2026-11-02',
                            timestamp: '2026-11-02',
                            lastSeen: '2026-11-02'
                        }
                    },
                    {
                        id: 'pt-2',
                        denseVector: [],
                        sparseVector: { indices: [], values: [] },
                        payload: {
                            content: 'point 2',
                            appId: 'duelodds',
                            frequency: 1,
                            qualityRating: 0.0,
                            verified: true,
                            outcome: 'loss',
                            gradedAt: '2026-11-02',
                            timestamp: '2026-11-02',
                            lastSeen: '2026-11-02'
                        }
                    },
                    {
                        id: 'pt-3',
                        denseVector: [],
                        sparseVector: { indices: [], values: [] },
                        payload: {
                            content: 'point 3',
                            appId: 'other-app',
                            frequency: 1,
                            qualityRating: 0.9,
                            verified: true,
                            timestamp: '2026-11-02',
                            lastSeen: '2026-11-02'
                        }
                    }
                ]
            });

            const diag = await collectCortexDiagnostics(ctx, 'duelodds');

            expect(diag.qdrantAvailable).toBe(false);
            expect(diag.pointCount).toBe(2);
            expect(diag.gradedCount).toBe(2);
            expect(diag.gradedWins).toBe(1);
            expect(diag.gradedLosses).toBe(1);
            expect(diag.headlineAccuracy).toBe(0.5);
        });
    });
});
