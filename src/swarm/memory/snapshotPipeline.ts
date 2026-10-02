import type { QdrantClient } from '@qdrant/js-client-rest';
import type { VectorIndex } from '../vectorIndex.ts';
import { SparseTokenizer } from './tokenizer.ts';
import type {
    MemoryMetadata,
    ExportMemoriesOptions,
    MemorySnapshotPoint,
    MemorySnapshot,
    ImportMemoriesOptions,
    ImportMemoriesResult,
    StoredMemoryPoint,
    SparseVector
} from './types.ts';

export interface SnapshotContext {
    fallbackStore: StoredMemoryPoint[];
    vectorIndex: VectorIndex<StoredMemoryPoint>;
    qdrant: QdrantClient | null;
    isAvailable: boolean;
    collectionName: string;
    defaultAppId: string;
    persistPath?: string;
    isAutoLoading: boolean;
    safeEmbed: (text: string) => Promise<number[]>;
    withTimeout: <T>(promise: Promise<T>, ms?: number) => Promise<T>;
    savePersistFileIfConfigured: () => Promise<void>;
}

/**
 * Exports a portable snapshot of stored memories filtered by options.
 */
export async function exportMemoriesSnapshot(
    ctx: SnapshotContext,
    options?: ExportMemoriesOptions
): Promise<MemorySnapshot> {
    const minRating = options?.minRating;
    const verifiedOnly = options?.verifiedOnly;
    const appId = options?.appId;
    const includeVectors = options?.includeVectors !== false;

    const snapshotPoints: MemorySnapshotPoint[] = [];

    // 1. In-memory fallback points
    if (ctx.fallbackStore.length > 0) {
        for (const pt of ctx.fallbackStore) {
            if (appId && pt.payload.appId !== appId) continue;
            if (minRating !== undefined && (pt.payload.qualityRating ?? 0) < minRating) continue;
            if (verifiedOnly && !pt.payload.verified) continue;

            snapshotPoints.push({
                id: pt.id,
                content: pt.payload.content,
                metadata: { ...pt.payload },
                denseVector: includeVectors ? pt.denseVector : undefined,
                sparseVector: includeVectors ? pt.sparseVector : undefined
            });
        }
    }

    // 2. Qdrant points if available
    if (ctx.qdrant && ctx.isAvailable) {
        try {
            if (typeof (ctx.qdrant as any).scroll === 'function') {
                const scrollFilter: any[] = [];
                if (appId) scrollFilter.push({ key: "appId", match: { value: appId } });
                if (minRating !== undefined) scrollFilter.push({ key: "qualityRating", range: { gte: minRating } });
                if (verifiedOnly) scrollFilter.push({ key: "verified", match: { value: true } });

                const scrollRes = await (ctx.qdrant as any).scroll(ctx.collectionName, {
                    filter: scrollFilter.length > 0 ? { must: scrollFilter } : undefined,
                    limit: 1000,
                    with_payload: true,
                    with_vector: includeVectors
                });

                for (const pt of (scrollRes.points || [])) {
                    if (snapshotPoints.some(sp => sp.id === String(pt.id))) continue;

                    const payload = (pt.payload || {}) as Record<string, any>;
                    let denseVec: number[] | undefined;
                    let sparseVec: SparseVector | undefined;

                    if (includeVectors && pt.vector) {
                        if (Array.isArray(pt.vector)) {
                            denseVec = pt.vector;
                        } else if (typeof pt.vector === 'object') {
                            denseVec = pt.vector.dense;
                            sparseVec = pt.vector.sparse;
                        }
                    }

                    snapshotPoints.push({
                        id: String(pt.id),
                        content: payload.content || '',
                        metadata: payload as any,
                        denseVector: denseVec,
                        sparseVector: sparseVec
                    });
                }
            }
        } catch (err: any) {
            console.warn(`[MemoryCortex] ExportMemories Qdrant scroll error: ${err.message || err}`);
        }
    }

    return {
        version: "1.0.0",
        exportedAt: new Date().toISOString(),
        collectionName: ctx.collectionName,
        pointCount: snapshotPoints.length,
        memories: snapshotPoints
    };
}

/**
 * Saves all cortex memories to a local snapshot file.
 */
export async function saveMemoriesToFile(
    ctx: SnapshotContext,
    filePath?: string
): Promise<string> {
    const targetPath = filePath || ctx.persistPath;
    if (!targetPath) {
        throw new Error("[MemoryCortex] saveToFile requires a filePath or configured persistPath");
    }
    let fs, path;
    try {
        fs = await import('no' + 'de:fs');
        path = await import('no' + 'de:path');
    } catch {
        throw new Error("[MemoryCortex] Local file saving is not supported in this environment (Edge/Browser).");
    }
    
    const dir = path.dirname(targetPath);
    if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const isJsonl = targetPath.endsWith('.jsonl');
    const snapshot = await exportMemoriesSnapshot(ctx);
    const content = isJsonl
        ? snapshot.memories.map(m => JSON.stringify(m)).join('\n')
        : JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(targetPath, content, 'utf-8');
    return targetPath;
}

/**
 * Loads memories from a local snapshot file (JSON or JSONL) into the cortex.
 */
export async function loadMemoriesFromFile(
    ctx: SnapshotContext,
    filePath?: string,
    options?: ImportMemoriesOptions
): Promise<ImportMemoriesResult> {
    const targetPath = filePath || ctx.persistPath;
    if (!targetPath) {
        throw new Error("[MemoryCortex] loadFromFile requires a filePath or configured persistPath");
    }
    
    let fs;
    try {
        fs = await import('no' + 'de:fs');
    } catch {
        throw new Error("[MemoryCortex] Local file loading is not supported in this environment (Edge/Browser).");
    }

    if (!fs.existsSync(targetPath)) {
        throw new Error(`[MemoryCortex] Snapshot file not found: ${targetPath}`);
    }
    const raw = fs.readFileSync(targetPath, 'utf-8');
    return await importMemoriesSnapshot(ctx, raw, options);
}

/**
 * Imports a portable snapshot or array of memories into the Cortex.
 */
export async function importMemoriesSnapshot(
    ctx: SnapshotContext,
    input: MemorySnapshot | string | any[],
    options?: ImportMemoriesOptions
): Promise<ImportMemoriesResult> {
    const deduplicate = options?.deduplicate !== false;
    const recomputeVectors = options?.recomputeVectors ?? false;
    const targetAppId = options?.targetAppId;
    const minRating = options?.minRating;

    let rawItems: any[] = [];

    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('{') && !trimmed.includes('\n{"')) {
            try {
                const parsed = JSON.parse(trimmed);
                rawItems = parsed.memories && Array.isArray(parsed.memories) ? parsed.memories : [parsed];
            } catch {
                rawItems = trimmed.split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l));
            }
        } else {
            rawItems = trimmed.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)
                .map(l => JSON.parse(l));
        }
    } else if (Array.isArray(input)) {
        rawItems = input;
    } else if (input && typeof input === 'object' && Array.isArray((input as any).memories)) {
        rawItems = (input as any).memories;
    }

    let imported = 0;
    let skipped = 0;
    let deduplicated = 0;
    const importedIds: string[] = [];

    // Pre-filter items
    const validItems = [];
    for (const item of rawItems) {
        const content = item.content || item.payload?.content;
        if (!content) {
            skipped++;
            continue;
        }

        const rawMeta = item.metadata || item.payload || {};
        const qualityRating = rawMeta.qualityRating ?? item.qualityRating ?? 0.5;

        if (minRating !== undefined && qualityRating < minRating) {
            skipped++;
            continue;
        }

        const metadata: MemoryMetadata = {
            domain: rawMeta.domain || 'general',
            agentRole: rawMeta.agentRole || 'Analyst',
            ...rawMeta,
            appId: targetAppId || rawMeta.appId || ctx.defaultAppId,
            qualityRating,
            verified: rawMeta.verified ?? (qualityRating >= 0.8)
        };

        const pointId = item.id || crypto.randomUUID();
        validItems.push({ item, content, metadata, pointId });
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < validItems.length; i += BATCH_SIZE) {
        const batch = validItems.slice(i, i + BATCH_SIZE);
        const now = new Date().toISOString();

        // 1. Process Embeddings in Parallel
        const embeddedBatch = await Promise.all(batch.map(async (entry) => {
            const hasVectors = Array.isArray(entry.item.denseVector) && entry.item.denseVector.length > 0;
            const denseVector = (hasVectors && !recomputeVectors)
                ? entry.item.denseVector
                : await ctx.safeEmbed(entry.content);
            const sparseVector = entry.item.sparseVector || SparseTokenizer.encode(entry.content);
            return { ...entry, denseVector, sparseVector };
        }));

        // 2. Qdrant path
        let qdrantFailedForBatch = false;
        if (ctx.qdrant && ctx.isAvailable) {
            try {
                const pointsToUpsert = [];

                // Parallel deduplication queries
                if (deduplicate) {
                    const dedupResults = await Promise.all(embeddedBatch.map(async (entry) => {
                        const existing = await ctx.withTimeout(ctx.qdrant!.query(ctx.collectionName, {
                            query: entry.denseVector,
                            using: "dense",
                            limit: 1,
                            score_threshold: 0.92,
                            filter: {
                                must: [{ key: "appId", match: { value: entry.metadata.appId } }]
                            },
                            with_payload: true
                        }));
                        const isDup = existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92;
                        return { entry, isDup, dupId: isDup ? String(existing.points[0].id) : null };
                    }));

                    for (const result of dedupResults) {
                        if (result.isDup) {
                            deduplicated++;
                            importedIds.push(result.dupId!);
                        } else {
                            pointsToUpsert.push(result.entry);
                        }
                    }
                } else {
                    pointsToUpsert.push(...embeddedBatch);
                }

                if (pointsToUpsert.length > 0) {
                    await ctx.withTimeout(ctx.qdrant.upsert(ctx.collectionName, {
                        wait: false,
                        points: pointsToUpsert.map(entry => ({
                            id: entry.pointId,
                            vector: { dense: entry.denseVector, sparse: entry.sparseVector },
                            payload: {
                                content: entry.content,
                                frequency: 1,
                                timestamp: now,
                                lastSeen: now,
                                ...entry.metadata
                            }
                        }))
                    }));

                    imported += pointsToUpsert.length;
                    pointsToUpsert.forEach(entry => importedIds.push(entry.pointId));
                }
            } catch (err: any) {
                console.warn(`[MemoryCortex] Import Qdrant error: ${err.message || err}. Falling back to in-memory store for batch.`);
                qdrantFailedForBatch = true;
            }
        }

        // 3. Ephemeral fallback path
        if (!ctx.qdrant || !ctx.isAvailable || qdrantFailedForBatch) {
            for (const entry of embeddedBatch) {
                let isDup = false;
                if (deduplicate) {
                    const match = ctx.vectorIndex.findMostSimilar(
                        entry.denseVector,
                        0.92,
                        (item) => item.data.payload.appId === entry.metadata.appId
                    );
                    if (match) {
                        isDup = true;
                        const existing = match.data;
                        existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                        existing.payload.qualityRating = Math.max(entry.metadata.qualityRating ?? 0, existing.payload.qualityRating || 0);
                        deduplicated++;
                        importedIds.push(existing.id);
                    }
                }

                if (!isDup) {
                    const newPoint: StoredMemoryPoint = {
                        id: entry.pointId,
                        denseVector: entry.denseVector,
                        sparseVector: entry.sparseVector,
                        payload: {
                            content: entry.content,
                            appId: entry.metadata.appId!,
                            frequency: 1,
                            qualityRating: entry.metadata.qualityRating,
                            verified: entry.metadata.verified ?? false,
                            timestamp: now,
                            lastSeen: now,
                            ...entry.metadata
                        }
                    };
                    ctx.fallbackStore.push(newPoint);
                    ctx.vectorIndex.insert(entry.pointId, entry.denseVector, newPoint);
                    imported++;
                    importedIds.push(entry.pointId);
                }
            }
        }
    }

    if (!ctx.isAutoLoading && imported > 0) {
        await ctx.savePersistFileIfConfigured();
    }

    return {
        imported,
        skipped,
        deduplicated,
        importedIds
    };
}
