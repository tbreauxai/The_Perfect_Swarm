import { cleanToken, buildStandardMessages, parseStandardResponse, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { LimiterSkipError } from './limiter.ts';

/**
 * PS2 Groq budget modes (passed explicitly by callers via config.groqMode):
 * - 'chat':    prompt capped at 18,000 chars; max_tokens = min(2000, 7000 - ceil(promptChars/4)); < 800 => skip Groq (next fallback).
 * - scorecard (chat + config.maxTokensCap, R2): max_tokens = min(cap, 7000 - ceil(promptChars/4)); the same < 800 => skip rule applies first.
 * - 'morning': unchanged legacy behavior (6,000-char cap + computeGroqMaxTokens 6k-total clamp).
 * A call with no groqMode (critic, verification, other callers) keeps the legacy/morning behavior.
 */
export type GroqMode = 'chat' | 'morning';
export const GROQ_CHAT_PROMPT_CHARS = 18_000;
export const GROQ_MORNING_PROMPT_CHARS = 6_000;
export const GROQ_CHAT_MAX_TOKENS = 2_000;
export const GROQ_CHAT_TPM_BUDGET = 7_000;
export const GROQ_CHAT_MIN_TOKENS = 800;

export function groqPromptCharCap(mode?: unknown): number {
    return mode === 'chat' ? GROQ_CHAT_PROMPT_CHARS : GROQ_MORNING_PROMPT_CHARS;
}

/** Chat mode: min(2000, 7000 - ceil(promptChars/4)). promptChars = system instruction + capped prompt. */
export function computeGroqChatMaxTokens(promptChars: number): number {
    return Math.min(GROQ_CHAT_MAX_TOKENS, GROQ_CHAT_TPM_BUDGET - Math.ceil(Math.max(0, promptChars) / 4));
}

/**
 * R2-S1 scorecard analysts (chat mode + config.maxTokensCap): min(cap, 7000 - ceil(promptChars/4)).
 * Same ceil(chars/4) estimate and 7000 TPM budget as computeGroqChatMaxTokens; the cap (default 800, or
 * settings.scorecardAnalystMaxTokens) takes the place of the 2000 chat ceiling.
 */
export function computeGroqScorecardMaxTokens(cap: number, promptChars: number): number {
    return Math.min(Math.floor(cap), GROQ_CHAT_TPM_BUDGET - Math.ceil(Math.max(0, promptChars) / 4));
}

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

        // PS2: explicit mode. Chat caps at 18k chars; morning (and callers with no mode) keep the 6k cap.
        const mode: GroqMode = options.config?.groqMode === 'chat' ? 'chat' : 'morning';
        const promptText = capGroqPrompt(options.prompt, groqPromptCharCap(mode));
        const optionsWithCappedPrompt = { ...options, prompt: promptText };
        const messages = buildStandardMessages(optionsWithCappedPrompt);

        // Estimate prompt tokens (~4 chars per token)
        const totalPromptLength = (options.systemInstruction?.length || 0) + promptText.length;
        const estimatedPromptTokens = Math.ceil(totalPromptLength / 4);
        // R2-S1: scorecard analysts send config.maxTokensCap (default 800, or settings.scorecardAnalystMaxTokens).
        const rawCap = Number(options.config?.maxTokensCap);
        const maxTokensCap = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : 0;
        let maxTokens: number;
        if (mode === 'chat') {
            maxTokens = computeGroqChatMaxTokens(totalPromptLength);
            if (maxTokens < GROQ_CHAT_MIN_TOKENS) {
                // No harder truncation: skip Groq so Agent.run moves to the next fallback immediately.
                // Scorecard calls hit the same rule: if 7000 - prompt tokens < 800, Groq is skipped (never a smaller cap).
                throw new LimiterSkipError('groq', options.modelName, `chat max_tokens budget ${maxTokens} < ${GROQ_CHAT_MIN_TOKENS}; skipping Groq`);
            }
            if (maxTokensCap) {
                // R2-S1 scorecard: min(cap, 7000 - prompt tokens). The remainder is >= 800 here.
                maxTokens = computeGroqScorecardMaxTokens(maxTokensCap, totalPromptLength);
            }
        } else {
            maxTokens = computeGroqMaxTokens(options, estimatedPromptTokens);
            // Morning/legacy mode never runs scorecards; a cap there only lowers max_tokens.
            if (maxTokensCap) maxTokens = Math.min(maxTokens, maxTokensCap);
        }

        const isJson = options.config?.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes

        const makeRequest = async (useJson: boolean): Promise<Response> => {
            return fetch('https://api.groq.com/openai/v1/chat/completions', {
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
                    console.warn(`[Groq] Model '${options.modelName}' rejected response_format (${peekError}); retrying without format flag.`);
                    activeJson = false;
                    response = await makeRequest(false);
                }
            }
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
