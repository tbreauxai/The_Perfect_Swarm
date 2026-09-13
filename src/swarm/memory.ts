import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';

export interface MemoryMetadata {
    appId?: string;
    domain?: string;
    agentRole?: string;
    sessionId?: string;
    qualityRating?: number; // 0.0 to 1.0
    verified?: boolean;
    feedback?: string;
    frequency?: number;
    tags?: string[];
    timestamp?: string;
    lastSeen?: string;
    [key: string]: any;
}

export type RrfProfile = 'semantic' | 'lexical' | 'balanced' | 'hybrid';
export type RrfWeights = { denseWeight: number; sparseWeight: number };

export const RRF_PRESETS: Record<RrfProfile, RrfWeights> = {
    semantic: { denseWeight: 4.0, sparseWeight: 0.5 },
    lexical: { denseWeight: 0.5, sparseWeight: 4.0 },
    balanced: { denseWeight: 1.0, sparseWeight: 1.0 },
    hybrid: { denseWeight: 2.0, sparseWeight: 1.5 }
};

export interface RetrievalOptions {
    appId?: string;
    domain?: string;
    limit?: number;
    minRating?: number;
    verifiedOnly?: boolean;
    agentRole?: string;
    includeShared?: boolean;
    denseWeight?: number;
    sparseWeight?: number;
    profile?: RrfProfile | RrfWeights;
    rrfProfile?: RrfProfile | RrfWeights;
}

export interface ConsolidationOptions {
    appId?: string;
    minRating?: number;
    maxAgeDays?: number;
    pruneLowQuality?: boolean;
}

export interface ConsolidationResult {
    inspected: number;
    pruned: number;
    retained: number;
    prunedIds: string[];
}

export interface ExportMemoriesOptions {
    appId?: string;
    minRating?: number;
    verifiedOnly?: boolean;
    includeVectors?: boolean;
    format?: 'snapshot' | 'json' | 'jsonl';
}

export interface MemorySnapshotPoint {
    id: string;
    content: string;
    metadata: MemoryMetadata & {
        appId: string;
        qualityRating: number;
        verified: boolean;
        frequency: number;
        timestamp: string;
        lastSeen: string;
    };
    denseVector?: number[];
    sparseVector?: SparseVector;
}

export interface MemorySnapshot {
    version: string;
    exportedAt: string;
    collectionName: string;
    pointCount: number;
    memories: MemorySnapshotPoint[];
}

export interface ImportMemoriesOptions {
    targetAppId?: string;
    deduplicate?: boolean;
    recomputeVectors?: boolean;
    minRating?: number;
}

export interface ImportMemoriesResult {
    imported: number;
    skipped: number;
    deduplicated: number;
    importedIds: string[];
}

export interface StoredMemoryPoint {
    id: string;
    denseVector: number[];
    sparseVector: SparseVector;
    payload: MemoryMetadata & {
        content: string;
        appId: string;
        frequency: number;
        qualityRating: number;
        verified: boolean;
        timestamp: string;
        lastSeen: string;
    };
}

export interface SparseVector {
    indices: number[];
    values: number[];
}

/**
 * Tokenizes text into sparse term frequency vector for BM25-style lexical search.
 */
export class SparseTokenizer {
    static encode(text: string, vocabSize: number = 10000): SparseVector {
        const tokens = text.toLowerCase().match(/\b\w+\b/g) || [];
        const termFreqs: Record<number, number> = {};

        for (const token of tokens) {
            let hash = 5381;
            for (let i = 0; i < token.length; i++) {
                hash = ((hash << 5) + hash) + token.charCodeAt(i);
                hash |= 0;
            }
            const index = Math.abs(hash) % vocabSize;
            termFreqs[index] = (termFreqs[index] || 0) + 1;
        }

        const indices = Object.keys(termFreqs).map(Number).sort((a, b) => a - b);
        const values = indices.map(i => termFreqs[i]);

        return { indices, values };
    }
}

/**
 * Pluggable embedding provider interface.
 */
export interface EmbeddingProvider {
    readonly dimension: number;
    embed(text: string): Promise<number[]>;
}

/**
 * Google AI Gemini dense embedding provider using text-embedding-004.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;
    private aiClient: GoogleGenAI;
    private modelName: string;

    constructor(
        aiClient: GoogleGenAI,
        modelName: string = 'text-embedding-004'
    ) {
        this.aiClient = aiClient;
        this.modelName = modelName;
    }

    async embed(text: string): Promise<number[]> {
        const response = await this.aiClient.models.embedContent({
            model: this.modelName,
            contents: text,
        });
        return response.embeddings?.[0]?.values || [];
    }
}

/**
 * Deterministic local dense embedding generator (768 dimensions).
 * Enables offline execution, zero-cost operation, and local testing without external API keys.
 */
export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;

    async embed(text: string): Promise<number[]> {
        const vector = new Array(this.dimension).fill(0);
        const tokens = text.toLowerCase().match(/\b\w+\b/g) || [];
        if (tokens.length === 0) return vector;

        for (const token of tokens) {
            let hash = 5381;
            for (let i = 0; i < token.length; i++) {
                hash = ((hash << 5) + hash) + token.charCodeAt(i);
                hash |= 0;
            }
            const index = Math.abs(hash) % this.dimension;
            vector[index] += 1;
        }

        let sumSq = 0;
        for (let i = 0; i < this.dimension; i++) sumSq += vector[i] * vector[i];
        const norm = Math.sqrt(sumSq) || 1;
        for (let i = 0; i < this.dimension; i++) vector[i] /= norm;

        return vector;
    }
}

export interface MemoryCortexConfig {
    url?: string;
    apiKey?: string;
    collectionName?: string;
    defaultAppId?: string;
    embeddingProvider?: EmbeddingProvider;
    aiClient?: GoogleGenAI;
    isolatedStore?: boolean;
    autoConsolidateThreshold?: number;
    autoConsolidationOptions?: ConsolidationOptions;
}

/**
 * High-performance, hybrid continuous learning vector cortex powered by Qdrant.
 * Features:
 * - Multi-tenant application namespacing (`appId`)
 * - Continuous learning feedback loop (`rateMemory`, `reinforceMemory`)
 * - Semantic deduplication with cosine clustering threshold (>0.92)
 * - Few-shot exemplary retrieval for prompt distillation
 * - Hybrid dense + sparse vectors merged via Reciprocal Rank Fusion (RRF)
 * - Compliant Qdrant int8 scalar quantization and on-disk payload storage
 */
export class MemoryCortex {
    private static globalFallbackStores = new Map<string, StoredMemoryPoint[]>();
    private qdrant: QdrantClient | null = null;
    private embeddingProvider: EmbeddingProvider;
    private collectionName: string;
    private defaultAppId: string;
    private initialized: boolean = false;
    private isAvailable: boolean = false;
    private fallbackStore: StoredMemoryPoint[];
    private storesSinceConsolidation: number = 0;
    private autoConsolidateThreshold: number = 50;
    private autoConsolidationOptions?: ConsolidationOptions;

    static clearFallbackStore(collectionName: string = "pwa_swarm_dev_cortex_v2"): void {
        const store = MemoryCortex.globalFallbackStores.get(collectionName);
        if (store) store.length = 0;
    }

    constructor(config: MemoryCortexConfig) {
        const url = config.url || process.env.QDRANT_URL;
        const apiKey = config.apiKey || process.env.QDRANT_API_KEY;
        this.collectionName = config.collectionName || "pwa_swarm_dev_cortex_v2";
        this.defaultAppId = config.defaultAppId || "default";
        this.autoConsolidateThreshold = config.autoConsolidateThreshold !== undefined ? config.autoConsolidateThreshold : 50;
        this.autoConsolidationOptions = config.autoConsolidationOptions;

        if (config.isolatedStore) {
            this.fallbackStore = [];
        } else {
            if (!MemoryCortex.globalFallbackStores.has(this.collectionName)) {
                MemoryCortex.globalFallbackStores.set(this.collectionName, []);
            }
            this.fallbackStore = MemoryCortex.globalFallbackStores.get(this.collectionName)!;
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
            this.embeddingProvider = new GeminiEmbeddingProvider(config.aiClient);
        } else {
            this.embeddingProvider = new DeterministicLocalEmbeddingProvider();
        }
    }

    private async ensurePayloadIndex(fieldName: string, fieldSchema: 'keyword' | 'float' | 'integer' | 'bool'): Promise<void> {
        if (!this.qdrant) return;
        try {
            await this.qdrant.createPayloadIndex(this.collectionName, {
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
    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.qdrant || !this.isAvailable) {
            this.initialized = true;
            return true;
        }

        try {
            const collections = await this.qdrant.getCollections();
            const exists = collections.collections.some(c => c.name === this.collectionName);

            if (!exists) {
                await this.qdrant.createCollection(this.collectionName, {
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
                });

                console.log(`[MemoryCortex] Initialized compliant Qdrant collection: ${this.collectionName}`);
            }

            // Create compound payload indexes for multi-tenant and learning queries
            await this.ensurePayloadIndex("domain", "keyword");
            await this.ensurePayloadIndex("appId", "keyword");
            await this.ensurePayloadIndex("agentRole", "keyword");
            await this.ensurePayloadIndex("qualityRating", "float");
            await this.ensurePayloadIndex("verified", "bool");

            this.initialized = true;
            return true;
        } catch (error: any) {
            console.warn(`[MemoryCortex] Initialization failed: ${error.message || error}. Falling back to ephemeral in-memory vector store.`);
            this.isAvailable = false;
            this.initialized = true;
            return true;
        }
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (!a || !b || a.length !== b.length || a.length === 0) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private sparseDotProduct(query: SparseVector, target: SparseVector): number {
        if (!query || !target) return 0;
        const targetMap = new Map<number, number>();
        for (let i = 0; i < target.indices.length; i++) {
            targetMap.set(target.indices[i], target.values[i]);
        }
        let score = 0;
        for (let i = 0; i < query.indices.length; i++) {
            const targetVal = targetMap.get(query.indices[i]);
            if (targetVal !== undefined) {
                score += query.values[i] * targetVal;
            }
        }
        return score;
    }

    /**
     * Stores an analysis memory point with automatic semantic deduplication.
     * If a memory with >= 0.92 cosine similarity exists in the same appId, updates frequency and merges feedback.
     */
    async store(content: string, metadata: MemoryMetadata, deduplicate: boolean = true): Promise<string | null> {
        await this.initialize();
        const appId = metadata.appId || this.defaultAppId;
        const now = new Date().toISOString();
        let storedId: string | null = null;

        if (this.qdrant && this.isAvailable) {
            try {
                const denseVector = await this.embeddingProvider.embed(content);
                const sparseVector = SparseTokenizer.encode(content);

                if (deduplicate) {
                    const existing = await this.qdrant.query(this.collectionName, {
                        query: denseVector,
                        using: "dense",
                        limit: 1,
                        score_threshold: 0.92,
                        filter: {
                            must: [{ key: "appId", match: { value: appId } }]
                        },
                        with_payload: true
                    });

                    if (existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92) {
                        const matched = existing.points[0];
                        const existingPayload = (matched.payload || {}) as Record<string, any>;
                        const newFreq = ((existingPayload.frequency as number) || 1) + 1;
                        const mergedRating = metadata.qualityRating !== undefined
                            ? Math.max(metadata.qualityRating, (existingPayload.qualityRating as number) || 0)
                            : existingPayload.qualityRating;

                        await this.qdrant.setPayload(this.collectionName, {
                            wait: false,
                            points: [matched.id],
                            payload: {
                                frequency: newFreq,
                                lastSeen: now,
                                qualityRating: mergedRating,
                                verified: metadata.verified ?? existingPayload.verified
                            }
                        });

                        storedId = String(matched.id);
                    }
                }

                if (!storedId) {
                    const id = crypto.randomUUID();
                    await this.qdrant.upsert(this.collectionName, {
                        wait: false,
                        points: [
                            {
                                id,
                                vector: {
                                    dense: denseVector,
                                    sparse: sparseVector
                                },
                                payload: {
                                    content,
                                    appId,
                                    frequency: 1,
                                    qualityRating: metadata.qualityRating ?? 0.5,
                                    verified: metadata.verified ?? false,
                                    timestamp: now,
                                    lastSeen: now,
                                    ...metadata
                                }
                            }
                        ]
                    });

                    storedId = id;
                }
            } catch (err: any) {
                console.warn(`[MemoryCortex] Qdrant store error: ${err.message || err}. Falling back to in-memory store.`);
            }
        }

        if (!storedId) {
            // Ephemeral in-memory fallback
            try {
                const denseVector = await this.embeddingProvider.embed(content);
                const sparseVector = SparseTokenizer.encode(content);

                if (deduplicate) {
                    for (const existing of this.fallbackStore) {
                        if (existing.payload.appId === appId) {
                            const sim = this.cosineSimilarity(denseVector, existing.denseVector);
                            if (sim >= 0.92) {
                                existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                                existing.payload.lastSeen = now;
                                if (metadata.qualityRating !== undefined) {
                                    existing.payload.qualityRating = Math.max(metadata.qualityRating, existing.payload.qualityRating || 0);
                                }
                                if (metadata.verified !== undefined) {
                                    existing.payload.verified = metadata.verified;
                                }
                                storedId = existing.id;
                                break;
                            }
                        }
                    }
                }

                if (!storedId) {
                    const id = crypto.randomUUID();
                    this.fallbackStore.push({
                        id,
                        denseVector,
                        sparseVector,
                        payload: {
                            content,
                            appId,
                            frequency: 1,
                            qualityRating: metadata.qualityRating ?? 0.5,
                            verified: metadata.verified ?? false,
                            timestamp: now,
                            lastSeen: now,
                            ...metadata
                        }
                    });
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
                        const denseVector = await this.embeddingProvider.embed(memory.content);
                        const sparseVector = SparseTokenizer.encode(memory.content);
                        const id = crypto.randomUUID();

                        return {
                            id,
                            vector: {
                                dense: denseVector,
                                sparse: sparseVector
                            },
                            payload: {
                                content: memory.content,
                                appId: memory.metadata.appId || this.defaultAppId,
                                frequency: 1,
                                qualityRating: memory.metadata.qualityRating ?? 0.5,
                                verified: memory.metadata.verified ?? false,
                                timestamp: now,
                                lastSeen: now,
                                ...memory.metadata
                            }
                        };
                    })
                );

                await this.qdrant.upsert(this.collectionName, {
                    wait: false,
                    points
                });

                this.storesSinceConsolidation += points.length;
                if (this.autoConsolidateThreshold > 0 && this.storesSinceConsolidation >= this.autoConsolidateThreshold) {
                    this.storesSinceConsolidation = 0;
                    await this.consolidateMemories(this.autoConsolidationOptions);
                }

                return points.map(p => p.id as string);
            } catch (err: any) {
                console.warn(`[MemoryCortex] StoreBatch Qdrant error: ${err.message || err}. Falling back to in-memory store.`);
            }
        }

        // Ephemeral in-memory fallback
        try {
            const ids: string[] = [];
            for (const mem of memories) {
                const id = await this.store(mem.content, mem.metadata, false);
                if (id) ids.push(id);
            }
            return ids;
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
                await this.qdrant.setPayload(this.collectionName, {
                    wait: true,
                    points: [id],
                    payload: {
                        qualityRating: normalizedRating,
                        verified: normalizedRating >= 0.8,
                        feedback: feedback || undefined,
                        ratedAt: new Date().toISOString()
                    }
                });
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
            return true;
        }

        return false;
    }

    private async retrieveFromFallback(query: string, options: RetrievalOptions): Promise<any[]> {
        if (this.fallbackStore.length === 0) return [];

        const candidates = this.fallbackStore.filter(pt => {
            if (options.appId) {
                if (options.includeShared) {
                    if (pt.payload.appId !== options.appId && pt.payload.appId !== 'global' && pt.payload.appId !== 'shared') {
                        return false;
                    }
                } else if (pt.payload.appId !== options.appId) {
                    return false;
                }
            }
            if (options.domain && pt.payload.domain !== options.domain) return false;
            if (options.agentRole && pt.payload.agentRole !== options.agentRole) return false;
            if (options.minRating !== undefined && (pt.payload.qualityRating ?? 0) < options.minRating) return false;
            if (options.verifiedOnly && !pt.payload.verified) return false;
            return true;
        });

        if (candidates.length === 0) return [];

        const queryDense = await this.embeddingProvider.embed(query);
        const querySparse = SparseTokenizer.encode(query);

        // Dense ranking
        const denseRanked = [...candidates].map(candidate => ({
            candidate,
            score: this.cosineSimilarity(queryDense, candidate.denseVector)
        })).sort((a, b) => b.score - a.score);

        const denseRankMap = new Map<string, number>();
        denseRanked.forEach((item, idx) => denseRankMap.set(item.candidate.id, idx));

        // Sparse ranking
        const sparseRanked = [...candidates].map(candidate => ({
            candidate,
            score: this.sparseDotProduct(querySparse, candidate.sparseVector)
        })).sort((a, b) => b.score - a.score);

        const sparseRankMap = new Map<string, number>();
        sparseRanked.forEach((item, idx) => sparseRankMap.set(item.candidate.id, idx));

        const selectedProfile = options.profile || options.rrfProfile;
        const preset = typeof selectedProfile === 'string' ? RRF_PRESETS[selectedProfile] : selectedProfile;
        const denseWeight = options.denseWeight ?? preset?.denseWeight ?? 1.0;
        const sparseWeight = options.sparseWeight ?? preset?.sparseWeight ?? 1.0;

        // RRF scoring: (denseWeight / (60 + denseRank + 1)) + (sparseWeight / (60 + sparseRank + 1))
        const rrfRanked = candidates.map(candidate => {
            const dRank = denseRankMap.get(candidate.id) ?? candidates.length;
            const sRank = sparseRankMap.get(candidate.id) ?? candidates.length;
            const rrfScore = (denseWeight / (60 + dRank + 1)) + (sparseWeight / (60 + sRank + 1));
            return { candidate, rrfScore };
        }).sort((a, b) => b.rrfScore - a.rrfScore);

        const limit = options.limit || 3;
        return rrfRanked.slice(0, limit).map(item => item.candidate.payload);
    }

    /**
     * Retrieves relevant past experiences using hybrid search (Dense + Sparse RRF fusion)
     * with multi-tenant appId namespacing, quality thresholding, and ephemeral in-memory fallback.
     */
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

        if (this.qdrant && this.isAvailable) {
            try {
                const denseVector = await this.embeddingProvider.embed(query);
                const sparseVector = SparseTokenizer.encode(query);

                const filterMust: any[] = [];
                if (options.appId) {
                    if (options.includeShared) {
                        filterMust.push({
                            should: [
                                { key: "appId", match: { value: options.appId } },
                                { key: "appId", match: { value: "global" } },
                                { key: "appId", match: { value: "shared" } }
                            ]
                        });
                    } else {
                        filterMust.push({ key: "appId", match: { value: options.appId } });
                    }
                }
                if (options.domain) {
                    filterMust.push({ key: "domain", match: { value: options.domain } });
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
                const searchLimit = options.limit || 3;

                const results = await this.qdrant.query(this.collectionName, {
                    prefetch: [
                        {
                            query: denseVector,
                            using: "dense",
                            limit: searchLimit * 2,
                            filter,
                            params: { hnsw_ef: 64 }
                        },
                        {
                            query: sparseVector,
                            using: "sparse",
                            limit: searchLimit * 2,
                            filter
                        }
                    ],
                    query: {
                        rrf: { k: 60 }
                    },
                    limit: searchLimit,
                    with_payload: true
                });

                return results.points.map(r => r.payload).filter(Boolean);
            } catch (err: any) {
                console.warn(`[MemoryCortex] Hybrid retrieval error: ${err.message || err}. Falling back to in-memory search.`);
            }
        }

        return this.retrieveFromFallback(query, options);
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
        const minRating = options?.minRating ?? 0.40;
        const pruneLowQuality = options?.pruneLowQuality ?? true;
        const appId = options?.appId;
        const maxAgeDays = options?.maxAgeDays;

        const prunedIds: string[] = [];
        let inspected = 0;

        // Process in-memory fallback store
        if (this.fallbackStore.length > 0) {
            const now = Date.now();
            const remaining: StoredMemoryPoint[] = [];
            for (const pt of this.fallbackStore) {
                if (appId && pt.payload.appId !== appId) {
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
            this.fallbackStore.length = 0;
            this.fallbackStore.push(...remaining);
        }

        // Process Qdrant store if available
        if (this.qdrant && this.isAvailable) {
            try {
                if (typeof (this.qdrant as any).scroll === 'function') {
                    const scrollFilter: any[] = [];
                    if (appId) scrollFilter.push({ key: "appId", match: { value: appId } });
                    const scrollRes = await (this.qdrant as any).scroll(this.collectionName, {
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
                    if (qdrantPruneIds.length > 0 && typeof (this.qdrant as any).delete === 'function') {
                        await (this.qdrant as any).delete(this.collectionName, {
                            wait: true,
                            points: qdrantPruneIds
                        });
                    }
                } else if (typeof (this.qdrant as any).delete === 'function') {
                    const filterMust: any[] = [];
                    if (appId) filterMust.push({ key: "appId", match: { value: appId } });
                    if (pruneLowQuality) filterMust.push({ key: "qualityRating", range: { lt: minRating } });
                    await (this.qdrant as any).delete(this.collectionName, {
                        wait: true,
                        filter: { must: filterMust }
                    });
                }
            } catch (err: any) {
                console.warn(`[MemoryCortex] ConsolidateMemories Qdrant error: ${err.message || err}`);
            }
        }

        return {
            inspected,
            pruned: prunedIds.length,
            retained: Math.max(0, inspected - prunedIds.length),
            prunedIds
        };
    }

    /**
     * Exports a portable snapshot of stored memories filtered by options.
     */
    async exportMemories(options?: ExportMemoriesOptions): Promise<MemorySnapshot> {
        await this.initialize();
        const minRating = options?.minRating;
        const verifiedOnly = options?.verifiedOnly;
        const appId = options?.appId;
        const includeVectors = options?.includeVectors !== false;

        const snapshotPoints: MemorySnapshotPoint[] = [];

        // 1. In-memory fallback points
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

        // 2. Qdrant points if available
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
     * Imports a portable snapshot or array of memories into the Cortex.
     */
    async importMemories(
        input: MemorySnapshot | string | any[],
        options?: ImportMemoriesOptions
    ): Promise<ImportMemoriesResult> {
        await this.initialize();
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
                appId: targetAppId || rawMeta.appId || this.defaultAppId,
                qualityRating,
                verified: rawMeta.verified ?? (qualityRating >= 0.8)
            };

            const hasVectors = Array.isArray(item.denseVector) && item.denseVector.length > 0;
            const denseVector = (hasVectors && !recomputeVectors)
                ? item.denseVector
                : await this.embeddingProvider.embed(content);
            const sparseVector = item.sparseVector || SparseTokenizer.encode(content);
            const pointId = item.id || crypto.randomUUID();
            const now = new Date().toISOString();

            if (this.qdrant && this.isAvailable) {
                try {
                    let isDup = false;
                    if (deduplicate) {
                        const existing = await this.qdrant.query(this.collectionName, {
                            query: denseVector,
                            using: "dense",
                            limit: 1,
                            score_threshold: 0.92,
                            filter: {
                                must: [{ key: "appId", match: { value: metadata.appId } }]
                            },
                            with_payload: true
                        });
                        if (existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92) {
                            isDup = true;
                            deduplicated++;
                            importedIds.push(String(existing.points[0].id));
                        }
                    }

                    if (!isDup) {
                        await this.qdrant.upsert(this.collectionName, {
                            wait: false,
                            points: [{
                                id: pointId,
                                vector: { dense: denseVector, sparse: sparseVector },
                                payload: { content, ...metadata, frequency: 1, timestamp: now, lastSeen: now }
                            }]
                        });
                        imported++;
                        importedIds.push(pointId);
                    }
                    continue;
                } catch (err: any) {
                    console.warn(`[MemoryCortex] Import Qdrant error: ${err.message || err}. Falling back to in-memory store.`);
                }
            }

            // Ephemeral fallback
            let isDup = false;
            if (deduplicate) {
                for (const existing of this.fallbackStore) {
                    if (existing.payload.appId === metadata.appId) {
                        const sim = this.cosineSimilarity(denseVector, existing.denseVector);
                        if (sim >= 0.92) {
                            isDup = true;
                            existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                            existing.payload.qualityRating = Math.max(metadata.qualityRating ?? 0, existing.payload.qualityRating || 0);
                            deduplicated++;
                            importedIds.push(existing.id);
                            break;
                        }
                    }
                }
            }

            if (!isDup) {
                this.fallbackStore.push({
                    id: pointId,
                    denseVector,
                    sparseVector,
                    payload: {
                        content,
                        appId: metadata.appId!,
                        frequency: 1,
                        qualityRating,
                        verified: metadata.verified ?? false,
                        timestamp: now,
                        lastSeen: now,
                        ...metadata
                    }
                });
                imported++;
                importedIds.push(pointId);
            }
        }

        return {
            imported,
            skipped,
            deduplicated,
            importedIds
        };
    }

    /**
     * Wipes the collection and in-memory store.
     */
    async wipeCollection(): Promise<boolean> {
        this.fallbackStore.length = 0;
        this.storesSinceConsolidation = 0;
        if (!this.qdrant) {
            this.initialized = false;
            return true;
        }
        try {
            await this.qdrant.deleteCollection(this.collectionName);
            this.initialized = false;
            console.log(`[MemoryCortex] Successfully deleted collection: ${this.collectionName}`);
            return true;
        } catch (error: any) {
            console.warn(`[MemoryCortex] WipeCollection failed: ${error.message || error}`);
            return false;
        }
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

    getPendingConsolidationCount(): number {
        return this.storesSinceConsolidation;
    }
}
