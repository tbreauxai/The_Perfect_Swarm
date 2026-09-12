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


class SparseTokenizer {
    static encode(text, vocabSize = 10000) {
        const tokens = text.toLowerCase().match(/\b\w+\b/g) || [];
        const termFreqs = {};
        for (const token of tokens) {
            let hash = 0;
            for (let i = 0; i < token.length; i++) {
                hash = ((hash << 5) - hash) + token.charCodeAt(i);
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

export class MemoryCortex {
    private qdrant: QdrantClient;
    private aiClient: GoogleGenAI;
    private collectionName: string;
    private initialized: boolean = false;

    constructor(
        qdrantUrl: string,
        qdrantApiKey: string,
        aiClient: GoogleGenAI,
        collectionName: string = "pwa_swarm_dev_cortex_v2" // Changed to a specific dev collection to prevent cross-contamination
    ) {
        this.qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });
        this.aiClient = aiClient;
        this.collectionName = collectionName;
    }

    /**
     * Ensures the collection exists in Qdrant with highly optimized settings:
     * - Scalar Quantization (reduces RAM usage by 4x)
     * - On-Disk Payload (saves RAM for your live cluster)
     * - Payload Indexing (speeds up domain-specific filtering)
     */
    async initialize() {
        if (this.initialized) return;

        try {
            const collections = await this.qdrant.getCollections();
            const exists = collections.collections.some(c => c.name === this.collectionName);

            if (!exists) {
                await this.qdrant.createCollection(this.collectionName, {
                    vectors: {
                        "dense": {
                            size: 768, // Gemini text-embedding-004 dimension size
                            distance: 'Cosine',
                            memory: 'cold',
                            datatype: 'turbo4'
                        }
                    },
                    sparse_vectors: {
                        "sparse": { }
                    },
                    // 8x compression with high recall across models, pinned in RAM for low-latency
                    // Note: When using named vectors, you typically specify quantization and hnsw inside the vector params or globally if generic. 
                    // To be safe we put it at the root which serves as default.
                    quantization_config: {
                        turbo: {
                            bits: "bits4",
                            memory: "pinned"
                        }
                    },
                    hnsw_config: {
                        m: 32,
                        ef_construct: 256,
                        memory: 'cold',
                        inline_storage: true,
                        max_indexing_threads: 4
                    },
                    optimizers_config: {
                        default_segment_number: 8, // Match to vCPU core count for low per-query latency
                        max_optimization_threads: 1, // Serializes background merges per shard to eliminate CPU spikes
                        deleted_threshold: 0.3, // Prevent vacuum optimizer from interrupting search threads prematurely
                        prevent_unoptimized: true // Prevents brute-force backlog scans during write bursts
                    },
                    strict_mode_config: {
                        unindexed_filtering_retrieve: false, // Hard-rejects any filters on unindexed fields to prevent catastrophic latency spikes
                        unindexed_filtering_update: false
                    },
                    on_disk_payload: true // Keeps JSON payloads on disk rather than RAM
                });

                // Create a keyword index on the 'domain' field so filtering is instantaneous (O(1) lookup)
                await this.qdrant.createPayloadIndex(this.collectionName, {
                    field_name: "domain",
                    field_schema: "keyword"
                });

                console.log(`[MemoryCortex] Created optimized collection: ${this.collectionName}`);
            }
            this.initialized = true;
        } catch (error) {
            console.error("[MemoryCortex] Initialization failed:", error);
            throw error;
        }
    }

    /**
     * Generates an embedding for a text string using Gemini.
     */
    private async getEmbedding(text: string): Promise<number[]> {
        const response = await this.aiClient.models.embedContent({
            model: 'text-embedding-004',
            contents: text,
        });
        return response.embeddings?.[0]?.values || [];
    }

    /**
     * Stores an experience, insight, or past interaction into long-term memory.
     */
    async store(content: string, metadata: MemoryMetadata): Promise<string> {
        await this.initialize();
        
        const vector = await this.getEmbedding(content);
        const id = crypto.randomUUID();

        await this.qdrant.upsert(this.collectionName, {
            wait: false, // Non-blocking write to avoid locking thread pools when prevent_unoptimized is true
            points: [
                {
                    id: id,
                    vector: {
                        "dense": vector,
                        "sparse": SparseTokenizer.encode(content)
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
    }

    /**
     * Batches multiple experiences into long-term memory. 
     * Recommended chunk sizes: 100 - 500 vectors per write to reduce transaction overhead.
     */
    async storeBatch(memories: {content: string, metadata: MemoryMetadata}[]): Promise<string[]> {
        await this.initialize();
        
        // Generate embeddings in parallel (assuming external API handles concurrency well)
        // In highly productionized systems, you may want to chunk the API embedding calls as well.
        const points = await Promise.all(memories.map(async (memory) => {
            const vector = await this.getEmbedding(memory.content);
            const id = crypto.randomUUID();
            return {
                id: id,
                vector: {
                    "dense": vector,
                    "sparse": SparseTokenizer.encode(memory.content)
                },
                payload: {
                    content: memory.content,
                    ...memory.metadata,
                    timestamp: new Date().toISOString()
                }
            };
        }));

        await this.qdrant.upsert(this.collectionName, {
            wait: false, // Mandatory non-blocking write
            points: points
        });

        return points.map(p => p.id as string);
    }

    /**
     * Retrieves the most relevant past experiences based on a semantic query.
     */
    async retrieve(query: string, domainFilter?: string, limit: number = 3): Promise<any[]> {
        await this.initialize();

        const queryVector = await this.getEmbedding(query);

        // Optional: Pre-filter by domain (e.g., only search "finance" or "sports" memories)
        const filter = domainFilter ? {
            must: [
                {
                    key: "domain",
                    match: { value: domainFilter }
                }
            ]
        } : undefined;

        const sparseQueryVector = SparseTokenizer.encode(query);
        const results = await this.qdrant.query(this.collectionName, {
            prefetch: [
                {
                    query: queryVector,
                    using: "dense",
                    limit: limit * 2,
                    filter: filter,
                    params: {
                        hnsw_ef: 128,
                        quantization: {
                            rescore: true,
                            oversampling: 2.0
                        }
                    }
                },
                {
                    query: sparseQueryVector,
                    using: "sparse",
                    limit: limit * 2,
                    filter: filter,
                }
            ],
            query: {
                rrf: {
                    k: 60
                }
            },
            limit: limit,
            with_payload: true
        });

        return results.points.map(result => result.payload);
    }

    /**
     * DANGER: Wipes the entire testing ground collection.
     * This ONLY deletes the collection specified by this.collectionName (e.g. "pwa_swarm_dev_cortex")
     * and will NOT touch any other collections or data in your Qdrant cluster.
     */
    async wipeCollection(): Promise<void> {
        try {
            await this.qdrant.deleteCollection(this.collectionName);
            this.initialized = false;
            console.log(`[MemoryCortex] Successfully wiped collection: ${this.collectionName}`);
        } catch (error) {
            console.error(`[MemoryCortex] Failed to wipe collection ${this.collectionName}:`, error);
            throw error;
        }
    }
}
