import { cleanToken, buildStandardMessages, parseStandardResponse, isKnownReasoningModel, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export class NvidiaAdapter implements ProviderAdapter {
    readonly providerName = 'nvidia';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) throw new Error('Missing NVIDIA API Key.');

        const messages = buildStandardMessages(options);
        const isJson = options.config?.responseMimeType === 'application/json' && !isKnownReasoningModel(options.modelName);
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 25000; // 25s per-attempt (fail fast, retry once on timeout)

        const makeRequest = async (useJson: boolean): Promise<Response> => {
            return fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
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
                    temperature: 0.2,
                    response_format: useJson ? { type: 'json_object' } : undefined
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        };

        const attemptFetch = async (useJson: boolean): Promise<Response> => {
            try {
                return await makeRequest(useJson);
            } catch (err: any) {
                if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                    // Retry once on timeout per Problem 4
                    console.warn(`[NVIDIA] Request timed out after ${timeoutMs}ms for '${options.modelName}'; retrying once.`);
                    try {
                        return await makeRequest(useJson);
                    } catch (retryErr: any) {
                        if (retryErr.name === 'TimeoutError' || retryErr.name === 'AbortError') {
                            throw new Error(`[TIMEOUT] NVIDIA request timed out after ${timeoutMs}ms.`);
                        }
                        throw retryErr;
                    }
                }
                throw err;
            }
        };

        const startTime = Date.now();
        let response: Response;
        let activeJson = isJson;
        try {
            response = await attemptFetch(activeJson);
            if (!response.ok && response.status === 400 && activeJson) {
                const peekError = await response.clone().text().catch(() => '');
                const isFormatRejection = !peekError ||
                    peekError.toLowerCase().includes('response_format') ||
                    peekError.toLowerCase().includes('format') ||
                    peekError.toLowerCase().includes('schema') ||
                    peekError.toLowerCase().includes('json');
                if (isFormatRejection) {
                    console.warn(`[NVIDIA] Model '${options.modelName}' rejected response_format (${peekError}); retrying without format flag.`);
                    activeJson = false;
                    response = await attemptFetch(false);
                }
            }
        } catch (err: any) {
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
