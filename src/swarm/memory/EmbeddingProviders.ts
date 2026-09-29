import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import { EmbeddingProvider, SparseVector } from "./types.ts";

/**
 * Google AI Gemini dense embedding provider using text-embedding-004.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;
    private aiClient: GoogleGenAI;
    private modelNames: string[];
    private timeoutMs: number;

    constructor(aiClient: GoogleGenAI, modelName: string = 'text-embedding-005', timeoutMs: number = 5000) {
        this.aiClient = aiClient;
        this.modelNames = [modelName, 'text-embedding-005', 'text-embedding-004'];
        this.timeoutMs = timeoutMs;
    }

    async embed(text: string): Promise<number[]> {
        let timeoutId: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => {
                            reject(new Error(`[TIMEOUT] Gemini embedding request timed out after ${this.timeoutMs}ms.`));
                        }, this.timeoutMs);
                    });
        let lastError: any;
        for (const model of this.modelNames) {
            try {
                const response: any = await Promise.race([
                    this.aiClient.models.embedContent({
                        model: model,
                        contents: [text],
                    }),
                    timeoutPromise
                ]);
                return response.embeddings?.[0]?.values || response.embeddings?.[0]?.value || [];
            } catch (err: any) {
                lastError = err;
                const msg = err.message || '';
                // If model not found, try the next one in the fallback list
                if (msg.includes('404') || msg.includes('not found') || msg.includes('not supported')) {
                    continue;
                }
                break;
            }
        }

        clearTimeout(timeoutId);
        throw lastError;
    }
}

/**
 * Deterministic local dense embedding generator (768 dimensions).
 * Enables offline execution, zero-cost operation, and local testing without external API keys.
 */
export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;

    static computeVector(text: string, dimension: number = 768): number[] {
        const vector = new Array(dimension).fill(0);
        const tokens = (text || '').toLowerCase().match(/\b\w+\b/g) || [];
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

    async embed(text: string): Promise<number[]> {
        return DeterministicLocalEmbeddingProvider.computeVector(text, this.dimension);
    }
}
