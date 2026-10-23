import { createVectorIndex, type VectorIndex, type VectorIndexMetrics } from '../../vectorIndex.ts';
import { cosineSimilarity } from '../vectorMath.ts';
import { normalizeDomain, type StoredMemoryPoint, type SparseVector } from '../types.ts';
import type { StorageBackend, StorageFilterOptions, StorageQueryOptions, StorageQueryResult } from './types.ts';

export interface InMemoryStorageConfig {
    collectionName?: string;
    isolatedStore?: boolean;
}

export class InMemoryStorageAdapter implements StorageBackend {
    private static globalStores = new Map<string, StoredMemoryPoint[]>();
    private static globalVectorIndexes = new Map<string, VectorIndex<StoredMemoryPoint>>();

    readonly isAvailable: boolean = true;
    private collectionName: string;
    private points: StoredMemoryPoint[];
    private vectorIndex: VectorIndex<StoredMemoryPoint>;

    static clearGlobalStore(collectionName: string = 'pwa_swarm_dev_cortex_v2'): void {
        const store = InMemoryStorageAdapter.globalStores.get(collectionName);
        if (store) store.length = 0;
        const idx = InMemoryStorageAdapter.globalVectorIndexes.get(collectionName);
        if (idx) idx.clear();
    }

    constructor(config: InMemoryStorageConfig = {}) {
        this.collectionName = config.collectionName || 'pwa_swarm_dev_cortex_v2';

        if (config.isolatedStore) {
            this.points = [];
            this.vectorIndex = createVectorIndex<StoredMemoryPoint>('vptree', { metric: 'cosine' });
        } else {
            if (!InMemoryStorageAdapter.globalStores.has(this.collectionName)) {
                InMemoryStorageAdapter.globalStores.set(this.collectionName, []);
            }
            this.points = InMemoryStorageAdapter.globalStores.get(this.collectionName)!;

            if (!InMemoryStorageAdapter.globalVectorIndexes.has(this.collectionName)) {
                const idx = createVectorIndex<StoredMemoryPoint>('vptree', { metric: 'cosine' });
                for (const pt of this.points) {
                    idx.insert(pt.id, pt.denseVector, pt);
                }
                InMemoryStorageAdapter.globalVectorIndexes.set(this.collectionName, idx);
            }
            this.vectorIndex = InMemoryStorageAdapter.globalVectorIndexes.get(this.collectionName)!;
            if (this.points.length > 0 && this.vectorIndex.size !== this.points.length) {
                this.syncVectorIndex();
            }
        }
    }

    get size(): number {
        return this.points.length;
    }

    async initialize(_appId?: string): Promise<boolean> {
        return true;
    }

    private syncVectorIndex(): void {
        this.vectorIndex.clear();
        for (const pt of this.points) {
            this.vectorIndex.insert(pt.id, pt.denseVector, pt);
        }
    }

    getIndexMetrics(): VectorIndexMetrics {
        return this.vectorIndex.getMetrics();
    }

    async get(id: string): Promise<StoredMemoryPoint | null> {
        const pt = this.points.find(p => p.id === id);
        return pt ? { ...pt } : null;
    }

    async store(point: StoredMemoryPoint, deduplicate: boolean = true): Promise<string | null> {
        const originApp = point.payload.originApp || point.payload.appId || 'default';
        const now = new Date().toISOString();

        if (deduplicate) {
            const match = this.vectorIndex.findMostSimilar(
                point.denseVector,
                0.92,
                (item) => {
                    const itemApp = item.data.payload.originApp || item.data.payload.appId;
                    if (itemApp !== originApp) return false;

                    const existingWf = item.data.payload.workflowId;
                    const newWf = point.payload.workflowId;
                    if (existingWf && newWf && existingWf !== newWf) return false;
                    return true;
                }
            );

            if (match) {
                const existing = match.data;
                existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                existing.payload.lastSeen = now;
                if (point.payload.qualityRating !== undefined) {
                    existing.payload.qualityRating = Math.max(
                        point.payload.qualityRating,
                        existing.payload.qualityRating || 0
                    );
                }
                if (point.payload.verified !== undefined) {
                    existing.payload.verified = point.payload.verified;
                }
                if (point.payload.feedback) {
                    existing.payload.feedback = point.payload.feedback;
                }
                return existing.id;
            }
        }

        this.points.push(point);
        this.vectorIndex.insert(point.id, point.denseVector, point);
        return point.id;
    }

    async storeBatch(points: StoredMemoryPoint[]): Promise<string[]> {
        const ids: string[] = [];
        for (const pt of points) {
            const id = await this.store(pt, false);
            if (id) ids.push(id);
        }
        return ids;
    }

    async setPayload(id: string, payload: Partial<Record<string, any>>): Promise<boolean> {
        const pt = this.points.find(p => p.id === id);
        if (!pt) return false;

        pt.payload = {
            ...pt.payload,
            ...payload
        };
        return true;
    }

    async search(
        queryDense: number[],
        options: StorageQueryOptions,
        _querySparse?: SparseVector
    ): Promise<StorageQueryResult[]> {
        if (this.points.length === 0) return [];

        const readerApp = options.appId || options.originApp;
        const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;

        const filterPredicate = (pt: StoredMemoryPoint) => {
            if (options.includeShared === false && readerApp) {
                const itemApp = pt.payload.originApp || pt.payload.appId;
                if (itemApp !== readerApp) return false;
            }
            if (requestedDomain) {
                const itemDomain = normalizeDomain(pt.payload.domain);
                if (itemDomain !== requestedDomain) return false;
            }
            if (options.agentRole && pt.payload.agentRole !== options.agentRole) return false;
            if (options.minRating !== undefined && (pt.payload.qualityRating ?? 0) < options.minRating) return false;
            if (options.verifiedOnly && pt.payload.verified !== true && pt.payload.memoryType !== 'fact') return false;
            return true;
        };

        const searchK = Math.min(this.vectorIndex.size, Math.max((options.limit || 3) * 3, 15));
        const indexHits = this.vectorIndex.search(queryDense, {
            k: searchK,
            filter: (item) => filterPredicate(item.data)
        });

        let candidates: StoredMemoryPoint[];
        if (indexHits.length > 0) {
            candidates = indexHits.map(h => h.data);
        } else {
            candidates = this.points.filter(filterPredicate);
        }

        if (candidates.length === 0) return [];

        const results: StorageQueryResult[] = candidates.map(pt => ({
            id: pt.id,
            payload: pt.payload,
            vectorScore: cosineSimilarity(queryDense, pt.denseVector)
        }));

        if (options.scoreThreshold !== undefined) {
            return results.filter(r => r.vectorScore >= options.scoreThreshold!);
        }

        return results.sort((a, b) => b.vectorScore - a.vectorScore).slice(0, options.limit || 10);
    }

    async delete(ids: string[]): Promise<boolean> {
        const idSet = new Set(ids);
        const originalLen = this.points.length;
        const remaining = this.points.filter(pt => !idSet.has(pt.id));
        this.points.length = 0;
        this.points.push(...remaining);
        this.syncVectorIndex();
        return this.points.length < originalLen;
    }

    async wipe(appId?: string): Promise<boolean> {
        if (!appId) {
            this.points.length = 0;
            this.vectorIndex.clear();
            return true;
        }

        const remaining = this.points.filter(pt => {
            const itemApp = pt.payload.originApp || pt.payload.appId;
            return itemApp !== appId;
        });
        this.points.length = 0;
        this.points.push(...remaining);
        this.syncVectorIndex();
        return true;
    }

    async scroll(filter?: StorageFilterOptions): Promise<StoredMemoryPoint[]> {
        if (!filter) {
            return [...this.points];
        }

        const readerApp = filter.appId || filter.originApp;
        const requestedDomain = filter.domain ? normalizeDomain(filter.domain) : undefined;

        return this.points.filter(pt => {
            if (filter.includeShared === false && readerApp) {
                const itemApp = pt.payload.originApp || pt.payload.appId;
                if (itemApp !== readerApp) return false;
            }
            if (readerApp && !filter.includeShared) {
                const itemApp = pt.payload.originApp || pt.payload.appId;
                if (itemApp !== readerApp) return false;
            }
            if (requestedDomain) {
                const itemDomain = normalizeDomain(pt.payload.domain);
                if (itemDomain !== requestedDomain) return false;
            }
            if (filter.agentRole && pt.payload.agentRole !== filter.agentRole) return false;
            if (filter.minRating !== undefined && (pt.payload.qualityRating ?? 0) < filter.minRating) return false;
            if (filter.verifiedOnly && pt.payload.verified !== true && pt.payload.memoryType !== 'fact') return false;
            return true;
        });
    }

    getRawStore(): StoredMemoryPoint[] {
        return this.points;
    }
}
