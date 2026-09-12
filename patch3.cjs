const fs = require('fs');
let code = fs.readFileSync('src/memory.ts', 'utf-8');

const oldRetrieve = `        const results = await this.qdrant.query(this.collectionName, {
            query: queryVector,
            limit: limit,
            filter: filter,
            with_payload: true
        });`;

const newRetrieve = `        const results = await this.qdrant.query(this.collectionName, {
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

code = code.replace(oldRetrieve, newRetrieve);

fs.writeFileSync('src/memory.ts', code);
