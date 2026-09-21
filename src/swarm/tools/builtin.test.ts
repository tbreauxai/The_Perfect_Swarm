import { describe, it, expect } from 'vitest';
import { computeLevenshteinDistance } from './builtin.ts';

describe('computeLevenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
        expect(computeLevenshteinDistance('', '')).toBe(0);
        expect(computeLevenshteinDistance('hello', 'hello')).toBe(0);
    });

    it('should return the length of the other string if one is empty', () => {
        expect(computeLevenshteinDistance('', 'hello')).toBe(5);
        expect(computeLevenshteinDistance('world', '')).toBe(5);
    });

    it('should correctly calculate distance for substitutions', () => {
        expect(computeLevenshteinDistance('kitten', 'sitten')).toBe(1); // k -> s
        expect(computeLevenshteinDistance('cat', 'bat')).toBe(1); // c -> b
        expect(computeLevenshteinDistance('dog', 'dot')).toBe(1); // g -> t
    });

    it('should correctly calculate distance for insertions and deletions', () => {
        expect(computeLevenshteinDistance('flaw', 'lawn')).toBe(2); // delete f, insert n
        expect(computeLevenshteinDistance('gumbo', 'gambol')).toBe(2); // u -> a, insert l
        expect(computeLevenshteinDistance('book', 'back')).toBe(2); // o -> a, o -> c
    });

    it('should correctly calculate distance for the classic kitten -> sitting example', () => {
        expect(computeLevenshteinDistance('kitten', 'sitting')).toBe(3); // k -> s, e -> i, insert g
    });

    it('should correctly handle different lengths and completely different strings', () => {
        expect(computeLevenshteinDistance('abc', 'defg')).toBe(4);
        expect(computeLevenshteinDistance('javascript', 'typescript')).toBe(4); // java -> type
    });

    it('should correctly handle case sensitivity', () => {
        expect(computeLevenshteinDistance('Hello', 'hello')).toBe(1); // H -> h
    });
});
