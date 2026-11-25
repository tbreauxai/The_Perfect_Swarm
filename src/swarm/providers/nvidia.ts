import { cleanToken, buildStandardMessages, isKnownReasoningModel, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { executeOpenAiCompatibleChat } from './baseOpenAi.ts';

export class NvidiaAdapter implements ProviderAdapter {
    readonly providerName = 'nvidia';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) throw new Error('Missing NVIDIA API Key.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';
        const isReasoning = isKnownReasoningModel(options.modelName) || /nemotron.*ultra/i.test(options.modelName || '');
        const isQuantOrUltra =
            /quant|\ba1\b/i.test(String(options.role || '')) ||
            /nemotron.*ultra|550b/i.test(options.modelName || '');
        const requestedTimeout = options.timeoutMs || options.config?.timeoutMs || (isQuantOrUltra ? 30000 : 25000);
        const timeoutMs = isQuantOrUltra ? Math.min(requestedTimeout, 30000) : requestedTimeout;
        const requestedMaxTokens = options.config?.maxTokens || (isQuantOrUltra ? 1800 : 2048);
        const maxTokens = isQuantOrUltra ? Math.min(requestedMaxTokens, 1800) : requestedMaxTokens;

        return executeOpenAiCompatibleChat(options, {
            providerName: this.providerName,
            providerLabel: 'NVIDIA',
            endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
            apiKey: key,
            modelName: options.modelName,
            messages,
            maxTokens,
            temperature: 0.2,
            isJson,
            timeoutMs,
            extraBody: isReasoning ? { reasoning_effort: isJson ? 'none' : 'low' } : undefined,
            retryOnTimeout: !isQuantOrUltra,
            format429Error: (_status, errorText) => `[RATE_LIMIT_429] NVIDIA rate limit: ${errorText}`,
            format500Error: (status, errorText) => `[SERVER_ERROR_${status}] NVIDIA: ${errorText}`
        });
    }
}
