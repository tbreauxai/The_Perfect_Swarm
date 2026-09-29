import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';

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
import { SparseVector, MemorySnapshot, MemorySnapshotPoint, MemoryMetadata, EmbeddingProvider, RrfProfile } from './types.ts';
