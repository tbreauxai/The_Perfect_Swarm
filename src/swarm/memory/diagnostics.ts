import type { QdrantClient } from '@qdrant/js-client-rest';
import type { StoredMemoryPoint, MemoryCortexDiagnostics, DiagnosticsOptions } from './types.ts';

export interface DiagnosticsContext {
    qdrant: QdrantClient | null;
    isAvailable: boolean;
    collectionName: string;
    fallbackStore: StoredMemoryPoint[];
    defaultAppId: string;
    withTimeout: <T>(promise: Promise<T>, ms?: number) => Promise<T>;
}

/**
 * Builds a server-side Qdrant filter condition for appId / originApp matching.
 * Dual-match ensures full backward compatibility with DuelOdds records.
 */
function buildAppIdCondition(appIdFilter?: string): any {
    if (!appIdFilter || appIdFilter === 'global') {
        return undefined;
    }
    return {
        should: [
            { key: 'appId', match: { value: appIdFilter } },
            { key: 'originApp', match: { value: appIdFilter } }
        ]
    };
}

/**
 * Combines an optional appId condition with a metric filter condition.
 */
function combineFilter(appIdCondition: any, metricCondition?: any): any {
    if (appIdCondition && metricCondition) {
        return { must: [appIdCondition, metricCondition] };
    }
    if (appIdCondition) {
        return { must: [appIdCondition] };
    }
    return metricCondition;
}

/**
 * Collects runtime storage distribution and health diagnostics across Qdrant and fallback stores.
 */
export async function collectCortexDiagnostics(
    ctx: DiagnosticsContext,
    appIdFilter?: string,
    options?: DiagnosticsOptions
): Promise<MemoryCortexDiagnostics> {
    let pointCount = 0;
    let gradedCount = 0;
    let ungradedCount = 0;
    let gradedWins = 0;
    let gradedLosses = 0;
    let gradedPushes = 0;
    const apps = new Set<string>();
    const storageByDomain: Record<string, number> = {};
    const storageByRole: Record<string, number> = {};
    let qdrantSuccess = false;

    const processPoint = (payload: Record<string, any>) => {
        pointCount++;
        const domain = payload.domain || 'general';
        const role = payload.agentRole || 'unknown';
        storageByDomain[domain] = (storageByDomain[domain] || 0) + 1;
        storageByRole[role] = (storageByRole[role] || 0) + 1;

        const isGraded = payload.feedbackProcessed === true || payload.outcome !== undefined || payload.gradedAt !== undefined;
        if (isGraded) {
            gradedCount++;
            if (payload.outcome === 'win' || payload.qualityRating === 1.0) {
                gradedWins++;
            } else if (payload.outcome === 'loss' || payload.qualityRating === 0.0) {
                gradedLosses++;
            } else if (payload.outcome === 'push' || payload.qualityRating === 0.5) {
                gradedPushes++;
            }
        } else {
            ungradedCount++;
        }
    };

    const appIdCondition = buildAppIdCondition(appIdFilter);

    if (ctx.qdrant && ctx.isAvailable) {
        const runScrollFallback = async (useServerFilter: boolean): Promise<boolean> => {
            if (typeof (ctx.qdrant as any).scroll !== 'function') return false;
            let nextOffset: string | number | undefined = undefined;
            let hasMore = true;
            let batchCount = 0;
            const scrollFilter = useServerFilter ? combineFilter(appIdCondition) : undefined;

            while (hasMore && batchCount < 20) {
                const scrollResAll: any = await ctx.withTimeout((ctx.qdrant as any).scroll(ctx.collectionName, {
                    limit: 1000,
                    offset: nextOffset,
                    ...(scrollFilter ? { filter: scrollFilter } : {}),
                    with_payload: true,
                    with_vector: false
                }));

                for (const pt of (scrollResAll?.points || [])) {
                    const payload = (pt.payload || {}) as Record<string, any>;
                    const itemAppId = payload.originApp || payload.appId || ctx.defaultAppId;
                    apps.add(itemAppId);

                    if (!appIdFilter || appIdFilter === 'global' || itemAppId === appIdFilter) {
                        processPoint(payload);
                    }
                }

                nextOffset = scrollResAll?.next_page_offset;
                hasMore = nextOffset !== null && nextOffset !== undefined;
                batchCount++;
            }
            return true;
        };

        try {
            if (typeof (ctx.qdrant as any).count === 'function') {
                const totalFilter = combineFilter(appIdCondition);
                const gradedFilter = combineFilter(appIdCondition, {
                    should: [
                        { must_not: [{ is_empty: { key: 'gradedAt' } }] },
                        { key: 'feedbackProcessed', match: { value: true } },
                        { must_not: [{ is_empty: { key: 'outcome' } }] }
                    ]
                });
                const winsFilter = combineFilter(appIdCondition, {
                    should: [
                        { key: 'outcome', match: { value: 'win' } },
                        { key: 'qualityRating', range: { gte: 1.0, lte: 1.0 } }
                    ]
                });
                const lossesFilter = combineFilter(appIdCondition, {
                    should: [
                        { key: 'outcome', match: { value: 'loss' } },
                        { key: 'qualityRating', range: { gte: 0.0, lte: 0.0 } }
                    ]
                });
                const pushesFilter = combineFilter(appIdCondition, {
                    should: [
                        { key: 'outcome', match: { value: 'push' } },
                        { key: 'qualityRating', range: { gte: 0.5, lte: 0.5 } }
                    ]
                });

                const [totalRes, gradedRes, winsRes, lossesRes, pushesRes]: any[] = await Promise.all([
                    ctx.withTimeout((ctx.qdrant as any).count(ctx.collectionName, { filter: totalFilter, exact: true })),
                    ctx.withTimeout((ctx.qdrant as any).count(ctx.collectionName, { filter: gradedFilter, exact: true })),
                    ctx.withTimeout((ctx.qdrant as any).count(ctx.collectionName, { filter: winsFilter, exact: true })),
                    ctx.withTimeout((ctx.qdrant as any).count(ctx.collectionName, { filter: lossesFilter, exact: true })),
                    ctx.withTimeout((ctx.qdrant as any).count(ctx.collectionName, { filter: pushesFilter, exact: true }))
                ]);

                pointCount = typeof totalRes?.count === 'number' ? totalRes.count : 0;
                gradedCount = typeof gradedRes?.count === 'number' ? gradedRes.count : 0;
                gradedWins = typeof winsRes?.count === 'number' ? winsRes.count : 0;
                gradedLosses = typeof lossesRes?.count === 'number' ? lossesRes.count : 0;
                gradedPushes = typeof pushesRes?.count === 'number' ? pushesRes.count : 0;
                ungradedCount = Math.max(0, pointCount - gradedCount);

                if (appIdFilter && appIdFilter !== 'global') {
                    apps.add(appIdFilter);
                }

                if (options?.includeBreakdown && typeof (ctx.qdrant as any).scroll === 'function') {
                    let nextOffset: string | number | undefined = undefined;
                    let hasMore = true;
                    let batchCount = 0;

                    while (hasMore && batchCount < 20) {
                        const scrollRes: any = await ctx.withTimeout((ctx.qdrant as any).scroll(ctx.collectionName, {
                            limit: 1000,
                            offset: nextOffset,
                            filter: totalFilter,
                            with_payload: ['domain', 'agentRole', 'appId', 'originApp'],
                            with_vector: false
                        }));

                        for (const pt of (scrollRes?.points || [])) {
                            const payload = (pt.payload || {}) as Record<string, any>;
                            const itemAppId = payload.originApp || payload.appId || ctx.defaultAppId;
                            apps.add(itemAppId);
                            const domain = payload.domain || 'general';
                            const role = payload.agentRole || 'unknown';
                            storageByDomain[domain] = (storageByDomain[domain] || 0) + 1;
                            storageByRole[role] = (storageByRole[role] || 0) + 1;
                        }

                        nextOffset = scrollRes?.next_page_offset;
                        hasMore = nextOffset !== null && nextOffset !== undefined;
                        batchCount++;
                    }
                }

                qdrantSuccess = true;
            } else if (typeof (ctx.qdrant as any).scroll === 'function') {
                qdrantSuccess = await runScrollFallback(true);
            } else {
                for (const pt of ctx.fallbackStore) {
                    const itemAppId = pt.payload.originApp || pt.payload.appId || ctx.defaultAppId;
                    apps.add(itemAppId);

                    if (!appIdFilter || appIdFilter === 'global' || itemAppId === appIdFilter) {
                        processPoint(pt.payload);
                    }
                }
                qdrantSuccess = true;
            }
        } catch {
            pointCount = 0;
            gradedCount = 0;
            ungradedCount = 0;
            gradedWins = 0;
            gradedLosses = 0;
            gradedPushes = 0;
            qdrantSuccess = false;
            try {
                qdrantSuccess = await runScrollFallback(false);
            } catch {
                qdrantSuccess = false;
            }
        }
    }

    // Fallback store processing if Qdrant failed or was unavailable
    if (!qdrantSuccess && ctx.fallbackStore.length > 0) {
        for (const pt of ctx.fallbackStore) {
            const itemAppId = pt.payload.originApp || pt.payload.appId || ctx.defaultAppId;
            apps.add(itemAppId);

            if (!appIdFilter || appIdFilter === 'global' || itemAppId === appIdFilter) {
                processPoint(pt.payload);
            }
        }
    }

    const headlineAccuracy = gradedCount > 0 ? (gradedWins / gradedCount) : null;

    return {
        qdrantAvailable: ctx.isAvailable,
        collectionName: ctx.collectionName,
        pointCount,
        appCount: apps.size,
        apps: Array.from(apps),
        fallbackStoreSize: ctx.fallbackStore.length,
        storageByDomain,
        storageByRole,
        gradedCount,
        ungradedCount,
        gradedWins,
        gradedLosses,
        gradedPushes,
        headlineAccuracy
    };
}
