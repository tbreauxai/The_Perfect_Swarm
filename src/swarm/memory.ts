import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
// node:fs and node:path are dynamically imported to allow Cloudflare Edge deployment
import { createVectorIndex, type VectorIndex, type VectorIndexMetrics } from './vectorIndex.ts';
import { SemanticCacheInterceptor, type SemanticCacheInterceptorConfig, type SemanticCacheStats } from './semanticCacheInterceptor.ts';

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

export type RrfProfile = 'semantic' | 'lexical' | 'balanced' | 'hybrid' | 'quantitative';
export type RrfWeights = { denseWeight: number; sparseWeight: number };

export const RRF_PRESETS: Record<RrfProfile, RrfWeights> = {
    semantic: { denseWeight: 4.0, sparseWeight: 0.5 },
    lexical: { denseWeight: 0.5, sparseWeight: 4.0 },
    balanced: { denseWeight: 1.0, sparseWeight: 1.0 },
    hybrid: { denseWeight: 2.0, sparseWeight: 1.5 },
    quantitative: { denseWeight: 0.2, sparseWeight: 4.0 }
};

export interface RetrievalOptions {
    appId?: string;
    targetApps?: string | string[];
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
    private modelNames: string[];
    private timeoutMs: number;

    constructor(
        aiClient: GoogleGenAI,
        modelName: string = 'text-embedding-005',
        timeoutMs: number = 5000
    ) {
        this.aiClient = aiClient;
        this.modelNames = [modelName, 'text-embedding-005', 'text-embedding-004'];
        this.timeoutMs = timeoutMs;
    }

    async embed(text: string): Promise<number[]> {
        let timeoutId: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`[TIMEOUT] Gemini embedding request timed out after ${this.timeoutMs}ms.`));
            }, this.timeoutMs);
        });

        let lastError: any;
        for (const model of this.modelNames) {
            try {
                const response: any = await Promise.race([
                    this.aiClient.models.embedContent({
                        model: model,
                        contents: [text],
                    }),
                    timeoutPromise
                ]);
                return response.embeddings?.[0]?.values || response.embeddings?.[0]?.value || [];
            } catch (err: any) {
                lastError = err;
                const msg = err.message || '';
                // If model not found, try the next one in the fallback list
                if (msg.includes('404') || msg.includes('not found') || msg.includes('not supported')) {
                    continue;
                }
                break;
            }
        }
        clearTimeout(timeoutId);
        throw lastError;
    }
}

/**
 * Deterministic local dense embedding generator (768 dimensions).
 * Enables offline execution, zero-cost operation, and local testing without external API keys.
 */
export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;

    static computeVector(text: string, dimension: number = 768): number[] {
        const vector = new Array(dimension).fill(0);
        const tokens = (text || '').toLowerCase().match(/\b\w+\b/g) || [];
        if (tokens.length === 0) return vector;

        for (const token of tokens) {
            let hash = 5381;
            for (let i = 0; i < token.length; i++) {
                hash = ((hash << 5) + hash) + token.charCodeAt(i);
                hash |= 0;
            }
            const index = Math.abs(hash) % dimension;
            vector[index] += 1;
        }

        let sumSq = 0;
        for (let i = 0; i < dimension; i++) sumSq += vector[i] * vector[i];
        const norm = Math.sqrt(sumSq) || 1;
        for (let i = 0; i < dimension; i++) vector[i] /= norm;

        return vector;
    }

    async embed(text: string): Promise<number[]> {
        return DeterministicLocalEmbeddingProvider.computeVector(text, this.dimension);
    }
}

export interface MemoryCortexConfig {
    url?: string;
    apiKey?: string;
    collectionName?: string;
    collectionNameTemplate?: string;
    defaultAppId?: string;
    embeddingProvider?: EmbeddingProvider;
    aiClient?: GoogleGenAI;
    isolatedStore?: boolean;
    autoConsolidateThreshold?: number;
    autoConsolidationOptions?: ConsolidationOptions;
    persistPath?: string;
    autoSave?: boolean;
    semanticCacheConfig?: SemanticCacheInterceptorConfig;
}

/**
 * High-performance, hybrid continuous learning vector cortex powered by Qdrant.
 * Features:
 * - Multi-tenant application namespacing (`appId`)
 * - Dynamic collection namespacing (`collectionNameTemplate`)
 * - Continuous learning feedback loop (`rateMemory`, `reinforceMemory`)
 * - Semantic deduplication with cosine clustering threshold (>0.92)
 * - Few-shot exemplary retrieval for prompt distillation
 * - Hybrid dense + sparse vectors merged via Reciprocal Rank Fusion (RRF)
 * - Compliant Qdrant int8 scalar quantization and on-disk payload storage
 */
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
            this.embeddingProvider = new GeminiEmbeddingProvider(config.aiClient);
        } else {
            this.embeddingProvider = new DeterministicLocalEmbeddingProvider();
        }

        this.semanticCache = new SemanticCacheInterceptor({
            similarityThreshold: config.semanticCacheConfig?.similarityThreshold ?? 0.96,
            maxEntries: config.semanticCacheConfig?.maxEntries ?? 500,
            defaultTtlMs: config.semanticCacheConfig?.defaultTtlMs
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
        const targetCollection = this.collectionName;

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

                console.log(`[MemoryCortex] Initialized compliant Qdrant collection: ${targetCollection}`);
            }

            // Create compound payload indexes for multi-tenant and learning queries
            await this.ensurePayloadIndex(targetCollection, "domain", "keyword");
            await this.ensurePayloadIndex(targetCollection, "appId", "keyword");
            await this.ensurePayloadIndex(targetCollection, "targetApps", "keyword");
            await this.ensurePayloadIndex(targetCollection, "agentRole", "keyword");
            await this.ensurePayloadIndex(targetCollection, "qualityRating", "float");
            await this.ensurePayloadIndex(targetCollection, "verified", "bool");

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
                const denseVector = await this.safeEmbed(content);
                const sparseVector = SparseTokenizer.encode(content);

                if (deduplicate) {
                    const existing = await this.withTimeout(this.qdrant.query(this.collectionName, {
                        query: denseVector,
                        using: "dense",
                        limit: 1,
                        score_threshold: 0.92,
                        filter: {
                            must: [{ key: "appId", match: { value: appId } }]
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
                                verified: metadata.verified ?? existingPayload.verified
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
                        (item) => item.data.payload.appId === appId
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
                        storedId = existing.id;
                    }
                }

                if (!storedId) {
                    const id = crypto.randomUUID();
                    const newPoint: StoredMemoryPoint = {
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

        // Check Semantic Cache Interceptor first (> 0.96 threshold)
        const cachedMatch = this.semanticCache.lookup<any[]>(queryDense, options.appId);
        if (cachedMatch.hit && cachedMatch.payload) {
            return cachedMatch.payload;
        }

        let results: any[] = [];

        if (this.qdrant && this.isAvailable) {
            try {
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

                const qdrantRes = await this.withTimeout(this.qdrant.query(this.collectionName, {
                    prefetch: [
                        {
                            query: queryDense,
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
                }));

                results = qdrantRes.points.map(r => r.payload).filter(Boolean);
            } catch (err: any) {
                console.warn(`[MemoryCortex] Hybrid retrieval error: ${err.message || err}. Falling back to in-memory search.`);
                results = await this.retrieveFromFallbackWithVector(queryDense, options);
            }
        } else {
            results = await this.retrieveFromFallbackWithVector(queryDense, options);
        }

        // Store result in semantic cache for future queries (> 0.96 similarity)
        if (results.length > 0) {
            this.semanticCache.set(queryDense, results, options.appId);
        }

        return results;
    }

    private async retrieveFromFallbackWithVector(queryDense: number[], options: RetrievalOptions): Promise<any[]> {
        if (this.fallbackStore.length === 0) return [];

        const filterPredicate = (pt: StoredMemoryPoint) => {
            if (options.appId) {
                if (options.includeShared) {
                    if (pt.payload.appId !== options.appId && pt.payload.appId !== 'global' && pt.payload.appId !== 'shared') {
                        return false;
                    }
                } else if (pt.payload.appId !== options.appId) {
                    return false;
                }
            }
            if (options.targetApps) {
                const targets = Array.isArray(options.targetApps) ? options.targetApps : [options.targetApps];
                const ptTargetApps = Array.isArray(pt.payload.targetApps) ? pt.payload.targetApps : (pt.payload.targetApps ? [pt.payload.targetApps] : []);
                const matchFound = targets.some(t => ptTargetApps.includes(t) || pt.payload.appId === t);
                if (!matchFound) return false;
            }
            if (options.domain && pt.payload.domain !== options.domain) return false;
            if (options.agentRole && pt.payload.agentRole !== options.agentRole) return false;
            if (options.minRating !== undefined && (pt.payload.qualityRating ?? 0) < options.minRating) return false;
            if (options.verifiedOnly && !pt.payload.verified) return false;
            return true;
        };

        // Sub-linear O(log n) candidate retrieval from vector index
        const searchK = Math.min(this.vectorIndex.size, Math.max((options.limit || 3) * 3, 15));
        const indexHits = this.vectorIndex.search(queryDense, {
            k: searchK,
            filter: (item) => filterPredicate(item.data)
        });

        let candidates: StoredMemoryPoint[];
        const denseRankMap = new Map<string, number>();

        if (indexHits.length > 0) {
            candidates = indexHits.map(h => h.data);
            indexHits.forEach((hit, idx) => denseRankMap.set(hit.id, idx));
        } else {
            candidates = this.fallbackStore.filter(filterPredicate);
            if (candidates.length === 0) return [];
            const denseRanked = [...candidates].map(candidate => ({
                candidate,
                score: this.cosineSimilarity(queryDense, candidate.denseVector)
            })).sort((a, b) => b.score - a.score);
            denseRanked.forEach((item, idx) => denseRankMap.set(item.candidate.id, idx));
        }

        const limit = options.limit || 3;
        return candidates.slice(0, limit).map(item => item.payload);
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
            for (const pId of prunedIds) {
                this.vectorIndex.delete(pId);
            }
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

        if (prunedIds.length > 0) {
            await this.savePersistFileIfConfigured();
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
     * Saves all cortex memories to a local snapshot file (JSON or JSONL based on extension).
     */
    async saveToFile(filePath?: string): Promise<string> {
        const targetPath = filePath || this.persistPath;
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
        const content = isJsonl ? await this.exportJsonl() : await this.exportJson();
        fs.writeFileSync(targetPath, content, 'utf-8');
        return targetPath;
    }

    /**
     * Loads memories from a local snapshot file (JSON or JSONL) into the cortex.
     */
    async loadFromFile(filePath?: string, options?: ImportMemoriesOptions): Promise<ImportMemoriesResult> {
        const targetPath = filePath || this.persistPath;
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
        return await this.importMemories(raw, options);
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
                : await this.safeEmbed(content);
            const sparseVector = item.sparseVector || SparseTokenizer.encode(content);
            const pointId = item.id || crypto.randomUUID();
            const now = new Date().toISOString();

            if (this.qdrant && this.isAvailable) {
                try {
                    let isDup = false;
                    if (deduplicate) {
                        const existing = await this.withTimeout(this.qdrant.query(this.collectionName, {
                            query: denseVector,
                            using: "dense",
                            limit: 1,
                            score_threshold: 0.92,
                            filter: {
                                must: [{ key: "appId", match: { value: metadata.appId } }]
                            },
                            with_payload: true
                        }));
                        if (existing.points.length > 0 && (existing.points[0].score ?? 0) >= 0.92) {
                            isDup = true;
                            deduplicated++;
                            importedIds.push(String(existing.points[0].id));
                        }
                    }

                    if (!isDup) {
                        await this.withTimeout(this.qdrant.upsert(this.collectionName, {
                            wait: false,
                            points: [{
                                id: pointId,
                                vector: { dense: denseVector, sparse: sparseVector },
                                payload: {
                                    content,
                                    frequency: 1,
                                    timestamp: now,
                                    lastSeen: now,
                                    ...metadata
                                }
                            }]
                        }));
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
                const match = this.vectorIndex.findMostSimilar(
                    denseVector,
                    0.92,
                    (item) => item.data.payload.appId === metadata.appId
                );
                if (match) {
                    isDup = true;
                    const existing = match.data;
                    existing.payload.frequency = (existing.payload.frequency || 1) + 1;
                    existing.payload.qualityRating = Math.max(metadata.qualityRating ?? 0, existing.payload.qualityRating || 0);
                    deduplicated++;
                    importedIds.push(existing.id);
                }
            }

            if (!isDup) {
                const newPoint: StoredMemoryPoint = {
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
                };
                this.fallbackStore.push(newPoint);
                this.vectorIndex.insert(pointId, denseVector, newPoint);
                imported++;
                importedIds.push(pointId);
            }
        }

        if (!this.isAutoLoading && imported > 0) {
            await this.savePersistFileIfConfigured();
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

    getSemanticCacheStats(): SemanticCacheStats {
        return this.semanticCache.getStats();
    }
}

