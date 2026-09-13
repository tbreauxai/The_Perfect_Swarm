import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

let mistralMutex: Promise<void> = Promise.resolve();

export class MistralAdapter implements ProviderAdapter {
    readonly providerName = 'mistral';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Mistral API Key.');
        }

        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;

        // Mistral Free Tier pacing mutex (31s pacing to respect 2 RPM limit)
        await mistralMutex;
        let releaseMutex: () => void;
        mistralMutex = new Promise(resolve => { releaseMutex = resolve as () => void; });

        try {
            const messages: any[] = [];
            if (options.systemInstruction) {
                messages.push({ role: 'system', content: options.systemInstruction });
            }
            messages.push({ role: 'user', content: options.prompt });

            const isJson = options.config?.responseMimeType === 'application/json';

            let response: Response;
            try {
                response = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
                    throw new Error(`[TIMEOUT] Mistral request timed out after ${timeoutMs}ms.`);
                }
                throw err;
            }

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 429) {
                    throw new Error(`[RATE_LIMIT_429] Mistral rate limit exceeded: ${errorText}`);
                }
                if (response.status >= 500) {
                    throw new Error(`[SERVER_ERROR_${response.status}] Mistral server error: ${errorText}`);
                }
                throw new Error(`Mistral API Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            const rawContent = data?.choices?.[0]?.message?.content || '';
            return sanitizeModelOutput(rawContent, isJson);
        } finally {
            setTimeout(releaseMutex!, 31000);
        }
    }
}
