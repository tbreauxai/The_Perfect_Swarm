import { describe, it, expect } from 'vitest';
import { SparseTokenizer } from './tokenizer.ts';
import { DeterministicLocalEmbeddingProvider } from './embeddings.ts';
import { SemanticSimilarityEngine } from '../cache/semanticSimilarityEngine.ts';

describe('Betting symbols in Tokenizer, Embeddings, and Semantic Similarity', () => {
    it('preserves signed spreads, moneyline odds, and betting abbreviations in SparseTokenizer', () => {
        const text = 'Chiefs -3.5 vs Ravens +3.5 O/U 47.5 ATS ML PK -110';
        const encoded = SparseTokenizer.encode(text);
        expect(encoded.indices.length).toBeGreaterThan(0);
        expect(encoded.values.length).toBe(encoded.indices.length);

        // Verify distinct tokens produce distinct sparse hashes
        const plusVector = SparseTokenizer.encode('+3.5');
        const minusVector = SparseTokenizer.encode('-3.5');
        expect(plusVector.indices).not.toEqual(minusVector.indices);
    });

    it('differentiates opposite signed lines in DeterministicLocalEmbeddingProvider', () => {
        const vPlus = DeterministicLocalEmbeddingProvider.computeVector('Chiefs +3.5');
        const vMinus = DeterministicLocalEmbeddingProvider.computeVector('Chiefs -3.5');
        expect(vPlus).not.toEqual(vMinus);
    });

    it('preserves +, -, / operators in SemanticSimilarityEngine.normalizeText and tokenize', () => {
        const normalized = SemanticSimilarityEngine.normalizeText('Chiefs +3.5 at Ravens -3.5 O/U 48.5 -110');
        expect(normalized).toContain('+3.5');
        expect(normalized).toContain('-3.5');
        expect(normalized).toContain('o/u');
        expect(normalized).toContain('-110');

        const tokens = SemanticSimilarityEngine.tokenize('Chiefs +3.5 at Ravens -3.5 O/U 48.5 -110');
        expect(tokens).toContain('+3.5');
        expect(tokens).toContain('-3.5');
        expect(tokens).toContain('o/u');
        expect(tokens).toContain('-110');
    });
});
