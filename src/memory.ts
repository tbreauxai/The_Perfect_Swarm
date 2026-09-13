import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';

export interface MemoryMetadata {
    domain: string;
    agentRole: string;
    sessionId?: string;
    successRating?: number;
    tags?: string[];
    [key: string]: any;
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
    embeddingProvider?: EmbeddingProvider;
    aiClient?: GoogleGenAI;
}

/**
 * High-performance, hybrid vector memory engine powered by Qdrant.
 * Features:
 * - Hybrid dense + sparse vectors merged via Reciprocal Rank Fusion (RRF)
 * - Compliant Qdrant int8 scalar quantization and on-disk payload storage
 * - Flexible embedding providers (Gemini or Deterministic Local fallback)
 * - Resilient failure handling with zero uncaught crashes
 */
export class MemoryCortex {
    private qdrant: QdrantClient | null = null;
    private embeddingProvider: EmbeddingProvider;
    private collectionName: string;
    private initialized: boolean = false;
    private isAvailable: boolean = false;

    constructor(config: MemoryCortexConfig) {
        const url = config.url || process.env.QDRANT_URL;
        const apiKey = config.apiKey || process.env.QDRANT_API_KEY;
        this.collectionName = config.collectionName || "pwa_swarm_dev_cortex_v2";

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

    /**
     * Initializes the collection in Qdrant using compliant schemas:
     * - Cosine dense vector (768-dim) + sparse BM25 vector
     * - Int8 scalar quantization for 4x memory compression
     * - On-disk payload storage to protect RAM
     * - Keyword index on domain for fast filtered retrieval
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

                await this.qdrant.createPayloadIndex(this.collectionName, {
                    field_name: "domain",
                    field_schema: "keyword"
                });

                console.log(`[MemoryCortex] Initialized compliant Qdrant collection: ${this.collectionName}`);
            }

            this.initialized = true;
            return true;
        } catch (error: any) {
            console.warn(`[MemoryCortex] Initialization failed: ${error.message || error}`);
            this.isAvailable = false;
            return false;
        }
    }

    /**
     * Stores an analysis memory point into Qdrant.
     */
    async store(content: string, metadata: MemoryMetadata): Promise<string | null> {
        const ready = await this.initialize();
        if (!ready || !this.qdrant) return null;

        try {
            const denseVector = await this.embeddingProvider.embed(content);
            const sparseVector = SparseTokenizer.encode(content);
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
                            ...metadata,
                            timestamp: new Date().toISOString()
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
                            ...memory.metadata,
                            timestamp: new Date().toISOString()
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
     * Retrieves the most relevant past experiences using hybrid search (Dense + Sparse RRF fusion).
     */
    async retrieve(query: string, domainFilter?: string, limit: number = 3): Promise<any[]> {
        const ready = await this.initialize();
        if (!ready || !this.qdrant) return [];

        try {
            const denseVector = await this.embeddingProvider.embed(query);
            const sparseVector = SparseTokenizer.encode(query);

            const filter = domainFilter ? {
                must: [
                    {
                        key: "domain",
                        match: { value: domainFilter }
                    }
                ]
            } : undefined;

            const results = await this.qdrant.query(this.collectionName, {
                prefetch: [
                    {
                        query: denseVector,
                        using: "dense",
                        limit: limit * 2,
                        filter,
                        params: {
                            hnsw_ef: 64
                        }
                    },
                    {
                        query: sparseVector,
                        using: "sparse",
                        limit: limit * 2,
                        filter
                    }
                ],
                query: {
                    rrf: {
                        k: 60
                    }
                },
                limit,
                with_payload: true
            });

            return results.points.map(r => r.payload).filter(Boolean);
        } catch (err: any) {
            console.warn(`[MemoryCortex] Hybrid retrieval error: ${err.message || err}`);
            return [];
        }
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
