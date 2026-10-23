import { cleanToken, buildStandardMessages, isKnownReasoningModel, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { executeOpenAiCompatibleChat } from './baseOpenAi.ts';

export class NvidiaAdapter implements ProviderAdapter {
    readonly providerName = 'nvidia';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) throw new Error('Missing NVIDIA API Key.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json' && !isKnownReasoningModel(options.modelName);
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 25000;

        return executeOpenAiCompatibleChat(options, {
            providerName: this.providerName,
            providerLabel: 'NVIDIA',
            endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
            apiKey: key,
            modelName: options.modelName,
            messages,
            maxTokens: options.config?.maxTokens || 2048,
            temperature: 0.2,
            isJson,
            timeoutMs,
            retryOnTimeout: true,
            format429Error: (_status, errorText) => `[RATE_LIMIT_429] NVIDIA rate limit: ${errorText}`,
            format500Error: (status, errorText) => `[SERVER_ERROR_${status}] NVIDIA: ${errorText}`
        });
    }
}
