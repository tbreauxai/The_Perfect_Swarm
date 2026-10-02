import type { SQ8Vector, BinaryVector } from './types.ts';

/**
 * High-performance vector quantizer reducing embedding footprints by 4x to 32x.
 */
export class VectorQuantizer {
    /**
     * Generates a deterministic unit-normalized float embedding vector from text.
     * Uses deterministic rolling hash n-grams with L2 normalization.
     */
    static generateEmbedding(text: string, dimension: number = 64): Float32Array {
        const vec = new Float32Array(dimension);
        const raw = typeof text === 'string' ? text : (text ? JSON.stringify(text) : '');
        const normalized = raw.toLowerCase().trim();
        if (!normalized) return vec;

        const words = normalized.split(/\s+/);
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            let h = 0x811c9dc5;
            for (let j = 0; j < word.length; j++) {
                h ^= word.charCodeAt(j);
                h = Math.imul(h, 0x01000193);
            }
            vec[Math.abs(h) % dimension] += 2.0;

            // Character n-grams (3-char and 4-char shingles)
            for (let n = 3; n <= 4; n++) {
                if (word.length >= n) {
                    for (let k = 0; k <= word.length - n; k++) {
                        const shingle = word.slice(k, k + n);
                        let hs = 0x811c9dc5;
                        for (let c = 0; c < shingle.length; c++) {
                            hs ^= shingle.charCodeAt(c);
                            hs = Math.imul(hs, 0x01000193);
                        }
                        vec[Math.abs(hs) % dimension] += 1.0;
                    }
                }
            }

            // Word bigram hashing
            if (i < words.length - 1) {
                const bi = word + '_' + words[i + 1];
                let h2 = 0x811c9dc5;
                for (let k = 0; k < bi.length; k++) {
                    h2 ^= bi.charCodeAt(k);
                    h2 = Math.imul(h2, 0x01000193);
                }
                vec[Math.abs(h2) % dimension] += 1.5;
            }
        }

        // Mean-centering for balanced zero-mean distribution
        let mean = 0;
        for (let i = 0; i < dimension; i++) {
            mean += vec[i];
        }
        mean /= dimension;
        for (let i = 0; i < dimension; i++) {
            vec[i] -= mean;
        }

        // L2 Unit Normalization
        let sumSq = 0;
        for (let i = 0; i < dimension; i++) {
            sumSq += vec[i] * vec[i];
        }
        if (sumSq > 0) {
            const norm = Math.sqrt(sumSq);
            for (let i = 0; i < dimension; i++) {
                vec[i] /= norm;
            }
        }

        return vec;
    }

    /**
     * Scalar Quantization (SQ8): Quantizes Float32Array (4 bytes/dim) into Uint8Array (1 byte/dim).
     * 75% memory footprint reduction (4x compression).
     */
    static quantizeSQ8(vector: Float32Array | number[]): SQ8Vector {
        const dim = vector.length;
        if (dim === 0) {
            return {
                codes: new Uint8Array(0),
                min: 0,
                max: 0,
                dimension: 0,
                originalByteSize: 0,
                quantizedByteSize: 0,
                compressionRatio: 1.0
            };
        }

        let min = vector[0];
        let max = vector[0];
        for (let i = 1; i < dim; i++) {
            if (vector[i] < min) min = vector[i];
            if (vector[i] > max) max = vector[i];
        }

        const codes = new Uint8Array(dim);
        const range = max - min;

        if (range === 0) {
            codes.fill(128);
        } else {
            const invRange = 255 / range;
            for (let i = 0; i < dim; i++) {
                const val = Math.round((vector[i] - min) * invRange);
                codes[i] = Math.max(0, Math.min(255, val));
            }
        }

        const originalByteSize = dim * 4;
        const quantizedByteSize = dim + 8; // Uint8Array + 2x float32 bounds
        const compressionRatio = originalByteSize / quantizedByteSize;

        return {
            codes,
            min,
            max,
            dimension: dim,
            originalByteSize,
            quantizedByteSize,
            compressionRatio: Math.round(compressionRatio * 100) / 100
        };
    }

    /**
     * Dequantizes SQ8 codes back to Float32Array.
     */
    static dequantizeSQ8(sq8: SQ8Vector): Float32Array {
        const result = new Float32Array(sq8.dimension);
        const range = sq8.max - sq8.min;
        if (range === 0) {
            result.fill(sq8.min);
            return result;
        }

        const scale = range / 255;
        for (let i = 0; i < sq8.dimension; i++) {
            result[i] = sq8.min + (sq8.codes[i] * scale);
        }
        return result;
    }

    /**
     * Asymmetric Distance Computation (ADC): Computes cosine similarity between an unquantized
     * query vector and a quantized SQ8 vector without creating dequantized array allocations.
     */
    static asymmetricCosineSimilarity(query: Float32Array | number[], target: SQ8Vector): number {
        const dim = target.dimension;
        if (dim === 0 || query.length !== dim) return 0;

        const range = target.max - target.min;
        const scale = range === 0 ? 0 : range / 255;
        const minVal = target.min;

        let dot = 0;
        let queryNormSq = 0;
        let targetNormSq = 0;

        for (let i = 0; i < dim; i++) {
            const q = query[i];
            const t = minVal + (target.codes[i] * scale);
            dot += q * t;
            queryNormSq += q * q;
            targetNormSq += t * t;
        }

        if (queryNormSq === 0 || targetNormSq === 0) return 0;
        const sim = dot / (Math.sqrt(queryNormSq) * Math.sqrt(targetNormSq));
        return Math.max(-1.0, Math.min(1.0, Math.round(sim * 10000) / 10000));
    }

    /**
     * Binary 1-Bit Sign Quantization: Packs vector dimensions into bits (dim >= 0 -> 1, else 0).
     * 32x memory compression for fast Hamming proximity searches.
     */
    static quantizeBinary(vector: Float32Array | number[]): BinaryVector {
        const dim = vector.length;
        const byteLen = Math.ceil(dim / 8);
        const bits = new Uint8Array(byteLen);

        for (let i = 0; i < dim; i++) {
            if (vector[i] >= 0) {
                const byteIdx = i >> 3;
                const bitIdx = i & 7;
                bits[byteIdx] |= (1 << bitIdx);
            }
        }

        const originalByteSize = dim * 4;
        const quantizedByteSize = byteLen;
        const compressionRatio = originalByteSize / quantizedByteSize;

        return {
            bits,
            dimension: dim,
            originalByteSize,
            quantizedByteSize,
            compressionRatio: Math.round(compressionRatio * 100) / 100
        };
    }

    /**
     * Computes bitwise Hamming distance between two binary vectors using Kernighan popcount.
     */
    static hammingDistance(a: BinaryVector, b: BinaryVector): number {
        const len = Math.min(a.bits.length, b.bits.length);
        let dist = 0;
        for (let i = 0; i < len; i++) {
            let xor = a.bits[i] ^ b.bits[i];
            // Count set bits
            while (xor > 0) {
                dist += xor & 1;
                xor >>= 1;
            }
        }
        return dist;
    }

    /**
     * Approximates cosine similarity from Hamming distance:
     * CosineSimilarity ~ cos(pi * (hammingDistance / dimension))
     */
    static binaryCosineSimilarity(a: BinaryVector, b: BinaryVector): number {
        const dim = Math.max(1, Math.min(a.dimension, b.dimension));
        const dist = this.hammingDistance(a, b);
        const sim = Math.cos((Math.PI * dist) / dim);
        return Math.max(-1.0, Math.min(1.0, Math.round(sim * 10000) / 10000));
    }
}
