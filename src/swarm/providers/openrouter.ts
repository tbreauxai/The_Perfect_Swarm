import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { globalTelemetryCollector, extractTokenUsage, estimateTokens } from '../telemetry.ts';

export class OpenRouterAdapter implements ProviderAdapter {
    readonly providerName = 'openrouter';

    /**
     * Resolves the canonical free-tier model identifier on OpenRouter.
     * Ensures endpoints append ':free' suffix to prevent 402/400 errors for zero-balance free accounts.
     */
    static resolveFreeModel(modelName: string): string {
        const clean = (modelName || '').trim();
        if (!clean) return 'deepseek/deepseek-r1:free';
        if (clean.endsWith(':free')) return clean;

        const knownFreeMappings: Record<string, string> = {
            'deepseek/deepseek-r1': 'deepseek/deepseek-r1:free',
            'meta-llama/llama-3.3-70b-instruct': 'meta-llama/llama-3.3-70b-instruct:free',
            'meta-llama/llama-3.1-8b-instruct': 'meta-llama/llama-3.1-8b-instruct:free',
            'meta-llama/llama-3-8b-instruct': 'meta-llama/llama-3-8b-instruct:free',
            'google/gemini-3.5-flash': 'google/gemini-2.0-flash-exp:free',
            'mistralai/mistral-7b-instruct': 'mistralai/mistral-7b-instruct:free',
            'qwen/qwen-2.5-coder-32b-instruct': 'qwen/qwen-2.5-coder-32b-instruct:free'
        };

        if (knownFreeMappings[clean]) {
            return knownFreeMappings[clean];
        }

        return `${clean}:free`;
    }

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing OpenRouter API key. Please configure a valid key starting with "sk-or-v1-".');
        }

        if (!key.startsWith('sk-or-v1-')) {
            throw new Error(`Invalid OpenRouter key format. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a key from openrouter.ai/keys.`);
        }

        const messages: any[] = [];
        if (options.systemInstruction) {
            messages.push({ role: 'system', content: options.systemInstruction });
        }
        messages.push({ role: 'user', content: options.prompt });

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 120000;
        const effectiveModel = options.modelName;

        let response: Response;
        try {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
                    response_format: isJson ? { type: 'json_object' } : undefined
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err: any) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`[TIMEOUT] OpenRouter request timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                throw new Error(`[RATE_LIMIT_429] OpenRouter rate limit / credit exhaustion: ${errorText}`);
            }
            if (response.status >= 500) {
                throw new Error(`[SERVER_ERROR_${response.status}] OpenRouter service error: ${errorText}`);
            }
            throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content || '';

        // Record token usage
        const tokens = extractTokenUsage(data, this.providerName);
        if (tokens) {
            globalTelemetryCollector.recordTokenUsage({
                promptTokens: tokens.promptTokens,
                completionTokens: tokens.completionTokens,
                provider: this.providerName,
                model: effectiveModel
            });
        } else {
            const promptTokens = estimateTokens(options.prompt + (options.systemInstruction || ''));
            const completionTokens = estimateTokens(rawContent);
            globalTelemetryCollector.recordTokenUsage({
                promptTokens,
                completionTokens,
                provider: this.providerName,
                model: effectiveModel
            });
        }

        return sanitizeModelOutput(rawContent, isJson);
    }
}
