import type { QdrantClient } from '@qdrant/js-client-rest';
import type { StoredMemoryPoint, MemoryCortexDiagnostics } from './types.ts';

export interface DiagnosticsContext {
    qdrant: QdrantClient | null;
    isAvailable: boolean;
    collectionName: string;
    fallbackStore: StoredMemoryPoint[];
    defaultAppId: string;
    withTimeout: <T>(promise: Promise<T>, ms?: number) => Promise<T>;
}

/**
 * Collects runtime storage distribution and health diagnostics across Qdrant and fallback stores.
 */
export async function collectCortexDiagnostics(
    ctx: DiagnosticsContext,
    appIdFilter?: string
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

    if (ctx.qdrant && ctx.isAvailable) {
        try {
            if (typeof (ctx.qdrant as any).scroll === 'function') {
                let nextOffset: string | number | undefined = undefined;
                let hasMore = true;
                let batchCount = 0;
                
                while (hasMore && batchCount < 20) { // Safe limit
                    const scrollResAll: any = await ctx.withTimeout((ctx.qdrant as any).scroll(ctx.collectionName, {
                        limit: 1000,
                        offset: nextOffset,
                        with_payload: true,
                        with_vector: false
                    }));
                    
                    for (const pt of (scrollResAll.points || [])) {
                        const payload = (pt.payload || {}) as Record<string, any>;
                        const itemAppId = payload.originApp || payload.appId || ctx.defaultAppId;
                        apps.add(itemAppId);

                        // Apply filter for stats
                        if (!appIdFilter || appIdFilter === 'global' || itemAppId === appIdFilter) {
                            processPoint(payload);
                        }
                    }
                    
                    nextOffset = scrollResAll.next_page_offset;
                    hasMore = nextOffset !== null && nextOffset !== undefined;
                    batchCount++;
                }
            } else {
                for (const pt of ctx.fallbackStore) {
                    const itemAppId = pt.payload.originApp || pt.payload.appId || ctx.defaultAppId;
                    apps.add(itemAppId);

                    if (!appIdFilter || appIdFilter === 'global' || itemAppId === appIdFilter) {
                        processPoint(pt.payload);
                    }
                }
            }
        } catch {
            console.warn("[MemoryCortex] getDiagnostics qdrant error, falling back to in-memory stats.");
            pointCount = 0;
            gradedCount = 0;
            ungradedCount = 0;
            gradedWins = 0;
            gradedLosses = 0;
            gradedPushes = 0;
        }
    }

    // If qdrant failed or we are using fallback only
    if (pointCount === 0 && ctx.fallbackStore.length > 0) {
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
