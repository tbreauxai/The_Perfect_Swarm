import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

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
            throw new Error(`Invalid OpenRouter key format. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a key from openrouter.ai/keys.`);
        }

        const messages = buildStandardMessages(options);

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes
        const effectiveModel = resolveOpenRouterModel(options.modelName);

        const makeRequest = async (useJson: boolean): Promise<Response> => {
            return fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'The Perfect Swarm'
                },
                body: JSON.stringify({
                    model: effectiveModel,
                    messages,
                    max_tokens: options.config?.maxTokens || 8192,
                    response_format: useJson ? { type: 'json_object' } : undefined
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        };

        const startTime = Date.now();
        let response: Response;
        let activeJson = isJson;
        try {
            response = await makeRequest(activeJson);
            if (!response.ok && response.status === 400 && activeJson) {
                const peekError = await response.clone().text().catch(() => '');
                const isFormatRejection = !peekError ||
                    peekError.toLowerCase().includes('response_format') ||
                    peekError.toLowerCase().includes('format') ||
                    peekError.toLowerCase().includes('schema') ||
                    peekError.toLowerCase().includes('json');
                if (isFormatRejection) {
                    console.warn(`[OpenRouter] Model '${options.modelName}' rejected response_format (${peekError}); retrying without format flag.`);
                    activeJson = false;
                    response = await makeRequest(false);
                }
            }
        } catch (err: any) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`[TIMEOUT] OpenRouter request timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
                throw new Error(`[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: ${errorText}${retrySuffix}`);
            }
            if (response.status >= 500) {
                throw new Error(`[SERVER_ERROR_${response.status}] OpenRouter service error: ${errorText}`);
            }
            throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const durationMs = Date.now() - startTime;
        return parseStandardResponse(data, this.providerName, options, isJson, effectiveModel, durationMs);
    }
}
