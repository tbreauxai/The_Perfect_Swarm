import { cleanToken, buildStandardMessages, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { executeOpenAiCompatibleChat } from './baseOpenAi.ts';

export function resetMistralMutex(): void {}

export class MistralAdapter implements ProviderAdapter {
    readonly providerName = 'mistral';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Mistral API Key.');
        }

        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;
        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';

        return executeOpenAiCompatibleChat(options, {
            providerName: this.providerName,
            providerLabel: 'Mistral',
            endpoint: 'https://api.mistral.ai/v1/chat/completions',
            apiKey: key,
            modelName: options.modelName,
            messages,
            maxTokens: options.config?.maxTokens || 8192,
            isJson,
            timeoutMs,
            format429Error: (_status, errorText, retryAfter) => {
                const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
                let detail = errorText;
                try {
                    const parsed = JSON.parse(errorText);
                    if (parsed.code === 1300 || parsed.code) {
                        return `[RATE_LIMIT_429] Mistral API rate limit exceeded (Code 1300): ${parsed.message || errorText}${retrySuffix}`;
                    } else if (parsed.message) {
                        detail = parsed.message;
                    }
                } catch (e) {
                    if (e && typeof e === 'object' && e.message && e.message.startsWith('[RATE_LIMIT_429]')) {
                        throw e;
                    }
                }
                return `[RATE_LIMIT_429] Mistral API rate limit exceeded: ${detail}${retrySuffix}`;
            },
            format500Error: (status, errorText) => `[SERVER_ERROR_${status}] Mistral server error: ${errorText}`
        });
    }
}
