import { GoogleGenAI } from '@google/genai';
import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { globalTelemetryCollector, estimateTokens } from '../telemetry.ts';

export class GeminiAdapter implements ProviderAdapter {
    readonly providerName = 'gemini';

    async call(options: ProviderCallOptions): Promise<string> {
        let client = options.aiClient;
        const key = cleanToken(options.apiKey);

        if (!client && key) {
            client = new GoogleGenAI({
                apiKey: key
            });
        }

        if (!client) {
            throw new Error('Gemini API client could not be initialized. Please configure a valid Gemini API key.');
        }

        const reqConfig: any = { ...options.config };
        if (options.systemInstruction) {
            reqConfig.systemInstruction = options.systemInstruction;
        }

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 120000;

        let timeoutId: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`[TIMEOUT] Gemini request timed out after ${timeoutMs}ms.`));
            }, timeoutMs);
        });

        let response: any;
        try {
            response = await Promise.race([
                client.models.generateContent({
                    model: options.modelName,
                    contents: options.prompt,
                    config: reqConfig
                }),
                timeoutPromise
            ]);
        } catch (error: any) {
            console.error(`[GEMINI ERROR] ${new Date().toISOString()}\nModel: ${options.modelName}\nError: ${JSON.stringify(error, null, 2)}\nFull Error Object: ${error}`);
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

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
