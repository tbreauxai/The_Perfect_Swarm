import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

/** GitHub Models was retired on 2026-07-30 (inference API, catalog and BYOK removed for everyone). */
export const GITHUB_MODELS_RETIRED = true;
export const GITHUB_MODELS_RETIRED_MESSAGE =
    'GitHub Models was retired on 2026-07-30: the provider is disabled and its inference endpoint does not exist anymore. Pick another provider.';

export class GitHubAdapter implements ProviderAdapter {
    readonly providerName = 'github';

    async call(options: ProviderCallOptions): Promise<string> {
        // Retired provider: never hit the network. The message contains "does not exist", so Agent.run treats it
        // as fatal and moves straight to the next fallback with no retry.
        if (GITHUB_MODELS_RETIRED) {
            throw new Error(GITHUB_MODELS_RETIRED_MESSAGE);
        }
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing GitHub Models Personal Access Token.');
        }

        const messages = buildStandardMessages(options);

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes

        const bodyParams: any = {
            model: options.modelName,
            messages,
            temperature: options.config?.temperature || 0.7,
            max_tokens: options.config?.maxTokens || 8192
        };
        if (isJson) {
            bodyParams.response_format = { type: 'json_object' };
        }

        const startTime = Date.now();
        let response: Response;
        try {
            response = await fetch('https://models.github.ai/inference/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(bodyParams),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err: any) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`[TIMEOUT] GitHub Models request timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const err = await response.text();
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
                throw new Error(`[RATE_LIMIT_429] GitHub Models rate limit exceeded: ${err}${retrySuffix}`);
            }
            if (response.status >= 500) {
                throw new Error(`[SERVER_ERROR_${response.status}] GitHub Models service error: ${err}`);
            }
            throw new Error(`GitHub API Error: ${response.status} - ${err}`);
        }

        const data = await response.json();
        const durationMs = Date.now() - startTime;
        return parseStandardResponse(data, this.providerName, options, isJson, undefined, durationMs);
    }
}
