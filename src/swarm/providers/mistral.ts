import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { globalTelemetryCollector, extractTokenUsage, estimateTokens } from '../telemetry.ts';

let mistralMutex: Promise<void> = Promise.resolve();

/**
 * Resets the internal Mistral mutex. Primarily used in unit tests and manual rate-limit recovery.
 */
export function resetMistralMutex(): void {
    mistralMutex = Promise.resolve();
}

export class MistralAdapter implements ProviderAdapter {
    readonly providerName = 'mistral';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Mistral API Key.');
        }

        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 120000;

        // Mistral Free Tier pacing mutex (31s pacing to respect 2 RPM limit)
        await mistralMutex;
        let releaseMutex: () => void;
        mistralMutex = new Promise(resolve => { releaseMutex = resolve as () => void; });

        let isSuccess = false;

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
                        max_tokens: options.config?.maxTokens || 8192,
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
                    let detail = errorText;
                    try {
                        const parsed = JSON.parse(errorText);
                        if (parsed.code === 1300 || parsed.code) {
                            throw new Error(`[RATE_LIMIT_429] Mistral API rate limit exceeded (Code 1300): ${parsed.message || errorText}`);
                        } else if (parsed.message) {
                            detail = parsed.message;
                        }
                    } catch (e: any) {
                        if (e.message?.startsWith('[RATE_LIMIT_429]')) {
                            throw e;
                        }
                    }
                    throw new Error(`[RATE_LIMIT_429] Mistral API rate limit exceeded: ${detail}`);
                }
                if (response.status >= 500) {
                    throw new Error(`[SERVER_ERROR_${response.status}] Mistral server error: ${errorText}`);
                }
                throw new Error(`Mistral API Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            const rawContent = data?.choices?.[0]?.message?.content || '';

            // Record token usage
            const tokens = extractTokenUsage(data, this.providerName);
            if (tokens) {
                globalTelemetryCollector.recordTokenUsage({
                    promptTokens: tokens.promptTokens,
                    completionTokens: tokens.completionTokens,
                    provider: this.providerName,
                    model: options.modelName
                });
            } else {
                const promptTokens = estimateTokens(options.prompt + (options.systemInstruction || ''));
                const completionTokens = estimateTokens(rawContent);
                globalTelemetryCollector.recordTokenUsage({
                    promptTokens,
                    completionTokens,
                    provider: this.providerName,
                    model: options.modelName
                });
            }

            isSuccess = true;
            return sanitizeModelOutput(rawContent, isJson);
        } finally {
            if (isSuccess) {
                setTimeout(releaseMutex!, 31000);
            } else {
                // Release mutex immediately on errors to avoid freezing subsequent requests
                releaseMutex!();
            }
        }
    }
}
