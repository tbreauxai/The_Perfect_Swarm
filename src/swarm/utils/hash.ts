/**
 * Deterministic DJB2 string hashing utilities.
 * Used across tokenizers, embeddings, experiments, and semantic cache engines.
 */

/**
 * Fast deterministic DJB2 string hashing algorithm.
 * Returns a signed 32-bit integer hash for a given string.
 */
export function djb2Hash(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

/**
 * Returns a non-negative modulo index into an array or hash ring of the specified `size`.
 */
export function djb2Index(str: string, size: number): number {
    if (size <= 0) return 0;
    return Math.abs(djb2Hash(str)) % size;
}
