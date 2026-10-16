import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';

export function capGroqPrompt(prompt: string, maxChars: number = 6000): string {
    if (!prompt || prompt.length <= maxChars) return prompt;

    // 1. Cut alternate markets, old news, and non-essential commentary first
    let pruned = prompt
        .replace(/(?:###?\s*(?:Alternate Markets|Other Markets|Props|Historical Notes|Recent News|Old News)[\s\S]*?)(?=(?:###?|\n\n[A-Z]|$))/gi, '')
        .replace(/(?:Alternate Markets|Other Lines|Recent News|Old News):\s*[\s\S]*?(?=(?:\n\n|$))/gi, '');

    if (pruned.length <= maxChars) return pruned;

    // 2. If still over maxChars, truncate cleanly to maxChars
    return pruned.slice(0, maxChars);
}

export function computeGroqMaxTokens(options: ProviderCallOptions, estimatedPromptTokens: number): number {
    const isManager = Boolean(
        options.role?.toLowerCase().includes('manager') ||
        options.role?.toLowerCase().includes('compiler') ||
        options.role?.toLowerCase().includes('judge') ||
        options.systemInstruction?.toLowerCase().includes('manager') ||
        options.systemInstruction?.toLowerCase().includes('godview compiler')
    );

    // Default: 1024 for analyst/critic calls, 2048 for manager
    const defaultMaxTokens = isManager ? 2048 : 1024;
    let maxTokens = options.config?.maxTokens || defaultMaxTokens;

    // If caller passes higher maxTokens or if prompt is large, clamp so estimatedPromptTokens + maxTokens stays under 6000
    if (estimatedPromptTokens + maxTokens > 6000) {
        maxTokens = Math.max(256, 6000 - estimatedPromptTokens);
    }

    return maxTokens;
}

export class GroqAdapter implements ProviderAdapter {
    readonly providerName = 'groq';

    async call(options: ProviderCallOptions): Promise<string> {
        const key = cleanToken(options.apiKey);
        if (!key) {
            throw new Error('Missing Groq API Key.');
        }

        // Cap prompt string at 6,000 characters (preserving core task and baselines)
        const promptText = capGroqPrompt(options.prompt, 6000);
        const optionsWithCappedPrompt = { ...options, prompt: promptText };
        const messages = buildStandardMessages(optionsWithCappedPrompt);

        // Estimate prompt tokens (~4 chars per token)
        const totalPromptLength = (options.systemInstruction?.length || 0) + promptText.length;
        const estimatedPromptTokens = Math.ceil(totalPromptLength / 4);
        const maxTokens = computeGroqMaxTokens(options, estimatedPromptTokens);

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes

        const startTime = Date.now();
        let response: Response;
        try {
            response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    model: options.modelName,
                    messages,
                    max_tokens: maxTokens,
                    response_format: isJson ? { type: 'json_object' } : undefined
                }),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err: any) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`[TIMEOUT] Groq request timed out after ${timeoutMs}ms.`);
            }
            throw err;
        }

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const retrySuffix = retryAfter ? ` (retry-after: ${retryAfter}s)` : '';
                throw new Error(`[RATE_LIMIT_429] Groq rate limit / quota exceeded: ${errorText}${retrySuffix}`);
            }
            if (response.status >= 500) {
                throw new Error(`[SERVER_ERROR_${response.status}] Groq service unavailable: ${errorText}`);
            }
            throw new Error(`Groq API Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const durationMs = Date.now() - startTime;
        return parseStandardResponse(data, this.providerName, options, isJson, undefined, durationMs);
    }
}
