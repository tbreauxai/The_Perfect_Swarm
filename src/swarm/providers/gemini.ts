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
        const response = await client.models.generateContent({
            model: options.modelName,
            contents: options.prompt,
            config: reqConfig
        });

        const rawText = response.text || '';
        return sanitizeModelOutput(rawText, isJson);
    }
}
