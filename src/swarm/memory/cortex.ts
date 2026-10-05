import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import { createVectorIndex, type VectorIndex, type VectorIndexMetrics } from '../vectorIndex.ts';
import { SemanticCacheInterceptor, type SemanticCacheInterceptorConfig, type SemanticCacheStats } from '../semanticCacheInterceptor.ts';
import { ActionPlanCacheInterceptor, type ActionPlanCacheConfig, type ActionPlanCacheStats, type ActionPlan, type ActionPlanInput, type ActionPlanCacheLookupResult } from '../actionPlanCache.ts';
import { SparseTokenizer } from './tokenizer.ts';
import { GeminiEmbeddingProvider, DeterministicLocalEmbeddingProvider } from './embeddings.ts';
import { cosineSimilarity, sparseDotProduct } from './vectorMath.ts';
import { collectCortexDiagnostics } from './diagnostics.ts';
import { executeMemoryConsolidation } from './consolidation.ts';
import {
    exportMemoriesSnapshot,
    saveMemoriesToFile,
    loadMemoriesFromFile,
    importMemoriesSnapshot,
    type SnapshotContext
} from './snapshotPipeline.ts';
import {
    RRF_PRESETS,
    type MemoryMetadata,
    type RrfProfile,
    type RrfWeights,
    type RetrievalOptions,
    type ConsolidationOptions,
    type ConsolidationResult,
    type ExportMemoriesOptions,
    type MemorySnapshotPoint,
    type MemorySnapshot,
    type ImportMemoriesOptions,
    type ImportMemoriesResult,
    type StoredMemoryPoint,
    type SparseVector,
    type EmbeddingProvider,
    type MemoryCortexDiagnostics,
    type MemoryCortexConfig,
    normalizeDomain,
    normalizeMemoryType,
    extractEntityIds,
    normalizeMemoryPayload,
    computeBlendWeight,
    rankAndFilterCandidates
} from './types.ts';

export class MemoryCortex {
    private static globalFallbackStores = new Map<string, StoredMemoryPoint[]>();
    private static globalVectorIndexes = new Map<string, VectorIndex<StoredMemoryPoint>>();
    private qdrant: QdrantClient | null = null;
    private embeddingProvider: EmbeddingProvider;
    private collectionName: string;
    private collectionNameTemplate?: string;
    private initializedCollections: Set<string> = new Set();
    private defaultAppId: string;
    private initialized: boolean = false;
    private isAvailable: boolean = false;
    private fallbackStore: StoredMemoryPoint[];
    private vectorIndex: VectorIndex<StoredMemoryPoint>;
    private storesSinceConsolidation: number = 0;
    private autoConsolidateThreshold: number = 50;
    private autoConsolidationOptions?: ConsolidationOptions;
    private persistPath?: string;
    private autoSave: boolean = true;
    private isAutoLoading: boolean = false;
    private semanticCache: SemanticCacheInterceptor;
    private actionPlanCache: ActionPlanCacheInterceptor;

    static clearFallbackStore(collectionName: string = "pwa_swarm_dev_cortex_v2"): void {
        const store = MemoryCortex.globalFallbackStores.get(collectionName);
        if (store) store.length = 0;
        const index = MemoryCortex.globalVectorIndexes.get(collectionName);
        if (index) index.clear();
    }

    /**
     * Synchronizes the in-memory vector index with current fallbackStore items.
     */
    private syncVectorIndex(): void {
        this.vectorIndex.clear();
        for (const pt of this.fallbackStore) {
            this.vectorIndex.insert(pt.id, pt.denseVector, pt);
        }
    }

    /**
     * Returns real-time metrics of the in-memory sub-linear vector index.
     */
    getIndexMetrics(): VectorIndexMetrics {
        return this.vectorIndex.getMetrics();
    }

    // Safe embedding wrapper that permanently downgrades to local embeddings if the API fails
    private async safeEmbed(text: string): Promise<number[]> {
        try {
            return await this.embeddingProvider.embed(text);
        } catch (err: any) {
            console.warn(`[MemoryCortex] Primary embedding provider failed (${err.message || String(err)}). Permanently downgrading to DeterministicLocalEmbeddingProvider.`);
            this.embeddingProvider = new DeterministicLocalEmbeddingProvider();
            return await this.embeddingProvider.embed(text);
        }
    }

    private async withTimeout<T>(promise: Promise<T>, ms: number = 3000): Promise<T> {
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

    constructor(config: MemoryCortexConfig) {
        const safeEnv = typeof process !== 'undefined' ? process.env : {} as Record<string, string | undefined>;
        const url = config.url || safeEnv.QDRANT_URL;
        const apiKey = config.apiKey || safeEnv.QDRANT_API_KEY;
        this.collectionNameTemplate = config.collectionNameTemplate;
        this.collectionName = config.collectionName || "pwa_swarm_dev_cortex_v2";
        this.defaultAppId = config.defaultAppId || "default";
        this.autoConsolidateThreshold = config.autoConsolidateThreshold !== undefined ? config.autoConsolidateThreshold : 50;
        this.autoConsolidationOptions = config.autoConsolidationOptions;
        this.persistPath = config.persistPath;
        this.autoSave = config.autoSave !== false;

        if (config.isolatedStore) {
            this.fallbackStore = [];
            this.vectorIndex = createVectorIndex<StoredMemoryPoint>('vptree', { metric: 'cosine' });
        } else {
            if (!MemoryCortex.globalFallbackStores.has(this.collectionName)) {
                MemoryCortex.globalFallbackStores.set(this.collectionName, []);
            }
            this.fallbackStore = MemoryCortex.globalFallbackStores.get(this.collectionName)!;

            if (!MemoryCortex.globalVectorIndexes.has(this.collectionName)) {
                const idx = createVectorIndex<StoredMemoryPoint>('vptree', { metric: 'cosine' });
                for (const pt of this.fallbackStore) {
                    idx.insert(pt.id, pt.denseVector, pt);
                }
                MemoryCortex.globalVectorIndexes.set(this.collectionName, idx);
            }
            this.vectorIndex = MemoryCortex.globalVectorIndexes.get(this.collectionName)!;
            if (this.fallbackStore.length > 0 && this.vectorIndex.size !== this.fallbackStore.length) {
                this.syncVectorIndex();
            }
        }

        if (url) {
            try {
                new URL(url);
                this.qdrant = new QdrantClient({ url, apiKey, checkCompatibility: false });
                this.isAvailable = true;
            } catch (err) {
                console.warn(`[MemoryCortex] Invalid Qdrant URL '${url}', vector memory will run in disabled mode.`);
                this.isAvailable = false;
            }
        }

        if (config.embeddingProvider) {
            this.embeddingProvider = config.embeddingProvider;
        } else if (config.aiClient) {
            this.embeddingProvider = new GeminiEmbeddingProvider(config.aiClient, config.embeddingModel || 'text-embedding-005');
        } else {
            this.embeddingProvider = new DeterministicLocalEmbeddingProvider();
        }

        this.semanticCache = new SemanticCacheInterceptor({
            similarityThreshold: config.semanticCacheConfig?.similarityThreshold ?? 0.96,
            maxEntries: config.semanticCacheConfig?.maxEntries ?? 500,
            defaultTtlMs: config.semanticCacheConfig?.defaultTtlMs
        });

        this.actionPlanCache = config.actionPlanCache || new ActionPlanCacheInterceptor({
            similarityThreshold: config.actionPlanCacheConfig?.similarityThreshold ?? 0.96,
            maxEntries: config.actionPlanCacheConfig?.maxEntries ?? 500,
            defaultTtlMs: config.actionPlanCacheConfig?.defaultTtlMs
        });
    }

    private getCollectionName(appId?: string): string {
        if (this.collectionNameTemplate && appId) {
            return this.collectionNameTemplate.replace('{appId}', appId);
        }
        return this.collectionName;
    }

    private async ensurePayloadIndex(collectionName: string, fieldName: string, fieldSchema: 'keyword' | 'float' | 'integer' | 'bool'): Promise<void> {
        if (!this.qdrant) return;
        try {
            await this.qdrant.createPayloadIndex(collectionName, {
                field_name: fieldName,
                field_schema: fieldSchema
            });
        } catch {
            // Idempotent: ignore if index already exists
        }
    }

    /**
     * Initializes the collection in Qdrant with compliant dense/sparse schemas and compound indexes.
     */
    async initialize(appId?: string): Promise<boolean> {
        const targetCollection = this.getCollectionName(appId);

        if (this.initialized && this.initializedCollections.has(targetCollection)) return true;

        if (!this.qdrant || !this.isAvailable) {
            this.initialized = true;
            this.initializedCollections.add(targetCollection);
            if (!this.isAutoLoading) {
                 await this.loadPersistFileIfConfigured();
            }
            return true;
        }

        try {
            const collections = await this.withTimeout(this.qdrant.getCollections(), 5000);
            const exists = collections.collections.some(c => c.name === targetCollection);

            if (!exists) {
                await this.withTimeout(this.qdrant.createCollection(targetCollection, {
                    vectors: {
                        dense: {
                            size: this.embeddingProvider.dimension,
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
                }), 10000);
            }

            // Create compound payload indexes for multi-tenant and learning queries
            await Promise.all([
                this.ensurePayloadIndex(targetCollection, "originApp", "keyword"),
                this.ensurePayloadIndex(targetCollection, "domain", "keyword"),
                this.ensurePayloadIndex(targetCollection, "memoryType", "keyword"),
                this.ensurePayloadIndex(targetCollection, "entityIds", "keyword"),
                this.ensurePayloadIndex(targetCollection, "workflowId", "keyword"),
                this.ensurePayloadIndex(targetCollection, "appId", "keyword"),
                this.ensurePayloadIndex(targetCollection, "targetApps", "keyword"),
                this.ensurePayloadIndex(targetCollection, "agentRole", "keyword"),
                this.ensurePayloadIndex(targetCollection, "qualityRating", "float"),
                this.ensurePayloadIndex(targetCollection, "verified", "bool")
            ]);

            this.initialized = true;
            this.initializedCollections.add(targetCollection);
            if (!this.isAutoLoading) {
                 await this.loadPersistFileIfConfigured();
            }
            return true;
        } catch (error: any) {
            console.warn(`[MemoryCortex] Initialization failed for ${targetCollection}: ${error.message || error}. Falling back to ephemeral in-memory vector store.`);
            this.isAvailable = false;
            this.initialized = true;
            this.initializedCollections.add(targetCollection);
            if (!this.isAutoLoading) {
                 await this.loadPersistFileIfConfigured();
            }
            return true;
        }
    }

    private getSnapshotContext(): SnapshotContext {
        return {
            fallbackStore: this.fallbackStore,
            vectorIndex: this.vectorIndex,
            qdrant: this.qdrant,
            isAvailable: this.isAvailable,
            collectionName: this.collectionName,
            defaultAppId: this.defaultAppId,
            persistPath: this.persistPath,
            isAutoLoading: this.isAutoLoading,
            safeEmbed: (text) => this.safeEmbed(text),
            withTimeout: (promise, ms) => this.withTimeout(promise, ms),
            savePersistFileIfConfigured: () => this.savePersistFileIfConfigured()
        };
    }

    private async loadPersistFileIfConfigured(): Promise<void> {
        if (!this.persistPath) return;
        try {
            const fs = await import('no' + 'de:fs');
            if (fs.existsSync(this.persistPath)) {
                const raw = fs.readFileSync(this.persistPath, 'utf-8');
                if (raw.trim().length > 0) {
                    this.isAutoLoading = true;
                    try {
                        await this.importMemories(raw, { deduplicate: true, recomputeVectors: false });
                    } finally {
                        this.isAutoLoading = false;
                    }
                }
            }
        } catch (err: any) {
            console.warn(`[MemoryCortex] Auto-load from '${this.persistPath}' failed: ${err.message || err}`);
        }
    }

    private async savePersistFileIfConfigured(): Promise<void> {
        if (!this.persistPath || !this.autoSave || this.isAutoLoading) return;
        try {
            await this.saveToFile(this.persistPath);
        } catch (err: any) {
            console.warn(`[MemoryCortex] Auto-save to '${this.persistPath}' failed: ${err.message || err}`);
        }
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        return cosineSimilarity(a, b);
    }

    private sparseDotProduct(query: SparseVector, target: SparseVector): number {
        return sparseDotProduct(query, target);
    }

    /**
     * Stores an analysis memory point with automatic semantic deduplication.
     * If a memory with >= 0.92 cosine similarity exists in the same appId, updates frequency and merges feedback.
     */
    async store(content: string, metadata: MemoryMetadata, deduplicate: boolean = true): Promise<string | null> {
        await this.initialize();
        const originApp = metadata.originApp || metadata.appId || this.defaultAppId;
        const appId = originApp;
        const domain = metadata.domain ? normalizeDomain(metadata.domain, content) : 'general';
        const memoryType = normalizeMemoryType(metadata.memoryType, metadata);
        const entityIds = extractEntityIds(content, metadata.entityIds);
        const now = new Date().toISOString();
        let storedId: string | null = null;

        const pointPayload = {
            content,
            frequency: 1,
            qualityRating: metadata.qualityRating ?? 0.5,
            verified: memoryType === 'fact',
            timestamp: now,
            lastSeen: now,
            ...metadata,
            originApp,
            appId,
            domain,
            memoryType,
            entityIds
        };

        if (this.qdrant && this.isAvailable) {
            try {
                const denseVector = await this.safeEmbed(content);
                const sparseVector = SparseTokenizer.encode(content);

                if (deduplicate) {
                    const existing = await this.withTimeout(this.qdrant.query(this.collectionName, {
                        query: denseVector,
                        using: "dense",
                        limit: 1,
                        score_threshold: 0.92,
                        filter: {
                            must: [{ key: "appId", match: { value: originApp } }]
                        },
                        with_payload: true
                    }));

                    if (existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92) {
                        const matched = existing.points[0];
                        const existingPayload = (matched.payload || {}) as Record<string, any>;
                        const newFreq = ((existingPayload.frequency as number) || 1) + 1;
                        const mergedRating = metadata.qualityRating !== undefined
                            ? Math.max(metadata.qualityRating, (existingPayload.qualityRating as number) || 0)
                            : existingPayload.qualityRating;

                        await this.withTimeout(this.qdrant.setPayload(this.collectionName, {
                            wait: false,
                            points: [matched.id],
                            payload: {
                                frequency: newFreq,
                                lastSeen: now,
                                qualityRating: mergedRating,
                                verified: metadata.verified ?? existingPayload.verified,
                                originApp,
                                appId,
                                domain,
                                memoryType,
                                entityIds
                            }
                        }));

                        storedId = String(matched.id);
                    }
                }

                if (!storedId) {
                    const id = crypto.randomUUID();
                    await this.withTimeout(this.qdrant.upsert(this.collectionName, {
                        wait: false,
                        points: [
                            {
                                id,
                                vector: {
                                    dense: denseVector,
                                    sparse: sparseVector
                                },
                                payload: pointPayload
                            }
                        ]
                    }));

                    storedId = id;
                }
            } catch (err: any) {
                console.warn(`[MemoryCortex] Qdrant store error: ${err.message || err}. Falling back to in-memory store.`);
            }
        }

        if (!storedId) {
            // Ephemeral in-memory fallback
            try {
                const denseVector = await this.safeEmbed(content);
                const sparseVector = SparseTokenizer.encode(content);

                if (deduplicate) {
                    const match = this.vectorIndex.findMostSimilar(
                        denseVector,
                        0.92,
                        (item) => (item.data.payload.originApp || item.data.payload.appId) === originApp
                    );

                    if (match) {
                        const existing = match.data;
                        existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                        existing.payload.lastSeen = now;
                        if (metadata.qualityRating !== undefined) {
                            existing.payload.qualityRating = Math.max(metadata.qualityRating, existing.payload.qualityRating || 0);
                        }
                        if (metadata.verified !== undefined) {
                            existing.payload.verified = metadata.verified;
                        }
                        existing.payload.originApp = originApp;
                        existing.payload.appId = appId;
                        existing.payload.domain = domain;
                        existing.payload.memoryType = memoryType;
                        existing.payload.entityIds = entityIds;
                        storedId = existing.id;
                    }
                }

                if (!storedId) {
                    const id = crypto.randomUUID();
                    const newPoint: StoredMemoryPoint = {
                        id,
                        denseVector,
                        sparseVector,
                        payload: pointPayload
                    };
                    this.fallbackStore.push(newPoint);
                    this.vectorIndex.insert(id, denseVector, newPoint);
                    storedId = id;
                }
            } catch (err: any) {
                console.warn(`[MemoryCortex] In-memory store error: ${err.message || err}`);
            }
        }

        if (storedId) {
            this.storesSinceConsolidation++;
            if (this.autoConsolidateThreshold > 0 && this.storesSinceConsolidation >= this.autoConsolidateThreshold) {
                this.storesSinceConsolidation = 0;
                await this.consolidateMemories(this.autoConsolidationOptions);
            }
            await this.savePersistFileIfConfigured();
        }

        return storedId;
    }

    /**
     * Stores a batch of analysis experiences into Qdrant, falling back to in-memory store if offline.
     */
    async storeBatch(memories: { content: string; metadata: MemoryMetadata }[]): Promise<string[]> {
        await this.initialize();
        if (memories.length === 0) return [];
        const now = new Date().toISOString();

        if (this.qdrant && this.isAvailable) {
            try {
                const points = await Promise.all(
                    memories.map(async (memory) => {
                        const denseVector = await this.safeEmbed(memory.content);
                        const sparseVector = SparseTokenizer.encode(memory.content);
                        const id = crypto.randomUUID();
                        const originApp = memory.metadata.originApp || memory.metadata.appId || this.defaultAppId;
                        const appId = originApp;
                        const domain = memory.metadata.domain ? normalizeDomain(memory.metadata.domain, memory.content) : 'general';
                        const memoryType = normalizeMemoryType(memory.metadata.memoryType, memory.metadata);
                        const entityIds = extractEntityIds(memory.content, memory.metadata.entityIds);

                        return {
                            id,
                            vector: {
                                dense: denseVector,
                                sparse: sparseVector
                            },
                            payload: {
                                content: memory.content,
                                frequency: 1,
                                qualityRating: memory.metadata.qualityRating ?? 0.5,
                                verified: memoryType === 'fact',
                                timestamp: now,
                                lastSeen: now,
                                ...memory.metadata,
                                originApp,
                                appId,
                                domain,
                                memoryType,
                                entityIds
                            }
                        };
                    })
                );

                await this.withTimeout(this.qdrant.upsert(this.collectionName, {
                    wait: false,
                    points
                }));

                this.storesSinceConsolidation += points.length;
                if (this.autoConsolidateThreshold > 0 && this.storesSinceConsolidation >= this.autoConsolidateThreshold) {
                    this.storesSinceConsolidation = 0;
                    await this.consolidateMemories(this.autoConsolidationOptions);
                }

                await this.savePersistFileIfConfigured();
                return points.map(p => p.id as string);
            } catch (err: any) {
                console.warn(`[MemoryCortex] StoreBatch Qdrant error: ${err.message || err}. Falling back to in-memory store.`);
            }
        }

        // Ephemeral in-memory fallback
        try {
            const results = await Promise.all(
                memories.map(mem => this.store(mem.content, mem.metadata, false))
            );
            return results.filter((id): id is string => id !== null);
        } catch (err: any) {
            console.warn(`[MemoryCortex] StoreBatch error: ${err.message || err}`);
            return [];
        }
    }

    /**
     * Rates a stored analysis memory to enable continuous reinforcement learning.
     */
    async rateMemory(id: string, rating: number, feedback?: string): Promise<boolean> {
        await this.initialize();
        const normalizedRating = Math.max(0, Math.min(1, rating));

        if (this.qdrant && this.isAvailable) {
            try {
                await this.withTimeout(this.qdrant.setPayload(this.collectionName, {
                    wait: true,
                    points: [id],
                    payload: {
                        qualityRating: normalizedRating,
                        verified: normalizedRating >= 0.8,
                        feedback: feedback || undefined,
                        ratedAt: new Date().toISOString()
                    }
                }));
                await this.savePersistFileIfConfigured();
                return true;
            } catch (err: any) {
                console.warn(`[MemoryCortex] RateMemory Qdrant error: ${err.message || err}`);
            }
        }

        // Ephemeral in-memory fallback
        const point = this.fallbackStore.find(p => p.id === id);
        if (point) {
            point.payload.qualityRating = normalizedRating;
            point.payload.verified = normalizedRating >= 0.8;
            point.payload.feedback = feedback || undefined;
            point.payload.ratedAt = new Date().toISOString();
            await this.savePersistFileIfConfigured();
            return true;
        }

        return false;
    }

    async retrieve(
        query: string,
        optionsOrDomain?: string | RetrievalOptions,
        limit: number = 3
    ): Promise<any[]> {
        await this.initialize();
        let options: RetrievalOptions = {};
        if (typeof optionsOrDomain === 'string') {
            options = { domain: optionsOrDomain, limit };
        } else if (typeof optionsOrDomain === 'object' && optionsOrDomain !== null) {
            options = { ...optionsOrDomain, limit: optionsOrDomain.limit || limit };
        } else {
            options = { limit };
        }

        const queryDense = await this.safeEmbed(query);

        // Check Action Plan Cache Interceptor first (> 0.96 threshold)
        const planMatch = this.actionPlanCache.lookup(queryDense, options.appId);
        if (planMatch.hit && planMatch.actionPlan) {
            return [{
                id: planMatch.actionPlan.id,
                content: `ActionPlan:${planMatch.actionPlan.intent}`,
                actionPlan: planMatch.actionPlan,
                isActionPlanHit: true,
                latencySavedMs: 43
            }];
        }

        // Check Semantic Cache Interceptor first (> 0.96 threshold)
        const readerApp = options.appId || options.originApp || this.defaultAppId;
        const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
        const cacheNamespace = requestedDomain ? `${readerApp}:${requestedDomain}` : readerApp;
        const cachedMatch = this.semanticCache.lookup<any[]>(queryDense, cacheNamespace);
        if (cachedMatch.hit && cachedMatch.payload) {
            return cachedMatch.payload;
        }

        let results: any[] = [];

        if (this.qdrant && this.isAvailable) {
            try {
                const sparseVector = SparseTokenizer.encode(query);

                const filterMust: any[] = [];
                if (options.includeShared === false) {
                    filterMust.push({
                        should: [
                            { key: "originApp", match: { value: readerApp } },
                            { key: "appId", match: { value: readerApp } }
                        ]
                    });
                }
                if (options.targetApps) {
                    const targets = Array.isArray(options.targetApps) ? options.targetApps : [options.targetApps];
                    if (targets.length === 1) {
                        filterMust.push({ key: "targetApps", match: { value: targets[0] } });
                    } else {
                        filterMust.push({
                            should: targets.map(t => ({ key: "targetApps", match: { value: t } }))
                        });
                    }
                }
                if (requestedDomain) {
                    filterMust.push({ key: "domain", match: { value: requestedDomain } });
                }
                if (options.agentRole) {
                    filterMust.push({ key: "agentRole", match: { value: options.agentRole } });
                }
                if (options.minRating !== undefined) {
                    filterMust.push({ key: "qualityRating", range: { gte: options.minRating } });
                }
                if (options.verifiedOnly) {
                    filterMust.push({ key: "verified", match: { value: true } });
                }

                const filter = filterMust.length > 0 ? { must: filterMust } : undefined;
                const searchLimit = Math.max(options.limit || 3, 5) * 4;

                const qdrantRes = await this.withTimeout(this.qdrant.query(this.collectionName, {
                    prefetch: [
                        {
                            query: queryDense,
                            using: "dense",
                            limit: searchLimit,
                            filter,
                            params: { hnsw_ef: 64 }
                        },
                        {
                            query: sparseVector,
                            using: "sparse",
                            limit: searchLimit,
                            filter
                        }
                    ],
                    query: {
                        rrf: { k: 60 }
                    },
                    limit: searchLimit,
                    with_payload: true
                }));

                const qdrantCandidates = (qdrantRes.points || []).map(r => ({
                    id: String(r.id),
                    payload: r.payload,
                    vectorScore: r.score ?? 1.0
                }));

                results = rankAndFilterCandidates(qdrantCandidates, options, query, this.defaultAppId);
            } catch (err: any) {
                console.warn(`[MemoryCortex] Hybrid retrieval error: ${err.message || err}. Falling back to in-memory search.`);
                results = await this.retrieveFromFallbackWithVector(queryDense, options, query);
            }
        } else {
            results = await this.retrieveFromFallbackWithVector(queryDense, options, query);
        }

        // Store result in semantic cache for future queries (> 0.96 similarity)
        if (results.length > 0) {
            this.semanticCache.set(queryDense, results, cacheNamespace);
        }

        return results;
    }

    private async retrieveFromFallbackWithVector(queryDense: number[], options: RetrievalOptions, query: string): Promise<any[]> {
        if (this.fallbackStore.length === 0) return [];
        const readerApp = options.appId || options.originApp || this.defaultAppId;
        const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;

        const filterPredicate = (pt: StoredMemoryPoint) => {
            if (options.includeShared === false) {
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
            candidates = this.fallbackStore.filter(filterPredicate);
        }

        if (candidates.length === 0) return [];

        const scoredCandidates = candidates.map(pt => ({
            id: pt.id,
            payload: pt.payload,
            vectorScore: this.cosineSimilarity(queryDense, pt.denseVector)
        }));

        return rankAndFilterCandidates(scoredCandidates, options, query, this.defaultAppId);
    }

    /**
     * Extracts top-rated historical executions and formats them into few-shot exemplars for prompt distillation.
     */
    async retrieveExemplars(task: string, options?: RetrievalOptions): Promise<string> {
        const topMemories = await this.retrieve(task, {
            ...options,
            minRating: options?.minRating ?? 0.7,
            limit: options?.limit || 2
        });

        if (!topMemories || topMemories.length === 0) return "";

        return topMemories.map((m: any, idx: number) => {
            const score = m.qualityRating !== undefined ? ` (Quality Rating: ${(m.qualityRating * 100).toFixed(0)}%)` : '';
            const feedbackText = m.feedback ? `\nFeedback: ${m.feedback}` : '';
            return `[Learning Exemplar ${idx + 1}]${score}:\n${m.content || JSON.stringify(m)}${feedbackText}`;
        }).join('\n\n');
    }

    /**
     * Consolidates and prunes memories based on minimum quality rating, expiration age, and optional appId filter.
     */
    async consolidateMemories(options?: ConsolidationOptions): Promise<ConsolidationResult> {
        await this.initialize();
        return executeMemoryConsolidation({
            fallbackStore: this.fallbackStore,
            vectorIndex: this.vectorIndex,
            qdrant: this.qdrant,
            isAvailable: this.isAvailable,
            collectionName: this.collectionName,
            savePersistFileIfConfigured: () => this.savePersistFileIfConfigured()
        }, options);
    }

    /**
     * Exports a portable snapshot of stored memories filtered by options.
     */
    async exportMemories(options?: ExportMemoriesOptions): Promise<MemorySnapshot> {
        await this.initialize();
        return exportMemoriesSnapshot(this.getSnapshotContext(), options);
    }

    /**
     * Exports memories as formatted JSON string.
     */
    async exportJson(options?: ExportMemoriesOptions): Promise<string> {
        const snapshot = await this.exportMemories(options);
        return JSON.stringify(snapshot, null, 2);
    }

    /**
     * Exports memories as line-delimited JSON (JSONL) string.
     */
    async exportJsonl(options?: ExportMemoriesOptions): Promise<string> {
        const snapshot = await this.exportMemories(options);
        return snapshot.memories.map(m => JSON.stringify(m)).join('\n');
    }

    /**
     * Saves all cortex memories to a local snapshot file (JSON or JSONL based on extension).
     */
    async saveToFile(filePath?: string): Promise<string> {
        return saveMemoriesToFile(this.getSnapshotContext(), filePath);
    }

    /**
     * Loads memories from a local snapshot file (JSON or JSONL) into the cortex.
     */
    async loadFromFile(filePath?: string, options?: ImportMemoriesOptions): Promise<ImportMemoriesResult> {
        return loadMemoriesFromFile(this.getSnapshotContext(), filePath, options);
    }

    /**
     * Imports a portable snapshot or array of memories into the Cortex.
     */
    async importMemories(
        input: MemorySnapshot | string | any[],
        options?: ImportMemoriesOptions
    ): Promise<ImportMemoriesResult> {
        await this.initialize();
        return importMemoriesSnapshot(this.getSnapshotContext(), input, options);
    }

    /**
     * Wipes the collection and in-memory store.
     * If appId is provided, only memories matching that originApp are wiped.
     */
    async wipeCollection(appId?: string): Promise<boolean> {
        if (appId) {
            const targetApp = appId.trim();
            const remaining: StoredMemoryPoint[] = [];
            const deletedIds: string[] = [];

            for (const pt of this.fallbackStore) {
                const itemApp = pt.payload.originApp || pt.payload.appId;
                if (itemApp === targetApp) {
                    deletedIds.push(pt.id);
                } else {
                    remaining.push(pt);
                }
            }

            this.fallbackStore.length = 0;
            this.fallbackStore.push(...remaining);
            for (const id of deletedIds) {
                this.vectorIndex.delete(id);
            }

            if (this.qdrant && this.isAvailable && typeof (this.qdrant as any).delete === 'function') {
                try {
                    await this.withTimeout((this.qdrant as any).delete(this.collectionName, {
                        filter: {
                            should: [
                                { key: "originApp", match: { value: targetApp } },
                                { key: "appId", match: { value: targetApp } }
                            ]
                        }
                    }));
                } catch (err: any) {
                    console.warn(`[MemoryCortex] Qdrant wipe for ${targetApp} failed:`, err);
                }
            }

            await this.savePersistFileIfConfigured();
            return true;
        }

        this.fallbackStore.length = 0;
        this.vectorIndex.clear();
        this.storesSinceConsolidation = 0;
        if (this.persistPath) {
            try {
                const fs = await import('no' + 'de:fs');
                if (fs.existsSync(this.persistPath)) {
                    fs.unlinkSync(this.persistPath);
                }
            } catch {}
        }
        if (!this.qdrant) {
            this.initialized = false;
            return true;
        }
        try {
            await this.qdrant.deleteCollection(this.collectionName);
            this.initialized = false;
            return true;
        } catch (error: any) {
            console.warn(`[MemoryCortex] WipeCollection failed: ${error.message || error}`);
            return false;
        }
    }

    async wipeApp(appId: string): Promise<boolean> {
        return this.wipeCollection(appId);
    }

    /**
     * Updates the stored judgment that produced a workflow with the graded outcome.
     * Maps win -> 1.0, push -> 0.5, loss -> 0.0.
     * Sets memoryType to 'fact', verified to (score >= 0.8), stores outcome, gradedAt, feedbackProcessed: true.
     * Second grade for the same workflowId is idempotent (no-op).
     */
    async gradeMemoryByWorkflowId(options: {
        workflowId: string;
        originApp: string;
        outcome: 'win' | 'loss' | 'push';
        gradedAt?: string | number;
    }): Promise<{ found: boolean; alreadyProcessed: boolean; point?: any; updatedScore?: number }> {
        await this.initialize();
        const targetWorkflowId = options.workflowId.trim();
        const targetOriginApp = options.originApp.trim();
        const outcomeScore = options.outcome === 'win' ? 1.0 : options.outcome === 'loss' ? 0.0 : 0.5;
        const nowIso = typeof options.gradedAt === 'string'
            ? options.gradedAt
            : (typeof options.gradedAt === 'number' ? new Date(options.gradedAt).toISOString() : new Date().toISOString());

        let matchedPoint: any = null;
        let isAlreadyProcessed = false;

        // 1. Fallback / in-memory store lookup
        for (const pt of this.fallbackStore) {
            const itemWorkflowId = pt.payload.workflowId;
            const itemOriginApp = pt.payload.originApp || pt.payload.appId;
            if (itemWorkflowId === targetWorkflowId && itemOriginApp === targetOriginApp) {
                matchedPoint = pt;
                if (pt.payload.feedbackProcessed === true) {
                    isAlreadyProcessed = true;
                } else {
                    pt.payload.qualityRating = outcomeScore;
                    pt.payload.memoryType = 'fact';
                    pt.payload.outcome = options.outcome;
                    pt.payload.gradedAt = nowIso;
                    pt.payload.feedbackProcessed = true;
                    pt.payload.verified = outcomeScore >= 0.8;
                }
                break;
            }
        }

        // 2. Qdrant store lookup & update
        if (this.qdrant && this.isAvailable) {
            try {
                const scrollRes = await this.withTimeout((this.qdrant as any).scroll(this.collectionName, {
                    limit: 1,
                    filter: {
                        must: [
                            { key: "workflowId", match: { value: targetWorkflowId } },
                            {
                                should: [
                                    { key: "originApp", match: { value: targetOriginApp } },
                                    { key: "appId", match: { value: targetOriginApp } }
                                ]
                            }
                        ]
                    },
                    with_payload: true,
                    with_vector: false
                }));

                const points = (scrollRes as any)?.points || [];
                if (points.length > 0) {
                    const qPoint = points[0];
                    const qPayload = qPoint.payload || {};
                    const pointApp = qPayload.originApp || qPayload.appId;
                    if (pointApp === targetOriginApp) {
                        matchedPoint = matchedPoint || qPoint;
                        if (qPayload.feedbackProcessed === true) {
                            isAlreadyProcessed = true;
                        } else {
                            await this.withTimeout(this.qdrant.setPayload(this.collectionName, {
                                wait: true,
                                points: [qPoint.id],
                                payload: {
                                    qualityRating: outcomeScore,
                                    memoryType: 'fact',
                                    outcome: options.outcome,
                                    gradedAt: nowIso,
                                    feedbackProcessed: true,
                                    verified: outcomeScore >= 0.8
                                }
                            }));
                        }
                    }
                }
            } catch (err: any) {
                console.warn(`[MemoryCortex] Qdrant gradeMemoryByWorkflowId error:`, err);
            }
        }

        if (!matchedPoint) {
            return { found: false, alreadyProcessed: false };
        }

        await this.savePersistFileIfConfigured();

        return {
            found: true,
            alreadyProcessed: isAlreadyProcessed,
            point: matchedPoint.payload || matchedPoint,
            updatedScore: outcomeScore
        };
    }

    async getDiagnostics(appIdFilter?: string): Promise<MemoryCortexDiagnostics> {
        return collectCortexDiagnostics({
            qdrant: this.qdrant,
            isAvailable: this.isAvailable,
            collectionName: this.collectionName,
            fallbackStore: this.fallbackStore,
            defaultAppId: this.defaultAppId,
            withTimeout: (p, ms) => this.withTimeout(p, ms)
        }, appIdFilter);
    }

    get ready(): boolean {
        return true;
    }

    get isQdrantAvailable(): boolean {
        return this.isAvailable;
    }

    get fallbackCount(): number {
        return this.fallbackStore.length;
    }

    get pendingConsolidationCount(): number {
        return this.storesSinceConsolidation;
    }

    getSemanticCacheStats(): SemanticCacheStats {
        return this.semanticCache.getStats();
    }

    getActionPlanCacheStats(): ActionPlanCacheStats {
        return this.actionPlanCache.getStats();
    }

    getActionPlanCache(): ActionPlanCacheInterceptor {
        return this.actionPlanCache;
    }

    async lookupActionPlan(query: string, appId?: string): Promise<ActionPlanCacheLookupResult & { queryDense: number[] }> {
        const queryDense = await this.safeEmbed(query);
        const res = this.actionPlanCache.lookup(queryDense, appId || this.defaultAppId);
        return {
            ...res,
            queryDense
        };
    }

    async cacheActionPlan(query: string, plan: ActionPlanInput, ttlMs?: number): Promise<ActionPlan> {
        const queryDense = await this.safeEmbed(query);
        return this.actionPlanCache.set(queryDense, plan, ttlMs);
    }
}
