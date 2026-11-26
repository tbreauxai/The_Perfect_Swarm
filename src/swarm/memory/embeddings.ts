import { GoogleGenAI } from '@google/genai';
import type { EmbeddingProvider } from './types.ts';
import { djb2Index } from '../utils/hash.ts';

const RETIRED_EMBEDDING_MODELS = new Set([
    'text-embedding-004',
    'text-embedding-005',
    'embedding-001',
    'models/text-embedding-004',
    'models/text-embedding-005',
    'models/embedding-001'
]);

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';

export function resolveGeminiEmbeddingModel(modelName?: string): string {
    const trimmed = typeof modelName === 'string' ? modelName.replace(/^models\//i, '').trim() : '';
    if (!trimmed || RETIRED_EMBEDDING_MODELS.has(trimmed.toLowerCase())) {
        return DEFAULT_GEMINI_EMBEDDING_MODEL;
    }
    return trimmed;
}

/**
 * Google AI Gemini dense embedding provider using gemini-embedding-2 / gemini-embedding-001 (768-dim).
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly dimension = 768;
    private static unsupportedModels = new Set<string>();
    private aiClient: GoogleGenAI;
    private modelNames: string[];
    private timeoutMs: number;
    private lastSuccessfulModel: string | null = null;
    private lastErrorMessage: string | null = null;

    constructor(
        aiClient: GoogleGenAI,
        modelName: string = DEFAULT_GEMINI_EMBEDDING_MODEL,
        timeoutMs: number = 5000
    ) {
        this.aiClient = aiClient;
        const normalizedPrimary = resolveGeminiEmbeddingModel(modelName);
        this.modelNames = Array.from(new Set([
            normalizedPrimary,
            DEFAULT_GEMINI_EMBEDDING_MODEL,
            'gemini-embedding-001'
        ]));
        this.timeoutMs = timeoutMs;
    }

    getActiveModel(): string {
        return this.lastSuccessfulModel || this.modelNames[0] || DEFAULT_GEMINI_EMBEDDING_MODEL;
    }

    getLastError(): string | null {
        return this.lastErrorMessage;
    }

    static resetUnsupportedModels(): void {
        GeminiEmbeddingProvider.unsupportedModels.clear();
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

    async embed(text: string, taskType?: string): Promise<number[]> {
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
                    const isEmbedding2 = /^gemini-embedding-2/i.test(model);
                    const reqConfig: Record<string, any> = {
                        outputDimensionality: this.dimension
                    };
                    // taskType is unsupported on gemini-embedding-2; only pass for gemini-embedding-001 if requested
                    if (!isEmbedding2 && taskType && model === 'gemini-embedding-001') {
                        reqConfig.taskType = taskType;
                    }
                    const response: any = await Promise.race([
                        this.aiClient.models.embedContent({
                            model,
                            contents: [text],
                            config: reqConfig
                        }),
                        timeoutPromise
                    ]);
                    const rawValues = response.embeddings?.[0]?.values || response.embeddings?.[0]?.value || [];
                    if (Array.isArray(rawValues) && rawValues.length > 0) {
                        this.lastSuccessfulModel = model;
                        this.lastErrorMessage = null;
                        return this.normalizeDimension(rawValues);
                    }
                } catch (err: any) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    this.lastErrorMessage = msg;
                    if (
                        msg.includes('404') ||
                        msg.includes('503') ||
                        msg.includes('not found') ||
                        msg.includes('NOT_FOUND') ||
                        msg.includes('not supported')
                    ) {
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
