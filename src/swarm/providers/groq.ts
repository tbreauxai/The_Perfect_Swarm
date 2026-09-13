import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class GroqAdapter implements ProviderAdapter {
    readonly providerName = 'groq';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Groq API Key.');
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
            response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
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
                throw new Error(`[TIMEOUT] Groq request timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                throw new Error(`[RATE_LIMIT_429] Groq rate limit / quota exceeded: ${errorText}`);
            }
            if (response.status >= 500) {
                throw new Error(`[SERVER_ERROR_${response.status}] Groq service unavailable: ${errorText}`);
            }
            throw new Error(`Groq API Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content || '';
        return sanitizeModelOutput(rawContent, isJson);
    }
}
