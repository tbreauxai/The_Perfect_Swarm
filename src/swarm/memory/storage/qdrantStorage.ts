import { QdrantClient } from '@qdrant/js-client-rest';
import type { StoredMemoryPoint, SparseVector } from '../types.ts';
import { normalizeDomain } from '../types.ts';
import type { StorageBackend, StorageFilterOptions, StorageQueryOptions, StorageQueryResult } from './types.ts';

export interface QdrantStorageConfig {
    url?: string;
    apiKey?: string;
    collectionName?: string;
    collectionNameTemplate?: string;
    denseDimension?: number;
    client?: QdrantClient;
    timeoutMs?: number;
}

export class QdrantStorageAdapter implements StorageBackend {
    private client: QdrantClient | null = null;
    private collectionName: string;
    private collectionNameTemplate?: string;
    private denseDimension: number;
    private timeoutMs: number;
    private initializedCollections: Set<string> = new Set();
    private available: boolean = false;

    constructor(config: QdrantStorageConfig = {}) {
        this.collectionName = config.collectionName || 'pwa_swarm_dev_cortex_v2';
        this.collectionNameTemplate = config.collectionNameTemplate;
        this.denseDimension = config.denseDimension || 768;
        this.timeoutMs = config.timeoutMs || 3000;

        if (config.client) {
            this.client = config.client;
            this.available = true;
        } else if (config.url) {
            try {
                new URL(config.url);
                this.client = new QdrantClient({
                    url: config.url,
                    apiKey: config.apiKey,
                    checkCompatibility: false
                });
                this.available = true;
            } catch (err: any) {
                console.warn(`[MemoryCortex] Invalid Qdrant URL '${config.url}', vector memory will run in disabled mode.`);
                this.available = false;
            }
        }
    }

    get isAvailable(): boolean {
        return this.available && this.client !== null;
    }

    get size(): number {
        return 0; // Dynamic remote count; use count() for exact number
    }

    getRawClient(): QdrantClient | null {
        return this.client;
    }

    private getTargetCollection(appId?: string): string {
        if (this.collectionNameTemplate && appId) {
            return this.collectionNameTemplate.replace('{appId}', appId);
        }
        return this.collectionName;
    }

    private async withTimeout<T>(promise: Promise<T>, ms: number = this.timeoutMs): Promise<T> {
        let timeoutId: any;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Qdrant operation timed out after ${ms}ms`));
            }, ms);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async ensurePayloadIndex(
        collection: string,
        fieldName: string,
        fieldSchema: 'keyword' | 'float' | 'integer' | 'bool'
    ): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.createPayloadIndex(collection, {
                field_name: fieldName,
                field_schema: fieldSchema
            });
        } catch {
            // Idempotent: ignore if index already exists
        }
    }

    async initialize(appId?: string): Promise<boolean> {
        if (!this.client || !this.available) return false;
        const targetCollection = this.getTargetCollection(appId);
        if (this.initializedCollections.has(targetCollection)) return true;

        try {
            const collections = await this.withTimeout(this.client.getCollections(), 5000);
            const exists = collections.collections.some(c => c.name === targetCollection);

            if (!exists) {
                await this.withTimeout(
                    this.client.createCollection(targetCollection, {
                        vectors: {
                            dense: {
                                size: this.denseDimension,
                                distance: 'Cosine',
                                on_disk: true
                            }
                        },
                        sparse_vectors: {
                            sparse: {
                                index: {
                                    on_disk: true
                                }
                            }
                        },
                        quantization_config: {
                            scalar: {
                                type: 'int8',
                                quantile: 0.99,
                                always_ram: true
                            }
                        },
                        hnsw_config: {
                            m: 16,
                            ef_construct: 128,
                            on_disk: true
                        },
                        optimizers_config: {
                            default_segment_number: 2,
                            deleted_threshold: 0.2
                        },
                        on_disk_payload: true
                    }),
                    10000
                );
            }

            await Promise.all([
                this.ensurePayloadIndex(targetCollection, 'originApp', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'domain', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'memoryType', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'entityIds', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'workflowId', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'appId', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'targetApps', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'agentRole', 'keyword'),
                this.ensurePayloadIndex(targetCollection, 'qualityRating', 'float'),
                this.ensurePayloadIndex(targetCollection, 'verified', 'bool')
            ]);

            this.initializedCollections.add(targetCollection);
            return true;
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] Initialization failed for ${targetCollection}: ${err.message || err}`);
            this.available = false;
            return false;
        }
    }

    async store(point: StoredMemoryPoint, deduplicate: boolean = true): Promise<string | null> {
        if (!this.client || !this.available) return null;
        const originApp = point.payload.originApp || point.payload.appId || 'default';
        const targetCollection = this.getTargetCollection(originApp);
        await this.initialize(originApp);

        const now = new Date().toISOString();
        let storedId: string | null = null;

        try {
            if (deduplicate) {
                const existing = await this.withTimeout(
                    this.client.query(targetCollection, {
                        query: point.denseVector,
                        using: 'dense',
                        limit: 1,
                        score_threshold: 0.92,
                        filter: {
                            must: [{ key: 'appId', match: { value: originApp } }]
                        },
                        with_payload: true
                    })
                );

                if (existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92) {
                    const matched = existing.points[0];
                    const existingPayload = (matched.payload || {}) as Record<string, any>;
                    const newWf = point.payload.workflowId;

                    if (!newWf || !existingPayload.workflowId || existingPayload.workflowId === newWf) {
                        const newFreq = ((existingPayload.frequency as number) || 1) + 1;
                        const mergedRating = point.payload.qualityRating !== undefined
                            ? Math.max(point.payload.qualityRating, (existingPayload.qualityRating as number) || 0)
                            : existingPayload.qualityRating;

                        await this.withTimeout(
                            this.client.setPayload(targetCollection, {
                                wait: false,
                                points: [matched.id],
                                payload: {
                                    frequency: newFreq,
                                    lastSeen: now,
                                    qualityRating: mergedRating,
                                    verified: point.payload.verified ?? existingPayload.verified,
                                    originApp,
                                    appId: originApp,
                                    domain: point.payload.domain,
                                    memoryType: point.payload.memoryType,
                                    entityIds: point.payload.entityIds
                                }
                            })
                        );

                        storedId = String(matched.id);
                    }
                }
            }

            if (!storedId) {
                const id = point.id || crypto.randomUUID();
                await this.withTimeout(
                    this.client.upsert(targetCollection, {
                        wait: false,
                        points: [
                            {
                                id,
                                vector: {
                                    dense: point.denseVector,
                                    sparse: point.sparseVector
                                },
                                payload: point.payload
                            }
                        ]
                    })
                );
                storedId = id;
            }

            return storedId;
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] Store error: ${err.message || err}`);
            return null;
        }
    }

    async storeBatch(points: StoredMemoryPoint[]): Promise<string[]> {
        if (!this.client || !this.available || points.length === 0) return [];
        const originApp = points[0].payload.originApp || points[0].payload.appId || 'default';
        const targetCollection = this.getTargetCollection(originApp);
        await this.initialize(originApp);

        try {
            const qdrantPoints = points.map(pt => ({
                id: pt.id || crypto.randomUUID(),
                vector: {
                    dense: pt.denseVector,
                    sparse: pt.sparseVector
                },
                payload: pt.payload
            }));

            await this.withTimeout(
                this.client.upsert(targetCollection, {
                    wait: false,
                    points: qdrantPoints
                })
            );

            return qdrantPoints.map(p => p.id);
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] StoreBatch error: ${err.message || err}`);
            return [];
        }
    }

    async get(id: string): Promise<StoredMemoryPoint | null> {
        if (!this.client || !this.available) return null;
        try {
            const res = await this.withTimeout(
                this.client.retrieve(this.collectionName, {
                    ids: [id],
                    with_payload: true,
                    with_vector: true
                })
            );
            if (res.length === 0) return null;
            const pt = res[0];
            const vectorObj = pt.vector as any;
            return {
                id: String(pt.id),
                denseVector: Array.isArray(vectorObj) ? vectorObj : vectorObj?.dense || [],
                sparseVector: vectorObj?.sparse || { indices: [], values: [] },
                payload: (pt.payload || {}) as StoredMemoryPoint['payload']
            };
        } catch {
            return null;
        }
    }

    async setPayload(id: string, payload: Partial<Record<string, any>>): Promise<boolean> {
        if (!this.client || !this.available) return false;
        try {
            await this.withTimeout(
                this.client.setPayload(this.collectionName, {
                    wait: true,
                    points: [id],
                    payload
                })
            );
            return true;
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] SetPayload error: ${err.message || err}`);
            return false;
        }
    }

    async search(
        queryDense: number[],
        options: StorageQueryOptions,
        querySparse?: SparseVector
    ): Promise<StorageQueryResult[]> {
        if (!this.client || !this.available) return [];
        const readerApp = options.appId || options.originApp;
        const targetCollection = this.getTargetCollection(readerApp);
        await this.initialize(readerApp);

        try {
            const filterMust: any[] = [];
            if (options.includeShared === false && readerApp) {
                filterMust.push({
                    should: [
                        { key: 'originApp', match: { value: readerApp } },
                        { key: 'appId', match: { value: readerApp } }
                    ]
                });
            }
            if (options.targetApps) {
                const targets = Array.isArray(options.targetApps) ? options.targetApps : [options.targetApps];
                if (targets.length === 1) {
                    filterMust.push({ key: 'targetApps', match: { value: targets[0] } });
                } else {
                    filterMust.push({
                        should: targets.map(t => ({ key: 'targetApps', match: { value: t } }))
                    });
                }
            }
            if (options.domain) {
                filterMust.push({ key: 'domain', match: { value: normalizeDomain(options.domain) } });
            }
            if (options.agentRole) {
                filterMust.push({ key: 'agentRole', match: { value: options.agentRole } });
            }
            if (options.minRating !== undefined) {
                filterMust.push({ key: 'qualityRating', range: { gte: options.minRating } });
            }
            if (options.verifiedOnly) {
                filterMust.push({ key: 'verified', match: { value: true } });
            }

            const filter = filterMust.length > 0 ? { must: filterMust } : undefined;
            const searchLimit = Math.max(options.limit || 3, 5) * 4;

            let qdrantRes: any;
            if (querySparse && querySparse.indices.length > 0) {
                qdrantRes = await this.withTimeout(
                    this.client.query(targetCollection, {
                        prefetch: [
                            {
                                query: queryDense,
                                using: 'dense',
                                limit: searchLimit,
                                filter,
                                params: { hnsw_ef: 64 }
                            },
                            {
                                query: querySparse,
                                using: 'sparse',
                                limit: searchLimit,
                                filter
                            }
                        ],
                        query: {
                            rrf: { k: 60 }
                        },
                        limit: searchLimit,
                        with_payload: true
                    })
                );
            } else {
                qdrantRes = await this.withTimeout(
                    this.client.query(targetCollection, {
                        query: queryDense,
                        using: 'dense',
                        limit: searchLimit,
                        filter,
                        with_payload: true
                    })
                );
            }

            return (qdrantRes.points || []).map((r: any) => ({
                id: String(r.id),
                payload: (r.payload || {}) as Record<string, any>,
                vectorScore: r.score ?? 1.0
            }));
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] Search error: ${err.message || err}`);
            return [];
        }
    }

    async delete(ids: string[]): Promise<boolean> {
        if (!this.client || !this.available || ids.length === 0) return false;
        try {
            await this.withTimeout(
                this.client.delete(this.collectionName, {
                    wait: true,
                    points: ids
                })
            );
            return true;
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] Delete error: ${err.message || err}`);
            return false;
        }
    }

    async wipe(appId?: string): Promise<boolean> {
        if (!this.client || !this.available) return false;
        const targetCollection = this.getTargetCollection(appId);
        try {
            if (!appId) {
                await this.withTimeout(this.client.deleteCollection(targetCollection));
                this.initializedCollections.delete(targetCollection);
                return true;
            }

            await this.withTimeout(
                this.client.delete(targetCollection, {
                    wait: true,
                    filter: {
                        must: [{ key: 'appId', match: { value: appId } }]
                    }
                })
            );
            return true;
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] Wipe error: ${err.message || err}`);
            return false;
        }
    }

    async scroll(filter?: StorageFilterOptions): Promise<StoredMemoryPoint[]> {
        if (!this.client || !this.available) return [];
        try {
            const filterMust: any[] = [];
            if (filter?.appId) {
                filterMust.push({ key: 'appId', match: { value: filter.appId } });
            }
            if (filter?.domain) {
                filterMust.push({ key: 'domain', match: { value: normalizeDomain(filter.domain) } });
            }
            if (filter?.agentRole) {
                filterMust.push({ key: 'agentRole', match: { value: filter.agentRole } });
            }

            const qFilter = filterMust.length > 0 ? { must: filterMust } : undefined;
            const res = await this.withTimeout(
                this.client.scroll(this.collectionName, {
                    filter: qFilter,
                    limit: 1000,
                    with_payload: true,
                    with_vector: true
                })
            );

            return (res.points || []).map((pt: any) => {
                const vectorObj = pt.vector as any;
                return {
                    id: String(pt.id),
                    denseVector: Array.isArray(vectorObj) ? vectorObj : vectorObj?.dense || [],
                    sparseVector: vectorObj?.sparse || { indices: [], values: [] },
                    payload: (pt.payload || {}) as StoredMemoryPoint['payload']
                };
            });
        } catch (err: any) {
            console.warn(`[QdrantStorageAdapter] Scroll error: ${err.message || err}`);
            return [];
        }
    }
}
