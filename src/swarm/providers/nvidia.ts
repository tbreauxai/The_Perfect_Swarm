import { cleanToken, buildStandardMessages, isKnownReasoningModel, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { executeOpenAiCompatibleChat } from './baseOpenAi.ts';

export class NvidiaAdapter implements ProviderAdapter {
    readonly providerName = 'nvidia';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) throw new Error('Missing NVIDIA API Key.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';
        const isReasoning =
            isKnownReasoningModel(options.modelName) ||
            /nemotron|deepseek-r1|qwq/i.test(options.modelName || '');
        const isQuantOrUltra =
            /quant|\ba1\b/i.test(String(options.role || '')) ||
            /nemotron.*ultra|550b/i.test(options.modelName || '');
        const requestedTimeout = options.timeoutMs || options.config?.timeoutMs || (isQuantOrUltra ? 30000 : 25000);
        const timeoutMs = isQuantOrUltra ? Math.min(requestedTimeout, 30000) : requestedTimeout;
        const requestedMaxTokens = options.config?.maxTokens || (isReasoning ? 4096 : 2048);
        // S2: Never cap NVIDIA reasoning models below 4096 tokens so thinking streams cannot truncate JSON output
        const maxTokens = isReasoning
            ? Math.max(requestedMaxTokens, 4096)
            : (isQuantOrUltra ? Math.min(requestedMaxTokens, 1800) : requestedMaxTokens);

        const extraBody = isReasoning
            ? {
                reasoning_effort: isJson ? 'none' : 'low',
                ...(isJson ? { chat_template_kwargs: { enable_thinking: false } } : {})
            }
            : undefined;

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
            extraBody,
            retryOnTimeout: !isQuantOrUltra,
            format429Error: (_status, errorText) => `[RATE_LIMIT_429] NVIDIA rate limit: ${errorText}`,
            format500Error: (status, errorText) => `[SERVER_ERROR_${status}] NVIDIA: ${errorText}`
        });
    }
}
