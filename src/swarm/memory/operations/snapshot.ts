import { QdrantClient } from '@qdrant/js-client-rest';
import type {
    ExportMemoriesOptions, MemorySnapshot, ImportMemoriesOptions,
    ImportMemoriesResult, ConsolidationOptions, ConsolidationResult, MemoryMetadata, StoredMemoryPoint, SparseVector
} from '../types.ts';
import { SparseTokenizer } from '../providers.ts';
import type { VectorIndex } from '../../vectorIndex.ts';

export class MemorySnapshotter {
    constructor(
        private qdrant: QdrantClient | undefined,
        private collectionName: string,
        private vectorIndex: VectorIndex,
        private fallbackStore: StoredMemoryPoint[],
        private isAvailable: boolean,
        private defaultAppId: string,
        private safeEmbed: (content: string) => Promise<number[]>,
        private withTimeout: <T>(promise: Promise<T>, ms?: number) => Promise<T>,
        private saveCallback: () => Promise<void>,
        private isAutoLoading: () => boolean
    ) {}

    async importMemories(
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
                rawItems = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0).map(l => JSON.parse(l));
            }
        } else if (Array.isArray(input)) {
            rawItems = input;
        } else if (input && typeof input === 'object' && Array.isArray((input as any).memories)) {
            rawItems = (input as any).memories;
        }

        let imported = 0, skipped = 0, deduplicated = 0;
        const importedIds: string[] = [];
        const validItems = [];

        for (const item of rawItems) {
            const content = item.content || item.payload?.content;
            if (!content) { skipped++; continue; }
            const rawMeta = item.metadata || item.payload || {};
            const qualityRating = rawMeta.qualityRating ?? item.qualityRating ?? 0.5;
            if (minRating !== undefined && qualityRating < minRating) { skipped++; continue; }
            const metadata: MemoryMetadata = {
                domain: rawMeta.domain || 'general',
                agentRole: rawMeta.agentRole || 'Analyst',
                ...rawMeta,
                appId: targetAppId || rawMeta.appId || this.defaultAppId,
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
            const embeddedBatch = await Promise.all(batch.map(async (entry) => {
                const hasVectors = Array.isArray(entry.item.denseVector) && entry.item.denseVector.length > 0;
                const denseVector = (hasVectors && !recomputeVectors) ? entry.item.denseVector : await this.safeEmbed(entry.content);
                const sparseVector = entry.item.sparseVector || SparseTokenizer.encode(entry.content);
                return { ...entry, denseVector, sparseVector };
            }));

            let qdrantFailedForBatch = false;
            if (this.qdrant && this.isAvailable) {
                try {
                    const pointsToUpsert = [];
                    if (deduplicate) {
                        const dedupResults = await Promise.all(embeddedBatch.map(async (entry) => {
                            const existing = await this.withTimeout(this.qdrant!.query(this.collectionName, {
                                query: entry.denseVector, using: "dense", limit: 1, score_threshold: 0.92,
                                filter: { must: [{ key: "appId", match: { value: entry.metadata.appId } }] }, with_payload: true
                            }));
                            const isDup = existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92;
                            return { entry, isDup, dupId: isDup ? String(existing.points[0].id) : null };
                        }));
                        for (const result of dedupResults) {
                            if (result.isDup) { deduplicated++; importedIds.push(result.dupId!); }
                            else { pointsToUpsert.push(result.entry); }
                        }
                    } else {
                        pointsToUpsert.push(...embeddedBatch);
                    }
                    if (pointsToUpsert.length > 0) {
                        await this.withTimeout(this.qdrant.upsert(this.collectionName, {
                            wait: false,
                            points: pointsToUpsert.map(entry => ({
                                id: entry.pointId, vector: { dense: entry.denseVector, sparse: entry.sparseVector },
                                payload: { content: entry.content, frequency: 1, timestamp: now, lastSeen: now, ...entry.metadata }
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

            if (!this.qdrant || !this.isAvailable || qdrantFailedForBatch) {
                for (const entry of embeddedBatch) {
                    let isDup = false;
                    if (deduplicate) {
                        const match = this.vectorIndex.findMostSimilar(entry.denseVector, 0.92, (item) => item.data.payload.appId === entry.metadata.appId);
                        if (match) {
                            isDup = true; const existing = match.data;
                            existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                            existing.payload.qualityRating = Math.max(entry.metadata.qualityRating ?? 0, existing.payload.qualityRating || 0);
                            deduplicated++; importedIds.push(existing.id);
                        }
                    }
                    if (!isDup) {
                        const newPoint: StoredMemoryPoint = {
                            id: entry.pointId, denseVector: entry.denseVector, sparseVector: entry.sparseVector,
                            payload: { content: entry.content, appId: entry.metadata.appId!, frequency: 1, qualityRating: entry.metadata.qualityRating, verified: entry.metadata.verified ?? false, timestamp: now, lastSeen: now, ...entry.metadata }
                        };
                        this.fallbackStore.push(newPoint);
                        this.vectorIndex.insert(entry.pointId, entry.denseVector, newPoint);
                        imported++; importedIds.push(entry.pointId);
                    }
                }
            }
        }
        if (!this.isAutoLoading() && imported > 0) await this.saveCallback();
        return { imported, skipped, deduplicated, importedIds };
    }
}
