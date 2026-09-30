import { QdrantClient } from '@qdrant/js-client-rest';
import type {
    ExportMemoriesOptions, MemorySnapshot, MemorySnapshotPoint, StoredMemoryPoint, SparseVector
} from '../types.ts';

export class MemoryExporter {
    constructor(
        private qdrant: QdrantClient | undefined,
        private collectionName: string,
        private fallbackStore: StoredMemoryPoint[],
        private isAvailable: boolean
    ) {}

    async exportMemories(options?: ExportMemoriesOptions): Promise<MemorySnapshot> {
        const minRating = options?.minRating;
        const verifiedOnly = options?.verifiedOnly;
        const appId = options?.appId;
        const includeVectors = options?.includeVectors !== false;

        const snapshotPoints: MemorySnapshotPoint[] = [];

        if (this.fallbackStore.length > 0) {
            for (const pt of this.fallbackStore) {
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

        if (this.qdrant && this.isAvailable) {
            try {
                if (typeof (this.qdrant as any).scroll === 'function') {
                    const scrollFilter: any[] = [];
                    if (appId) scrollFilter.push({ key: "appId", match: { value: appId } });
                    if (minRating !== undefined) scrollFilter.push({ key: "qualityRating", range: { gte: minRating } });
                    if (verifiedOnly) scrollFilter.push({ key: "verified", match: { value: true } });

                    const scrollRes = await (this.qdrant as any).scroll(this.collectionName, {
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
            collectionName: this.collectionName,
            pointCount: snapshotPoints.length,
            memories: snapshotPoints
        };
    }
}
