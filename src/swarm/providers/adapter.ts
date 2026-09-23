import type { ProviderAdapter, ProviderCallOptions } from '../types.ts';
import { globalTelemetryCollector, extractTokenUsage, estimateTokens } from '../telemetry.ts';

export type { ProviderAdapter, ProviderCallOptions };

export function buildStandardMessages(options: ProviderCallOptions): any[] {
    const messages: any[] = [];
    if (options.systemInstruction) {
        messages.push({ role: 'system', content: options.systemInstruction });
    }
    messages.push({ role: 'user', content: options.prompt });
    return messages;
}

/**
 * Strips redundant prefixes ('Bearer ', 'Token '), backticks, quotes, and whitespace from API keys.
 */
export function cleanToken(key: string | undefined | null): string {
    if (!key || typeof key !== 'string') return '';
    return key
        .replace(/^(?:Bearer\s*:?|Token\s*:?)+/i, '')
        .replace(/["'`<>]/g, '')
        .trim();
}

/**
 * Sanitizes model outputs:
 * 1. Strips <think>...</think> reasoning traces emitted by DeepSeek / Llama reasoning models.
 * 2. Strips markdown code blocks.
 * 3. Extracts clean JSON object or array substring if requested.
 */
export function sanitizeModelOutput(raw: string, isJson: boolean = false): string {
    if (!raw) return '';
    let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!isJson) return text;

    text = text.replace(/```(?:json)?/gi, '').trim();
    
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    
    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
        const lastObj = text.lastIndexOf('}');
        if (lastObj !== -1) {
            return text.substring(firstObj, lastObj + 1);
        }
    } else if (firstArr !== -1) {
        const lastArr = text.lastIndexOf(']');
        if (lastArr !== -1) {
            return text.substring(firstArr, lastArr + 1);
        }
    }

    return text;
}

/**
 * Parses a standard chat completion response, extracts token usage, records telemetry,
 * and returns the sanitized model output.
 */
export function parseStandardResponse(
    data: any,
    providerName: string,
    options: ProviderCallOptions,
    isJson: boolean,
    effectiveModel?: string
): string {
    const rawContent = data?.choices?.[0]?.message?.content || '';
    const modelToRecord = effectiveModel || options.modelName;

    // Record token usage
    const tokens = extractTokenUsage(data, providerName);
    if (tokens) {
        globalTelemetryCollector.recordTokenUsage({
            promptTokens: tokens.promptTokens,
            completionTokens: tokens.completionTokens,
            provider: providerName,
            model: modelToRecord
        });
    } else {
        const promptTokens = estimateTokens(options.prompt + (options.systemInstruction || ''));
        const completionTokens = estimateTokens(rawContent);
        globalTelemetryCollector.recordTokenUsage({
            promptTokens,
            completionTokens,
            provider: providerName,
            model: modelToRecord
        });
    }

    return sanitizeModelOutput(rawContent, isJson);
}
