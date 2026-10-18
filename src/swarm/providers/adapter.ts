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
 * Known reasoning models that emit raw thoughts/reasoning traces when JSON mode is forced.
 * For these models, forcing response_format: { type: 'json_object' } can cause server-side 400
 * validation failures or corrupted output; freeform generation with repair extraction is safer.
 */
export const KNOWN_REASONING_MODELS = new Set<string>([
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'deepseek-ai/deepseek-r1',
    'deepseek-r1',
    'deepseek-reasoner'
]);

export function isKnownReasoningModel(modelName: string | undefined): boolean {
    if (!modelName) return false;
    const lower = modelName.toLowerCase().trim();
    if (KNOWN_REASONING_MODELS.has(lower)) return true;
    return lower.endsWith('-reasoning') || lower.includes('/deepseek-r1');
}

/**
 * Scans a string for all balanced JSON structures (objects or arrays) that parse
 * cleanly via JSON.parse, returning the largest (longest) valid JSON substring found.
 * Handles nested braces and strings with escaped quotes.
 */
export function extractLargestValidJson(text: string): string | null {
    if (!text || typeof text !== 'string') return null;

    let longestJson: string | null = null;

    for (let i = 0; i < text.length; i++) {
        const openChar = text[i];
        if (openChar !== '{' && openChar !== '[') continue;
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let j = i; j < text.length; j++) {
            const ch = text[j];
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (ch === openChar) {
                    depth++;
                } else if (ch === closeChar) {
                    depth--;
                    if (depth === 0) {
                        const candidate = text.substring(i, j + 1);
                        try {
                            JSON.parse(candidate);
                            if (!longestJson || candidate.length > longestJson.length) {
                                longestJson = candidate;
                            }
                        } catch {
                            // not valid JSON, keep looking
                        }
                    }
                }
            }
        }
    }

    return longestJson;
}

/**
 * Sanitizes model outputs:
 * 1. Strips all reasoning traces (<think>, <thought>, <reasoning>, [THOUGHT]) emitted by reasoning models.
 * 2. Recovers from truncated unclosed reasoning tags.
 * 3. Strips markdown code blocks.
 * 4. Extracts clean JSON object or array substring if requested (resilient against reasoning noise).
 */
export function sanitizeModelOutput(raw: string, isJson: boolean = false): string {
    if (!raw || typeof raw !== 'string') return '';

    // 1. Universal reasoning tag sanitization (DeepSeek R1, LLaMA 3.3, Qwen, etc.)
    let text = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, '');

    // 2. Handle unclosed reasoning tags if model output was truncated mid-reasoning
    for (const tag of ['<think>', '<thought>', '<reasoning>', '[THOUGHT]']) {
        const tagIdx = text.toLowerCase().indexOf(tag.toLowerCase());
        if (tagIdx !== -1) {
            const containerIdx = text.slice(tagIdx).search(/[{\[]/);
            if (containerIdx !== -1) {
                text = text.substring(0, tagIdx) + text.substring(tagIdx + containerIdx);
            } else {
                text = text.substring(0, tagIdx);
            }
        }
    }

    text = text.trim();
    if (!isJson) return text;

    // 3. Strip outer markdown fences
    text = text.replace(/^```(?:json|javascript|js|jsonc)?\s*/i, '');
    text = text.replace(/\s*```$/i, '');
    text = text.replace(/```(?:json|javascript|js|jsonc)?/gi, '').trim();

    // 4. Try extracting the largest valid balanced JSON substring (strips leading/trailing reasoning prose)
    const validJson = extractLargestValidJson(text);
    if (validJson) {
        return validJson;
    }

    // 5. Fallback: Locate outer JSON container boundary (for partial/truncated JSON repair downstream)
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');

    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
        const lastObj = text.lastIndexOf('}');
        if (lastObj !== -1 && lastObj >= firstObj) {
            return text.substring(firstObj, lastObj + 1);
        }
    } else if (firstArr !== -1) {
        const lastArr = text.lastIndexOf(']');
        if (lastArr !== -1 && lastArr >= firstArr) {
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
    effectiveModel?: string,
    durationMs?: number
): string {
    const rawContent = data?.choices?.[0]?.message?.content || '';
    const modelToRecord = effectiveModel || options.modelName;

    if (durationMs !== undefined) {
        globalTelemetryCollector.recordModelLatency(durationMs);
    }

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
