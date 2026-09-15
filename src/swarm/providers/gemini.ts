import { GoogleGenAI } from '@google/genai';
import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class GeminiAdapter implements ProviderAdapter {
    readonly providerName = 'gemini';

    async call(options: ProviderCallOptions): Promise<string> {
        let client = options.aiClient;
        const key = cleanToken(options.apiKey);

        if (!client && key) {
            client = new GoogleGenAI({
                apiKey: key,
                apiVersion: 'v1alpha',
                httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
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
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 45000;

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
        } finally {
            clearTimeout(timeoutId);
        }

        const rawText = response.text || '';
        return sanitizeModelOutput(rawText, isJson);
    }
}
