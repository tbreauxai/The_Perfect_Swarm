const fs = require('fs');
let code = fs.readFileSync('src/memory.ts', 'utf-8');

// 1. Add SparseTokenizer
const tokenizerCode = `
class SparseTokenizer {
    static encode(text, vocabSize = 10000) {
        const tokens = text.toLowerCase().match(/\\b\\w+\\b/g) || [];
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
`;
code = code.replace("export class MemoryCortex {", tokenizerCode + "\nexport class MemoryCortex {");

// 2. Change collection name
code = code.replace(`collectionName: string = "pwa_swarm_dev_cortex"`, `collectionName: string = "pwa_swarm_dev_cortex_v2"`);

// 3. Update createCollection schema
const createCollectionStr = `                await this.qdrant.createCollection(this.collectionName, {
                    vectors: {
                        size: 768, // Gemini text-embedding-004 dimension size
                        distance: 'Cosine',
                        memory: 'cold', // Keeps full original vectors on disk
                        datatype: 'turbo4' // 4-bit dimension compression for maximum disk efficiency
                    },`;

const newCreateCollectionStr = `                await this.qdrant.createCollection(this.collectionName, {
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
                    },`;

code = code.replace(createCollectionStr, newCreateCollectionStr);

// 4. Update quantization and hnsw config for named vectors
const hnswConfigStr = `                    quantization_config: {
                        turbo: {
                            bits: "bits4",
                            memory: "pinned"
                        }
                    },
                    hnsw_config: {
                        m: 32,
                        ef_construct: 256,
                        memory: 'cold', // Store HNSW index on disk
                        inline_storage: true, // Stores vector copies directly inside HNSW index to minimize random disk reads
                        max_indexing_threads: 4
                    },`;

const newHnswConfigStr = `                    // Note: When using named vectors, you typically specify quantization and hnsw inside the vector params or globally if generic. 
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
                    },`;
code = code.replace(hnswConfigStr, newHnswConfigStr);

// 5. Update upsert in store()
const storeUpsertStr = `                    vector: vector,
                    payload: {`;
const newStoreUpsertStr = `                    vector: {
                        "dense": vector,
                        "sparse": SparseTokenizer.encode(content)
                    },
                    payload: {`;
code = code.replace(storeUpsertStr, newStoreUpsertStr);

// 6. Update upsert in storeBatch()
const storeBatchUpsertStr = `                vector: vector,
                payload: {`;
const newStoreBatchUpsertStr = `                vector: {
                    "dense": vector,
                    "sparse": SparseTokenizer.encode(memory.content)
                },
                payload: {`;
code = code.replace(storeBatchUpsertStr, newStoreBatchUpsertStr);

// 7. Update retrieve() for Hybrid Search + RRF
const oldRetrieveStr = `        const results = await this.qdrant.query(this.collectionName, {
            query: queryVector,
            limit: limit,
            filter: filter,
            with_payload: true,
            params: {
                hnsw_ef: 128, // High ef for better recall on compressed vectors
                quantization: {
                    rescore: true, // Rerank top candidates with full-precision vectors from disk
                    oversampling: 2.0 // Pre-select 2x candidates using pinned quantized index
                }
            }
        });`;

const newRetrieveStr = `        const sparseQueryVector = SparseTokenizer.encode(query);
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
        });`;

code = code.replace(oldRetrieveStr, newRetrieveStr);

fs.writeFileSync('src/memory.ts', code);
