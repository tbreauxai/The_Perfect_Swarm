import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class NvidiaAdapter implements ProviderAdapter {
    readonly providerName = 'nvidia';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) throw new Error('Missing NVIDIA API Key.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;

        const startTime = Date.now();
        let response: Response;
        try {
            response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    model: options.modelName,
                    messages,
                    max_tokens: options.config?.maxTokens || 2048,
                    temperature: 0.2
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err: any) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`[TIMEOUT] NVIDIA request timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) throw new Error(`[RATE_LIMIT_429] NVIDIA rate limit: ${errorText}`);
            if (response.status >= 500) throw new Error(`[SERVER_ERROR_${response.status}] NVIDIA: ${errorText}`);
            throw new Error(`NVIDIA API Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        return parseStandardResponse(data, this.providerName, options, isJson, undefined, Date.now() - startTime);
    }
}
