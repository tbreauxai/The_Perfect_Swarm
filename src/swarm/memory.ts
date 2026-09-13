import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';

export interface MemoryMetadata {
    appId?: string;
    domain: string;
    agentRole: string;
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

export interface RetrievalOptions {
    appId?: string;
    domain?: string;
    limit?: number;
    minRating?: number;
    verifiedOnly?: boolean;
    agentRole?: string;
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
    private qdrant: QdrantClient | null = null;
    private embeddingProvider: EmbeddingProvider;
    private collectionName: string;
    private defaultAppId: string;
    private initialized: boolean = false;
    private isAvailable: boolean = false;

    constructor(config: MemoryCortexConfig) {
        const url = config.url || process.env.QDRANT_URL;
        const apiKey = config.apiKey || process.env.QDRANT_API_KEY;
        this.collectionName = config.collectionName || "pwa_swarm_dev_cortex_v2";
        this.defaultAppId = config.defaultAppId || "default";

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
        if (this.initialized) return this.isAvailable;
        if (!this.qdrant || !this.isAvailable) return false;

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

            this.initialized = true;
            return true;
        } catch (error: any) {
            console.warn(`[MemoryCortex] Initialization failed: ${error.message || error}`);
            this.isAvailable = false;
            return false;
        }
    }

    /**
     * Stores an analysis memory point with automatic semantic deduplication.
     * If a memory with >= 0.92 cosine similarity exists in the same appId, updates frequency and merges feedback.
     */
    async store(content: string, metadata: MemoryMetadata, deduplicate: boolean = true): Promise<string | null> {
        const ready = await this.initialize();
        if (!ready || !this.qdrant) return null;

        try {
            const denseVector = await this.embeddingProvider.embed(content);
            const sparseVector = SparseTokenizer.encode(content);
            const appId = metadata.appId || this.defaultAppId;
            const now = new Date().toISOString();

            if (deduplicate) {
                // Check if semantically identical memory already exists
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

                    return String(matched.id);
                }
            }

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

            return id;
        } catch (err: any) {
            console.warn(`[MemoryCortex] Store error: ${err.message || err}`);
            return null;
        }
    }

    /**
     * Stores a batch of analysis experiences into Qdrant.
     */
    async storeBatch(memories: { content: string; metadata: MemoryMetadata }[]): Promise<string[]> {
        const ready = await this.initialize();
        if (!ready || !this.qdrant || memories.length === 0) return [];

        try {
            const now = new Date().toISOString();
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

            return points.map(p => p.id as string);
        } catch (err: any) {
            console.warn(`[MemoryCortex] StoreBatch error: ${err.message || err}`);
            return [];
        }
    }

    /**
     * Rates a stored analysis memory to enable continuous reinforcement learning.
     */
    async rateMemory(id: string, rating: number, feedback?: string): Promise<boolean> {
        const ready = await this.initialize();
        if (!ready || !this.qdrant) return false;

        try {
            const normalizedRating = Math.max(0, Math.min(1, rating));
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
            console.warn(`[MemoryCortex] RateMemory error: ${err.message || err}`);
            return false;
        }
    }

    /**
     * Retrieves relevant past experiences using hybrid search (Dense + Sparse RRF fusion)
     * with multi-tenant appId namespacing and quality thresholding.
     */
    async retrieve(
        query: string,
        optionsOrDomain?: string | RetrievalOptions,
        limit: number = 3
    ): Promise<any[]> {
        const ready = await this.initialize();
        if (!ready || !this.qdrant) return [];

        try {
            let options: RetrievalOptions = {};
            if (typeof optionsOrDomain === 'string') {
                options = { domain: optionsOrDomain, limit };
            } else if (typeof optionsOrDomain === 'object' && optionsOrDomain !== null) {
                options = { ...optionsOrDomain, limit: optionsOrDomain.limit || limit };
            } else {
                options = { limit };
            }

            const denseVector = await this.embeddingProvider.embed(query);
            const sparseVector = SparseTokenizer.encode(query);

            const filterMust: any[] = [];
            if (options.appId) {
                filterMust.push({ key: "appId", match: { value: options.appId } });
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
            console.warn(`[MemoryCortex] Hybrid retrieval error: ${err.message || err}`);
            return [];
        }
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
     * Wipes the collection for this specific application testing ground.
     */
    async wipeCollection(): Promise<boolean> {
        if (!this.qdrant) return false;
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
        return this.isAvailable;
    }
}
