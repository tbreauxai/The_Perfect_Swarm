import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { globalTelemetryCollector, extractTokenUsage, estimateTokens } from '../telemetry.ts';

export class GitHubAdapter implements ProviderAdapter {
    readonly providerName = 'github';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing GitHub Models Personal Access Token.');
        }

        const messages: any[] = [];
        if (options.systemInstruction) {
            messages.push({ role: 'system', content: options.systemInstruction });
        }
        messages.push({ role: 'user', content: options.prompt });

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 120000;

        const bodyParams: any = {
            model: options.modelName,
            messages,
            temperature: options.config?.temperature || 0.7,
            max_tokens: options.config?.maxTokens || 3500
        };
        if (isJson) {
            bodyParams.response_format = { type: 'json_object' };
        }

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
                throw new Error(`[RATE_LIMIT_429] GitHub Models rate limit exceeded: ${err}`);
            }
            if (response.status >= 500) {
                throw new Error(`[SERVER_ERROR_${response.status}] GitHub Models service error: ${err}`);
            }
            throw new Error(`GitHub API Error: ${response.status} - ${err}`);
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

        return sanitizeModelOutput(rawContent, isJson);
    }
}
