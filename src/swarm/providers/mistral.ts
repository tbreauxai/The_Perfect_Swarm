import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class MistralAdapter implements ProviderAdapter {
    readonly providerName = 'mistral';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Mistral API Key.');
        }

        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000;

        const messages = buildStandardMessages(options);

            const isJson = options.config?.responseMimeType === 'application/json';

            const makeRequest = async (useJson: boolean): Promise<Response> => {
                return fetch('https://api.mistral.ai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        model: options.modelName,
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
                        console.warn(`[Mistral] Model '${options.modelName}' rejected response_format (${peekError}); retrying without format flag.`);
                        activeJson = false;
                        response = await makeRequest(false);
                    }
                }
            } catch (err: any) {
                if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                    throw new Error(`[TIMEOUT] Mistral request timed out after ${timeoutMs}ms.`);
                }
                throw err;
            }

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 429) {
                    const retryAfter = response.headers?.get ? response.headers.get('retry-after') : null;
                    const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
                    let detail = errorText;
                    try {
                        const parsed = JSON.parse(errorText);
                        if (parsed.code === 1300 || parsed.code) {
                            throw new Error(`[RATE_LIMIT_429] Mistral API rate limit exceeded (Code 1300): ${parsed.message || errorText}${retrySuffix}`);
                        } else if (parsed.message) {
                            detail = parsed.message;
                        }
                    } catch (e: any) {
                        if (e.message?.startsWith('[RATE_LIMIT_429]')) {
                            throw e;
                        }
                    }
                    throw new Error(`[RATE_LIMIT_429] Mistral API rate limit exceeded: ${detail}${retrySuffix}`);
                }
                if (response.status >= 500) {
                    throw new Error(`[SERVER_ERROR_${response.status}] Mistral server error: ${errorText}`);
                }
                throw new Error(`Mistral API Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            const durationMs = Date.now() - startTime;
            return parseStandardResponse(data, this.providerName, options, isJson, undefined, durationMs);
    }
}
