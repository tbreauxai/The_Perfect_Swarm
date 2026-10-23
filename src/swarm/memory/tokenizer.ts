import type { SparseVector } from './types.ts';
import { djb2Index } from '../utils/hash.ts';

/**
 * Tokenizes text into sparse term frequency vector for BM25-style lexical search.
 */
export class SparseTokenizer {
    static encode(text: string, vocabSize: number = 10000): SparseVector {
        const tokens = text.toLowerCase().match(/[+-]?\d+(?:\.\d+)?|[a-z0-9_\/]+/gi) || [];
        const termFreqs: Record<number, number> = {};

        for (const token of tokens) {
            const index = djb2Index(token, vocabSize);
            termFreqs[index] = (termFreqs[index] || 0) + 1;
        }

        const indices = Object.keys(termFreqs).map(Number).sort((a, b) => a - b);
        const values = indices.map(i => termFreqs[i]);

        return { indices, values };
    }
}
