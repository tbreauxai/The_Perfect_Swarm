import { GoogleGenAI } from '@google/genai';
import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { globalTelemetryCollector, estimateTokens } from '../telemetry.ts';
import { parseRetryAfterMs } from '../utils/httpTimeouts.ts';

export class GeminiAdapter implements ProviderAdapter {
    readonly providerName = 'gemini';

    async call(options: ProviderCallOptions): Promise<string> {
        let client = options.aiClient;
        const key = cleanToken(options.apiKey);

        if (!client && key) {
            client = new GoogleGenAI({
                apiKey: key,
                httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
            });
        }

        if (!client) {
            throw new Error('Gemini API client could not be initialized. Please configure a valid Gemini API key.');
        }

        const reqConfig: any = { ...options.config };
        delete reqConfig.maxTokens;
        delete reqConfig.maxTokensCap;
        delete reqConfig.groqMode;
        delete reqConfig.timeoutMs;
        reqConfig.maxOutputTokens = options.role === 'catalog-probe'
            ? Math.max(options.config?.maxTokens || 256, 256)
            : (options.config?.maxTokens || 8192);
        if (options.systemInstruction) {
            reqConfig.systemInstruction = options.systemInstruction;
        }

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes

        const executeGeneration = async (cfg: any): Promise<any> => {
            let timeoutId: any;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`[TIMEOUT] Gemini request timed out after ${timeoutMs}ms.`));
                }, timeoutMs);
            });
            try {
                return await Promise.race([
                    client.models.generateContent({
                        model: options.modelName,
                        contents: options.prompt,
                        config: cfg
                    }),
                    timeoutPromise
                ]);
            } finally {
                clearTimeout(timeoutId);
            }
        };

        let response: any;
        const startTime = Date.now();
        let activeConfig = { ...reqConfig };
        try {
            try {
                response = await executeGeneration(activeConfig);
            } catch (firstErr: any) {
                const errStr = String(firstErr?.message || firstErr || '');
                const isFormatRejection = isJson && (
                    firstErr?.status === 400 ||
                    errStr.includes('400') ||
                    errStr.includes('INVALID_ARGUMENT') ||
                    errStr.toLowerCase().includes('responsemimetype') ||
                    errStr.toLowerCase().includes('format') ||
                    errStr.toLowerCase().includes('schema') ||
                    errStr.toLowerCase().includes('json')
                );
                if (isFormatRejection) {
                    console.warn(`[Gemini] Model '${options.modelName}' rejected responseMimeType (${errStr}); retrying without format flag.`);
                    const fallbackConfig = { ...activeConfig };
                    delete fallbackConfig.responseMimeType;
                    delete fallbackConfig.responseSchema;
                    response = await executeGeneration(fallbackConfig);
                } else {
                    throw firstErr;
                }
            }
        } catch (error: any) {
            const errStr = String(error?.message || error || '');
            if (
                error?.status === 429 ||
                errStr.includes('429') ||
                errStr.includes('RESOURCE_EXHAUSTED') ||
                errStr.includes('quota')
            ) {
                const retryMs = parseRetryAfterMs(error, 0, 100, 30000);
                if (retryMs > 0 && retryMs <= 8000) {
                    const jitterMs = Math.floor(Math.random() * 600) + 200;
                    await new Promise(r => setTimeout(r, retryMs + jitterMs));
                    try {
                        response = await executeGeneration(activeConfig);
                    } catch (retryErr: any) {
                        const retryErrStr = String(retryErr?.message || retryErr || '');
                        throw new Error(`[RATE_LIMIT_429] Gemini quota/rate limit exceeded: ${retryErrStr}`);
                    }
                } else if (!errStr.startsWith('[RATE_LIMIT_429]')) {
                    throw new Error(`[RATE_LIMIT_429] Gemini quota/rate limit exceeded: ${errStr}`);
                }
            } else {
                throw error;
            }
        }

        const durationMs = Date.now() - startTime;
        globalTelemetryCollector.recordModelLatency(durationMs);

        const rawText = response.text || '';

        // Record token usage
        if (response.usageMetadata) {
            globalTelemetryCollector.recordTokenUsage({
                promptTokens: response.usageMetadata.promptTokenCount || 0,
                completionTokens: response.usageMetadata.candidatesTokenCount || 0,
                provider: this.providerName,
                model: options.modelName
            });
        } else {
            const promptTokens = estimateTokens(options.prompt + (options.systemInstruction || ''));
            const completionTokens = estimateTokens(rawText);
            globalTelemetryCollector.recordTokenUsage({
                promptTokens,
                completionTokens,
                provider: this.providerName,
                model: options.modelName
            });
        }

        return sanitizeModelOutput(rawText, isJson);
    }
}
