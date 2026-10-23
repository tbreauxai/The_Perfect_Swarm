import { parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export interface OpenAiCompatibleConfig {
    providerName: string;
    providerLabel?: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
    effectiveModel?: string;
    messages: any[];
    maxTokens: number;
    temperature?: number;
    isJson: boolean;
    timeoutMs: number;
    headers?: Record<string, string>;
    extraBody?: Record<string, any>;
    retryOnTimeout?: boolean;
    formatTimeoutError?: (timeoutMs: number, providerLabel: string) => string;
    format429Error?: (status: number, errorText: string, retryAfter: string | null, providerLabel: string) => string;
    format500Error?: (status: number, errorText: string, providerLabel: string) => string;
    formatGenericError?: (status: number, errorText: string, providerLabel: string) => string;
}

/**
 * Shared executor for OpenAI-compatible REST endpoints.
 * Handles:
 * - JSON/Bearer headers and request payloads
 * - 400 format rejection detection and single retry without response_format
 * - Configurable timeout with optional single retry
 * - Normalized 429, 500, and generic error categorization
 * - Token extraction and telemetry recording via parseStandardResponse
 */
export async function executeOpenAiCompatibleChat(
    options: ProviderCallOptions,
    config: OpenAiCompatibleConfig
): Promise<string> {
    const providerLabel = config.providerLabel || config.providerName;
    const effectiveModel = config.effectiveModel || options.modelName;

    const makeRequest = async (useJson: boolean): Promise<Response> => {
        const bodyPayload: Record<string, any> = {
            model: effectiveModel,
            messages: config.messages,
            max_tokens: config.maxTokens,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(useJson ? { response_format: { type: 'json_object' } } : {}),
            ...(config.extraBody || {})
        };

        const headers: Record<string, string> = {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(config.headers || {})
        };

        return fetch(config.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyPayload),
            signal: AbortSignal.timeout(config.timeoutMs)
        });
    };

    const attemptFetch = async (useJson: boolean): Promise<Response> => {
        try {
            return await makeRequest(useJson);
        } catch (err: any) {
            if (config.retryOnTimeout && (err?.name === 'TimeoutError' || err?.name === 'AbortError')) {
                console.warn(`[${providerLabel}] Request timed out after ${config.timeoutMs}ms for '${options.modelName}'; retrying once.`);
                try {
                    return await makeRequest(useJson);
                } catch (retryErr: any) {
                    if (retryErr?.name === 'TimeoutError' || retryErr?.name === 'AbortError') {
                        const msg = config.formatTimeoutError
                            ? config.formatTimeoutError(config.timeoutMs, providerLabel)
                            : `[TIMEOUT] ${providerLabel} request timed out after ${config.timeoutMs}ms.`;
                        throw new Error(msg);
                    }
                    throw retryErr;
                }
            }
            throw err;
        }
    };

    const startTime = Date.now();
    let response: Response;
    let activeJson = config.isJson;

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
                console.warn(`[${providerLabel}] Model '${options.modelName}' rejected response_format (${peekError}); retrying without format flag.`);
                activeJson = false;
                response = await attemptFetch(false);
            }
        }
    } catch (err: any) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            const msg = config.formatTimeoutError
                ? config.formatTimeoutError(config.timeoutMs, providerLabel)
                : `[TIMEOUT] ${providerLabel} request timed out after ${config.timeoutMs}ms.`;
            throw new Error(msg);
        }
        throw err;
    }

    if (!response.ok) {
        const errorText = await response.text();
        const retryAfter = response.headers?.get ? response.headers.get('retry-after') : null;

        if (response.status === 429) {
            if (config.format429Error) {
                throw new Error(config.format429Error(response.status, errorText, retryAfter, providerLabel));
            }
            const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
            throw new Error(`[RATE_LIMIT_429] ${providerLabel} rate limit / quota exceeded: ${errorText}${retrySuffix}`);
        }

        if (response.status >= 500) {
            if (config.format500Error) {
                throw new Error(config.format500Error(response.status, errorText, providerLabel));
            }
            throw new Error(`[SERVER_ERROR_${response.status}] ${providerLabel} service unavailable: ${errorText}`);
        }

        if (config.formatGenericError) {
            throw new Error(config.formatGenericError(response.status, errorText, providerLabel));
        }
        throw new Error(`${providerLabel} API Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const durationMs = Date.now() - startTime;
    return parseStandardResponse(data, config.providerName, options, config.isJson, effectiveModel, durationMs);
}

/**
 * Base class for OpenAI-compatible chat completion adapters.
 */
export abstract class BaseOpenAiAdapter implements ProviderAdapter {
    abstract readonly providerName: string;
    protected defaultTimeoutMs: number = 30000;
    protected defaultMaxTokens: number = 8192;

    abstract call(options: ProviderCallOptions): Promise<string>;
}
