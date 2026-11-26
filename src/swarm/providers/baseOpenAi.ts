import { parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { parseRetryAfterHeader, parseRetryAfterMs } from '../utils/httpTimeouts.ts';
import { isBlockedBuiltinTool } from '../tools/registry.ts';
import { isBillingOrAuthError } from './limiter.ts';

function makeHttpError(message: string, status: number): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
}

export function sanitizeOpenAiTools(tools: any[]): any[] {
    if (!Array.isArray(tools)) return [];
    return tools.filter((t) => {
        if (!t || typeof t !== 'object') return false;
        const toolType = String(t.type || '').toLowerCase().trim();
        if (toolType === 'code_interpreter' || toolType === 'browser_search') return false;
        const name = t.function?.name ?? t.name ?? '';
        if (isBlockedBuiltinTool(name)) return false;
        return true;
    });
}

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
    tools?: any[];
    toolChoice?: any;
    retryOnTimeout?: boolean;
    formatTimeoutError?: (timeoutMs: number, providerLabel: string) => string;
    format429Error?: (status: number, errorText: string, retryAfter: string | null, providerLabel: string) => string;
    format500Error?: (status: number, errorText: string, providerLabel: string) => string;
    formatGenericError?: (status: number, errorText: string, providerLabel: string) => string;
}

function trySalvageToolUseFailed(errorText: string): string | null {
    if (!errorText) return null;
    try {
        const parsed = JSON.parse(errorText);
        const errObj = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
        if (errObj?.code !== 'tool_use_failed' || typeof errObj?.failed_generation !== 'string') {
            return null;
        }
        const gen = JSON.parse(errObj.failed_generation.trim());
        if (!gen || typeof gen !== 'object' || typeof gen.name !== 'string') {
            return null;
        }
        if (!gen.arguments || typeof gen.arguments !== 'object' || Array.isArray(gen.arguments)) {
            return null;
        }
        const args = gen.arguments as Record<string, unknown>;
        if (
            gen.name.toLowerCase() === 'json' &&
            typeof args.pass === 'boolean' &&
            (typeof args.verdict === 'string' || typeof args.feedback === 'string')
        ) {
            return JSON.stringify(gen.arguments);
        }
    } catch {
        return null;
    }
    return null;
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
    const resolvedTools = sanitizeOpenAiTools(config.tools ?? options.config?.tools ?? []);
    const rawToolChoice = config.toolChoice ?? options.config?.toolChoice;
    const isToolChoiceNone = typeof rawToolChoice === 'string' && rawToolChoice.toLowerCase().trim() === 'none';
    const resolvedToolChoice = resolvedTools.length > 0
        ? (!rawToolChoice || isToolChoiceNone ? 'auto' : rawToolChoice)
        : undefined;

    const makeRequest = async (useJson: boolean): Promise<Response> => {
        const sanitizedExtraBody = config.extraBody ? { ...config.extraBody } : undefined;
        if (sanitizedExtraBody && 'tool_choice' in sanitizedExtraBody) {
            const extraTc = String(sanitizedExtraBody.tool_choice ?? '').toLowerCase().trim();
            if (resolvedTools.length === 0 || extraTc === 'none') {
                delete sanitizedExtraBody.tool_choice;
            }
        }
        const bodyPayload: Record<string, any> = {
            model: effectiveModel,
            messages: config.messages,
            max_tokens: config.maxTokens,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(useJson && !resolvedTools.length ? { response_format: { type: 'json_object' } } : {}),
            ...(sanitizedExtraBody || {}),
            ...(resolvedTools.length > 0 ? { tools: resolvedTools, tool_choice: resolvedToolChoice } : {})
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
        if (options.onHeaders && response?.headers) options.onHeaders(response.headers);
        if (!response.ok && response.status === 400 && activeJson) {
            const peekError = await response.clone().text().catch(() => '');
            const salvaged = trySalvageToolUseFailed(peekError);
            if (salvaged !== null) {
                return salvaged;
            }
            const isFormatRejection = !peekError.includes('tool_use_failed') && (
                !peekError ||
                peekError.toLowerCase().includes('response_format') ||
                peekError.toLowerCase().includes('format') ||
                peekError.toLowerCase().includes('schema') ||
                peekError.toLowerCase().includes('json')
            );

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
        if (response.status === 429) {
            const errorClone = typeof (response as any).clone === 'function'
                ? await (response as any).clone().text().catch(() => '')
                : '';
            const billingCheck = isBillingOrAuthError({ status: 429, message: errorClone });
            if (!billingCheck.match) {
                const rawHeader = response.headers?.get
                    ? (response.headers.get('retry-after') || response.headers.get('x-ratelimit-reset'))
                    : (response.headers as any)?.['retry-after'];
                let retryMs = parseRetryAfterHeader(rawHeader);
                if (retryMs === null) {
                    retryMs = parseRetryAfterMs(errorClone, 0, 100, 30000);
                }
                if (retryMs !== null && retryMs > 0 && retryMs <= 8000) {
                    const jitterMs = Math.floor(Math.random() * 600) + 200; // 200-800ms jitter
                    await new Promise((r) => setTimeout(r, retryMs + jitterMs));
                    try {
                        response = await attemptFetch(activeJson);
                        if (options.onHeaders && response?.headers) options.onHeaders(response.headers);
                    } catch {
                        // fall through to error handling below
                    }
                }
            }
        }
    }

    if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 400) {
            const salvaged = trySalvageToolUseFailed(errorText);
            if (salvaged !== null) {
                return salvaged;
            }
        }
        const retryAfter = response.headers?.get ? response.headers.get('retry-after') : null;

        if (response.status === 429) {
            if (config.format429Error) {
                throw makeHttpError(config.format429Error(response.status, errorText, retryAfter, providerLabel), response.status);
            }
            const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
            throw makeHttpError(`[RATE_LIMIT_429] ${providerLabel} rate limit / quota exceeded: ${errorText}${retrySuffix}`, response.status);
        }

        if (response.status >= 500) {
            if (config.format500Error) {
                throw makeHttpError(config.format500Error(response.status, errorText, providerLabel), response.status);
            }
            throw makeHttpError(`[SERVER_ERROR_${response.status}] ${providerLabel} service unavailable: ${errorText}`, response.status);
        }

        if (config.formatGenericError) {
            throw makeHttpError(config.formatGenericError(response.status, errorText, providerLabel), response.status);
        }
        throw makeHttpError(`${providerLabel} API Error (${response.status}): ${errorText}`, response.status);
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
