import { cleanToken, buildStandardMessages, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { executeOpenAiCompatibleChat } from './baseOpenAi.ts';

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

        return executeOpenAiCompatibleChat(options, {
            providerName: this.providerName,
            providerLabel: 'Cloudflare Workers AI',
            endpoint: url,
            apiKey: token,
            modelName: options.modelName,
            messages,
            maxTokens: options.config?.maxTokens || 2048,
            isJson,
            timeoutMs,
            formatTimeoutError: (timeout) => `[TIMEOUT] Cloudflare Workers AI timed out after ${timeout}ms.`,
            format429Error: (_status, errorText) => `[RATE_LIMIT_429] Cloudflare Workers AI rate limit: ${errorText}`,
            format500Error: (status, errorText) => `[SERVER_ERROR_${status}] Cloudflare Workers AI: ${errorText}`
        });
    }
}
