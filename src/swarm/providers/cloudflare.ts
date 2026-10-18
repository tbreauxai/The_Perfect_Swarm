import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export function resolveCloudflareCredentials(key: string | undefined | null): { account: string; token: string } {
    let token = cleanToken(key);
    let account = '';
    if (token.includes(':')) {
        const idx = token.indexOf(':');
        account = token.substring(0, idx).trim();
        token = token.substring(idx + 1).trim();
    }
    if (!account && typeof process !== 'undefined') {
        account = String(process.env?.CLOUDFLARE_ACCOUNT_ID || process.env?.CF_ACCOUNT_ID || '').trim();
    }
    return { account, token };
}

export class CloudflareAdapter implements ProviderAdapter {
    readonly providerName = 'cloudflare';

    async call(options: ProviderCallOptions): Promise<string> {
        const { account, token } = resolveCloudflareCredentials(options.apiKey);
        if (!token) throw new Error('Missing Cloudflare Workers AI token.');
        if (!account) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;
        const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;

        const makeRequest = async (useJson: boolean): Promise<Response> => {
            const body: Record<string, any> = {
                model: options.modelName,
                messages,
                max_tokens: options.config?.maxTokens || 2048
            };
            if (useJson) {
                body.response_format = { type: 'json_object' };
            }
            return fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
        };

        const startTime = Date.now();
        let response: Response;
        let activeJson = isJson;
        try {
            response = await makeRequest(activeJson);
            // If the model rejects response_format with 400, retry once without response_format
            if (!response.ok && response.status === 400 && activeJson) {
                const peekError = await response.clone().text().catch(() => '');
                const isFormatRejection = !peekError ||
                    peekError.toLowerCase().includes('response_format') ||
                    peekError.toLowerCase().includes('format') ||
                    peekError.toLowerCase().includes('schema') ||
                    peekError.toLowerCase().includes('json');
                if (isFormatRejection) {
                    console.warn(`[Cloudflare] Model '${options.modelName}' rejected response_format (${peekError}); retrying without format flag.`);
                    activeJson = false;
                    response = await makeRequest(false);
                }
            }
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
