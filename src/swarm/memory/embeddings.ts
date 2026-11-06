import { GoogleGenAI } from '@google/genai';
import type { EmbeddingProvider } from './types.ts';
import { djb2Index } from '../utils/hash.ts';

const RETIRED_EMBEDDING_MODELS = new Set(['text-embedding-004', 'text-embedding-005', 'models/text-embedding-004', 'models/text-embedding-005']);

/**
 * Google AI Gemini dense embedding provider using gemini-embedding-2-preview / gemini-embedding-001 (768-dim).
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;
    private static unsupportedModels = new Set<string>();
    private aiClient: GoogleGenAI;
    private modelNames: string[];
    private timeoutMs: number;

    constructor(
        aiClient: GoogleGenAI,
        modelName: string = 'gemini-embedding-2-preview',
        timeoutMs: number = 5000
    ) {
        this.aiClient = aiClient;
        const normalizedPrimary = RETIRED_EMBEDDING_MODELS.has(modelName)
            ? 'gemini-embedding-2-preview'
            : modelName;
        this.modelNames = Array.from(new Set([
            normalizedPrimary,
            'gemini-embedding-2-preview',
            'gemini-embedding-001'
        ]));
        this.timeoutMs = timeoutMs;
    }

    private normalizeDimension(values: number[]): number[] {
        if (values.length === 0) return values;
        const out = values.length === this.dimension
            ? values.slice()
            : values.slice(0, this.dimension);
        while (out.length < this.dimension) out.push(0);
        let sumSq = 0;
        for (let i = 0; i < out.length; i++) sumSq += out[i] * out[i];
        const norm = Math.sqrt(sumSq) || 1;
        for (let i = 0; i < out.length; i++) out[i] /= norm;
        return out;
    }

    async embed(text: string): Promise<number[]> {
        let timeoutId: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`[TIMEOUT] Gemini embedding request timed out after ${this.timeoutMs}ms.`));
            }, this.timeoutMs);
        });

        let lastError: any;
        try {
            const candidates = this.modelNames.filter(m => !GeminiEmbeddingProvider.unsupportedModels.has(m));
            const modelsToTry = candidates.length > 0 ? candidates : this.modelNames;

            for (const model of modelsToTry) {
                try {
                    const response: any = await Promise.race([
                        this.aiClient.models.embedContent({
                            model,
                            contents: [text],
                            config: { outputDimensionality: this.dimension }
                        }),
                        timeoutPromise
                    ]);
                    const rawValues = response.embeddings?.[0]?.values || response.embeddings?.[0]?.value || [];
                    if (Array.isArray(rawValues) && rawValues.length > 0) {
                        return this.normalizeDimension(rawValues);
                    }
                } catch (err: any) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    if (msg.includes('404') || msg.includes('not found') || msg.includes('NOT_FOUND') || msg.includes('not supported')) {
                        GeminiEmbeddingProvider.unsupportedModels.add(model);
                        continue;
                    }
                    break;
                }
            }
            throw lastError || new Error('Gemini embedding failed across all candidate models.');
        } finally {
            clearTimeout(timeoutId);
        }
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
        const tokens = (text || '').toLowerCase().match(/[+-]?\d+(?:\.\d+)?|[a-z0-9_\/]+/gi) || [];
        if (tokens.length === 0) return vector;

        for (const token of tokens) {
            const index = djb2Index(token, dimension);
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
