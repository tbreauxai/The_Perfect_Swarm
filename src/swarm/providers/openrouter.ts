import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

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

        const messages: any[] = [];
        if (options.systemInstruction) {
            messages.push({ role: 'system', content: options.systemInstruction });
        }
        messages.push({ role: 'user', content: options.prompt });

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;

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
                    model: options.modelName,
                    messages,
                    max_tokens: options.config?.maxTokens || 1500,
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
        return sanitizeModelOutput(rawContent, isJson);
    }
}
