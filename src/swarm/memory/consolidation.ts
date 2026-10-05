import type { QdrantClient } from '@qdrant/js-client-rest';
import type { VectorIndex } from '../vectorIndex.ts';
import type { StoredMemoryPoint, ConsolidationOptions, ConsolidationResult } from './types.ts';

export interface ConsolidationContext {
    fallbackStore: StoredMemoryPoint[];
    vectorIndex: VectorIndex<StoredMemoryPoint>;
    qdrant: QdrantClient | null;
    isAvailable: boolean;
    collectionName: string;
    savePersistFileIfConfigured: () => Promise<void>;
}

/**
 * Consolidates and prunes memories based on minimum quality rating, expiration age, and optional appId filter.
 */
export async function executeMemoryConsolidation(
    ctx: ConsolidationContext,
    options?: ConsolidationOptions
): Promise<ConsolidationResult> {
    const minRating = options?.minRating ?? 0.40;
    const pruneLowQuality = options?.pruneLowQuality ?? true;
    const appId = options?.appId;
    const maxAgeDays = options?.maxAgeDays;

    const prunedIds: string[] = [];
    let inspected = 0;

    // Process in-memory fallback store
    if (ctx.fallbackStore.length > 0) {
        const now = Date.now();
        const remaining: StoredMemoryPoint[] = [];
        for (const pt of ctx.fallbackStore) {
            const itemApp = pt.payload.originApp || pt.payload.appId;
            if (appId && itemApp !== appId) {
                remaining.push(pt);
                continue;
            }
            inspected++;
            let shouldPrune = false;
            if (pruneLowQuality && (pt.payload.qualityRating ?? 0) < minRating) {
                shouldPrune = true;
            }
            if (maxAgeDays !== undefined && pt.payload.timestamp) {
                const ageDays = (now - new Date(pt.payload.timestamp).getTime()) / (1000 * 60 * 60 * 24);
                if (ageDays > maxAgeDays && !pt.payload.verified) {
                    shouldPrune = true;
                }
            }
            if (shouldPrune) {
                prunedIds.push(pt.id);
            } else {
                remaining.push(pt);
            }
        }
        ctx.fallbackStore.length = 0;
        ctx.fallbackStore.push(...remaining);
        for (const pId of prunedIds) {
            ctx.vectorIndex.delete(pId);
        }
    }

    // Process Qdrant store if available
    if (ctx.qdrant && ctx.isAvailable) {
        try {
            if (typeof (ctx.qdrant as any).scroll === 'function') {
                const scrollFilter: any[] = [];
                if (appId) {
                    scrollFilter.push({
                        should: [
                            { key: "originApp", match: { value: appId } },
                            { key: "appId", match: { value: appId } }
                        ]
                    });
                }
                const scrollRes = await (ctx.qdrant as any).scroll(ctx.collectionName, {
                    filter: scrollFilter.length > 0 ? { must: scrollFilter } : undefined,
                    limit: 1000,
                    with_payload: true
                });
                const now = Date.now();
                const qdrantPruneIds: string[] = [];
                for (const pt of (scrollRes.points || [])) {
                    inspected++;
                    const payload = (pt.payload || {}) as Record<string, any>;
                    let shouldPrune = false;
                    if (pruneLowQuality && (payload.qualityRating ?? 0) < minRating) {
                        shouldPrune = true;
                    }
                    if (maxAgeDays !== undefined && payload.timestamp) {
                        const ageDays = (now - new Date(payload.timestamp).getTime()) / (1000 * 60 * 60 * 24);
                        if (ageDays > maxAgeDays && !payload.verified) {
                            shouldPrune = true;
                        }
                    }
                    if (shouldPrune) {
                        qdrantPruneIds.push(String(pt.id));
                        prunedIds.push(String(pt.id));
                    }
                }
                if (qdrantPruneIds.length > 0 && typeof (ctx.qdrant as any).delete === 'function') {
                    await (ctx.qdrant as any).delete(ctx.collectionName, {
                        wait: true,
                        points: qdrantPruneIds
                    });
                }
            } else if (typeof (ctx.qdrant as any).delete === 'function') {
                const filterMust: any[] = [];
                if (appId) filterMust.push({ key: "appId", match: { value: appId } });
                if (pruneLowQuality) filterMust.push({ key: "qualityRating", range: { lt: minRating } });
                await (ctx.qdrant as any).delete(ctx.collectionName, {
                    wait: true,
                    filter: { must: filterMust }
                });
            }
        } catch (err: any) {
            console.warn(`[MemoryCortex] ConsolidateMemories Qdrant error: ${err.message || err}`);
        }
    }

    if (prunedIds.length > 0) {
        await ctx.savePersistFileIfConfigured();
    }

    return {
        inspected,
        pruned: prunedIds.length,
        retained: Math.max(0, inspected - prunedIds.length),
        prunedIds
    };
}
