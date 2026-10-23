import { cleanToken, buildStandardMessages, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { executeOpenAiCompatibleChat } from './baseOpenAi.ts';

/**
 * Dead OpenRouter ids that callers still send (DuelOdds AI Lab defaults: aiLabUtils.ts:181, useSettingsStore.ts:20,
 * swarmPromptBuilder.ts:817, cloudflareSwarmClient.ts:60) mapped to the live free model. nemotron-3-ultra :free
 * returns 404 (its only endpoint: status -5, 0% uptime; Navigator, Oct 16 2:20 PM CT).
 */
export const RETIRED_OPENROUTER_MODELS: Readonly<Record<string, string>> = {
    'nvidia/nemotron-3-ultra-550b-a55b:free': 'nvidia/nemotron-3-super-120b-a12b:free'
};
const warnedRetired = new Set<string>();

export function resolveOpenRouterModel(modelName: string): string {
    const replacement = RETIRED_OPENROUTER_MODELS[String(modelName || '').trim()];
    if (!replacement) return modelName;
    if (!warnedRetired.has(modelName)) {
        warnedRetired.add(modelName);
        console.warn(`[OpenRouter] Model '${modelName}' is retired (404); using '${replacement}' instead.`);
    }
    return replacement;
}

export class OpenRouterAdapter implements ProviderAdapter {
    readonly providerName = 'openrouter';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing OpenRouter API key. Please configure a valid key starting with "sk-or-v1-".');
        }

        if (!key.startsWith('sk-or-v1-')) {
            throw new Error("Invalid OpenRouter key format. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a key from openrouter.ai/keys.");
        }

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;
        const effectiveModel = resolveOpenRouterModel(options.modelName);

        return executeOpenAiCompatibleChat(options, {
            providerName: this.providerName,
            providerLabel: 'OpenRouter',
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            apiKey: key,
            modelName: options.modelName,
            effectiveModel,
            messages,
            maxTokens: options.config?.maxTokens || 8192,
            isJson,
            timeoutMs,
            headers: {
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'The Perfect Swarm'
            },
            format429Error: (_status, errorText, retryAfter) => {
                const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
                return `[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: ${errorText}${retrySuffix}`;
            },
            format500Error: (status, errorText) => `[SERVER_ERROR_${status}] OpenRouter service error: ${errorText}`
        });
    }
}
