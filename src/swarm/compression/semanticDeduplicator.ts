import type { PromptSegment } from './types.ts';
import { TokenEstimator } from './tokenEstimator.ts';

/**
 * Semantic Deduplicator.
 * Computes combined Jaccard word-overlap, Cosine term-frequency, and containment similarities,
 * identifies semantic duplicates across multi-agent outputs, and merges redundant segments.
 */
export class SemanticDeduplicator {
    private static STOP_WORDS = new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
        'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
        'to', 'was', 'were', 'will', 'with', 'this', 'but', 'they',
        'have', 'had', 'been', 'which', 'or', 'so', 'during', 'under',
        'over', 'through', 'into', 'about', 'above', 'below', 'after',
        'before', 'between', 'we', 'our', 'us', 'i', 'my'
    ]);

    /**
     * Lightweight English suffix stemmer for robust semantic keyword matching with zero external dependencies.
     */
    static stemWord(word: string): string {
        if (word.length <= 3) return word;
        if (word.endsWith('sses')) return word.slice(0, -2);
        if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
        if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
        if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
        if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
        return word;
    }

    /**
     * Tokenizes a text into lowercase word stems, filtering common noise while retaining technical terms and numbers.
     */
    static tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^\w\s-]/g, ' ')
            .split(/\s+/)
            .filter(w => (w.length > 1 || /\d/.test(w)) && !this.STOP_WORDS.has(w))
            .map(w => this.stemWord(w));
    }

    /**
     * Computes word frequency distribution map.
     */
    static getTermFrequencies(tokens: string[]): Map<string, number> {
        const tf = new Map<string, number>();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        return tf;
    }

    /**
     * Computes Jaccard similarity between two texts based on unique word sets.
     * Jaccard = |A ∩ B| / |A ∪ B|
     */
    static computeJaccardSimilarity(textA: string, textB: string): number {
        const tokensA = new Set(this.tokenize(textA));
        const tokensB = new Set(this.tokenize(textB));

        if (tokensA.size === 0 || tokensB.size === 0) return 0;

        let intersection = 0;
        for (const token of tokensA) {
            if (tokensB.has(token)) intersection++;
        }

        const union = tokensA.size + tokensB.size - intersection;
        return union > 0 ? intersection / union : 0;
    }

    /**
     * Computes Cosine similarity between two texts over term-frequency vectors.
     * Cosine = (A · B) / (||A|| * ||B||)
     */
    static computeCosineSimilarity(textA: string, textB: string): number {
        const tokensA = this.tokenize(textA);
        const tokensB = this.tokenize(textB);

        if (tokensA.length === 0 || tokensB.length === 0) return 0;

        const tfA = this.getTermFrequencies(tokensA);
        const tfB = this.getTermFrequencies(tokensB);

        let dotProduct = 0;
        let magA = 0;
        let magB = 0;

        for (const [token, countA] of tfA.entries()) {
            magA += countA * countA;
            const countB = tfB.get(token) || 0;
            dotProduct += countA * countB;
        }

        for (const countB of tfB.values()) {
            magB += countB * countB;
        }

        if (magA === 0 || magB === 0) return 0;
        return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
    }

    /**
     * Computes combined semantic similarity score (0.0 to 1.0).
     * Blends Jaccard, Cosine, and Overlap/Containment coefficient.
     */
    static computeSemanticSimilarity(textA: string, textB: string): number {
        if (!textA || !textB) return 0;
        const normA = textA.trim().toLowerCase();
        const normB = textB.trim().toLowerCase();
        if (normA === normB) return 1.0;

        const tokensA = this.tokenize(textA);
        const tokensB = this.tokenize(textB);
        if (tokensA.length === 0 || tokensB.length === 0) return 0;

        const setA = new Set(tokensA);
        const setB = new Set(tokensB);

        let intersection = 0;
        for (const token of setA) {
            if (setB.has(token)) intersection++;
        }

        const union = setA.size + setB.size - intersection;
        const jaccard = union > 0 ? intersection / union : 0;
        const cosine = this.computeCosineSimilarity(textA, textB);

        const minLen = Math.min(setA.size, setB.size);
        const overlap = minLen > 0 ? intersection / minLen : 0;

        const blended = (jaccard * 0.3) + (cosine * 0.4) + (overlap * 0.3);
        return Math.min(1.0, Math.round(blended * 1000) / 1000);
    }

    /**
     * Deduplicates an array of prompt segments.
     * Redundant segments above the similarity threshold are flagged, and their sources
     * are merged into the representative segment.
     */
    static deduplicateSegments(
        segments: PromptSegment[],
        threshold: number = 0.75,
        minLen: number = 15
    ): PromptSegment[] {
        const result: PromptSegment[] = [];

        for (let i = 0; i < segments.length; i++) {
            const current = { ...segments[i], sources: [...segments[i].sources] };

            // Headers, code blocks, and critical schema directives bypass deduplication
            if (current.isCodeBlock || current.isHeader || current.priority === 'critical') {
                result.push(current);
                continue;
            }

            if (current.text.length < minLen) {
                result.push(current);
                continue;
            }

            // Check against already accepted non-code segments
            let isDuplicate = false;
            for (const existing of result) {
                if (existing.isCodeBlock || existing.isHeader || existing.priority === 'critical') continue;

                const sim = this.computeSemanticSimilarity(current.text, existing.text);
                if (sim >= threshold) {
                    isDuplicate = true;
                    current.isDeduplicated = true;
                    current.deduplicatedWith = existing.id;
                    current.similarityScore = Math.round(sim * 100) / 100;

                    for (const s of current.sources) {
                        if (!existing.sources.includes(s)) {
                            existing.sources.push(s);
                        }
                    }

                    // Preserve anomaly flag on the retained segment
                    if (current.hasAnomaly) {
                        existing.hasAnomaly = true;
                    }

                    // Keep the richer segment with more numbers/details
                    const numbersInCurrent = current.text.match(/\b\d+(\.\d+)?%?\b/g) || [];
                    const numbersInExisting = existing.text.match(/\b\d+(\.\d+)?%?\b/g) || [];
                    if (numbersInCurrent.length > numbersInExisting.length || current.text.length > existing.text.length * 1.2) {
                        existing.text = current.text;
                        existing.tokenCount = TokenEstimator.countTokens(existing.text);
                    }
                    break;
                }
            }

            result.push(current);
        }

        return result;
    }
}
