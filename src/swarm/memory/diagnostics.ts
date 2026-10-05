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
    const apps = new Set<string>();
    const storageByDomain: Record<string, number> = {};
    const storageByRole: Record<string, number> = {};

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
                            pointCount++;
                            const domain = payload.domain || 'general';
                            const role = payload.agentRole || 'unknown';
                            storageByDomain[domain] = (storageByDomain[domain] || 0) + 1;
                            storageByRole[role] = (storageByRole[role] || 0) + 1;
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
                        pointCount++;
                        const domain = pt.payload.domain || 'general';
                        const role = pt.payload.agentRole || 'unknown';
                        storageByDomain[domain] = (storageByDomain[domain] || 0) + 1;
                        storageByRole[role] = (storageByRole[role] || 0) + 1;
                    }
                }
            }
        } catch {
            console.warn("[MemoryCortex] getDiagnostics qdrant error, falling back to in-memory stats.");
            pointCount = 0; // reset to let fallback take over below if needed
        }
    }

    // If qdrant failed or we are using fallback only
    if (pointCount === 0 && ctx.fallbackStore.length > 0) {
        for (const pt of ctx.fallbackStore) {
            const itemAppId = pt.payload.originApp || pt.payload.appId || ctx.defaultAppId;
            apps.add(itemAppId);

            if (!appIdFilter || appIdFilter === 'global' || itemAppId === appIdFilter) {
                pointCount++;
                const domain = pt.payload.domain || 'general';
                const role = pt.payload.agentRole || 'unknown';
                storageByDomain[domain] = (storageByDomain[domain] || 0) + 1;
                storageByRole[role] = (storageByRole[role] || 0) + 1;
            }
        }
    }

    return {
        qdrantAvailable: ctx.isAvailable,
        collectionName: ctx.collectionName,
        pointCount,
        appCount: apps.size,
        apps: Array.from(apps),
        fallbackStoreSize: ctx.fallbackStore.length,
        storageByDomain,
        storageByRole
    };
}
