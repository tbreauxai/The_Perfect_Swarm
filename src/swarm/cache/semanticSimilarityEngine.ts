/**
 * High-performance, zero-dependency lexical-semantic similarity engine.
 * Combines token set Jaccard matching with character trigram Dice coefficient.
 */
export class SemanticSimilarityEngine {
    private static STOP_WORDS = new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
        'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
        'to', 'was', 'were', 'will', 'with', 'this', 'but', 'they',
        'have', 'had', 'what', 'when', 'where', 'who', 'which', 'why', 'how'
    ]);

    static normalizeText(text: string): string {
        return (text || '')
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    static tokenize(text: string): string[] {
        const normalized = this.normalizeText(text);
        if (!normalized) return [];
        return normalized
            .split(' ')
            .filter(w => w.length > 1 && !this.STOP_WORDS.has(w));
    }

    static extractTrigrams(text: string): Set<string> {
        const normalized = this.normalizeText(text);
        const trigrams = new Set<string>();
        if (normalized.length < 3) {
            if (normalized.length > 0) trigrams.add(normalized);
            return trigrams;
        }
        for (let i = 0; i <= normalized.length - 3; i++) {
            trigrams.add(normalized.substring(i, i + 3));
        }
        return trigrams;
    }

    static tokenSimilarity(tokensA: string[], tokensB: string[]): number {
        if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
        if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

        const setB = new Set(tokensB);
        let matchScore = 0;
        const matchedB = new Set<string>();

        for (const tA of tokensA) {
            if (setB.has(tA)) {
                matchScore += 1.0;
                matchedB.add(tA);
            } else {
                for (const tB of tokensB) {
                    if (!matchedB.has(tB)) {
                        let commonPrefixLen = 0;
                        const minLen = Math.min(tA.length, tB.length);
                        while (commonPrefixLen < minLen && tA[commonPrefixLen] === tB[commonPrefixLen]) {
                            commonPrefixLen++;
                        }
                        if (commonPrefixLen >= 4 || (commonPrefixLen >= 3 && (tA.startsWith(tB) || tB.startsWith(tA)))) {
                            matchScore += 0.85;
                            matchedB.add(tB);
                            break;
                        }
                        if (tA.length >= 4 && tB.length >= 4 && (tA.includes(tB) || tB.includes(tA))) {
                            matchScore += 0.75;
                            matchedB.add(tB);
                            break;
                        }
                    }
                }
            }
        }

        const totalTokens = Math.max(tokensA.length, tokensB.length);
        return totalTokens === 0 ? 0 : Math.min(1.0, matchScore / totalTokens);
    }

    static trigramDice(trigramsA: Set<string>, trigramsB: Set<string>): number {
        if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0;
        if (trigramsA.size === 0 || trigramsB.size === 0) return 0.0;

        let intersection = 0;
        for (const tri of trigramsA) {
            if (trigramsB.has(tri)) intersection++;
        }

        return (2 * intersection) / (trigramsA.size + trigramsB.size);
    }

    static computeSimilarity(
        taskA: string,
        taskB: string,
        precomputed?: {
            tokensA?: string[];
            trigramsA?: Set<string>;
            tokensB?: string[];
            trigramsB?: Set<string>;
        }
    ): number {
        const tokensA = precomputed?.tokensA ?? this.tokenize(taskA);
        const trigramsA = precomputed?.trigramsA ?? this.extractTrigrams(taskA);

        const tokensB = precomputed?.tokensB ?? this.tokenize(taskB);
        const trigramsB = precomputed?.trigramsB ?? this.extractTrigrams(taskB);

        const tokenSim = this.tokenSimilarity(tokensA, tokensB);
        const dice = this.trigramDice(trigramsA, trigramsB);

        const score = (tokenSim * 0.60) + (dice * 0.40);
        return Math.round(score * 1000) / 1000;
    }

    /**
     * Generates a deterministic normalized dense vector representation of text for O(log n) indexing.
     */
    static computeVector(text: string, dimension: number = 128): number[] {
        const vector = new Array(dimension).fill(0);
        const tokens = this.tokenize(text);
        if (tokens.length === 0) return vector;

        for (const token of tokens) {
            let hash = 5381;
            for (let i = 0; i < token.length; i++) {
                hash = ((hash << 5) + hash) + token.charCodeAt(i);
                hash |= 0;
            }
            const index = Math.abs(hash) % dimension;
            vector[index] += 1;
        }

        let sumSq = 0;
        for (let i = 0; i < dimension; i++) sumSq += vector[i] * vector[i];
        const norm = Math.sqrt(sumSq) || 1;
        for (let i = 0; i < dimension; i++) vector[i] /= norm;

        return vector;
    }
}
