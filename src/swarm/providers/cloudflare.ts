import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

function accountId(): string {
    const fromEnv = typeof process !== 'undefined' ? process.env?.CLOUDFLARE_ACCOUNT_ID : '';
    return String(fromEnv || '').trim();
}

export class CloudflareAdapter implements ProviderAdapter {
    readonly providerName = 'cloudflare';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        const account = accountId();
        if (!key) throw new Error('Missing Cloudflare Workers AI token.');
        if (!account) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;
        const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;

        const startTime = Date.now();
        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    model: options.modelName,
                    messages,
                    max_tokens: options.config?.maxTokens || 2048
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err: any) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`[TIMEOUT] Cloudflare Workers AI timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) throw new Error(`[RATE_LIMIT_429] Cloudflare Workers AI rate limit: ${errorText}`);
            if (response.status >= 500) throw new Error(`[SERVER_ERROR_${response.status}] Cloudflare Workers AI: ${errorText}`);
            throw new Error(`Cloudflare Workers AI Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        return parseStandardResponse(data, this.providerName, options, isJson, undefined, Date.now() - startTime);
    }
}
