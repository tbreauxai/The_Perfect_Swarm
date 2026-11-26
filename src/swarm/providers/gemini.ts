import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { cleanToken, sanitizeModelOutput, type ProviderAdapter, type ProviderCallOptions } from './adapter.ts';
import { globalTelemetryCollector, estimateTokens } from '../telemetry.ts';
import { parseRetryAfterMs } from '../utils/httpTimeouts.ts';
import { remapDeprecatedGeminiModel } from '../server/modelsProvider.ts';

export function isGemini3Or4Model(modelName: string): boolean {
    const norm = String(modelName || '').replace(/^models\//i, '').trim().toLowerCase();
    return /^gemini-(?:3(?:\.\d+)?|4)(?:[-.]|$)/i.test(norm);
}

export function isGemini4Model(modelName: string): boolean {
    const norm = String(modelName || '').replace(/^models\//i, '').trim().toLowerCase();
    return /^gemini-4(?:[-.]|$)/i.test(norm);
}

export function isGemini36PlusOr4Model(modelName: string): boolean {
    const norm = String(modelName || '').replace(/^models\//i, '').trim().toLowerCase();
    return /^gemini-(?:3\.(?:[6-9]|\d{2,})|4)(?:[-.]|$)/i.test(norm);
}

const VALID_THINKING_LEVELS: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
};

/**
 * Builds a clean `@google/genai` GenerateContentConfig for the target Gemini model.
 * For Gemini 3.x and Gemini 4.x models, strips deprecated Gemini 2.5 parameters
 * (`thinking_budget` / `thinkingBudget`, unsupported sampling fields) and sets
 * `thinkingConfig.thinkingLevel = ThinkingLevel.LOW` for fast JSON compilation.
 */
export function buildGeminiRequestConfig(
    effectiveModelName: string,
    options: ProviderCallOptions
): Record<string, any> {
    const reqConfig: Record<string, any> = { ...(options.config || {}) };
    delete reqConfig.maxTokens;
    delete reqConfig.maxTokensCap;
    delete reqConfig.groqMode;
    delete reqConfig.timeoutMs;
    delete reqConfig.reasoning;
    delete reqConfig.reasoning_effort;
    delete reqConfig.reasoningEffort;
    delete reqConfig.zodSchema;
    delete reqConfig.bypassCache;
    delete reqConfig.fallbackProviders;
    delete reqConfig.loadBalancer;
    delete reqConfig.disableFallback;
    delete reqConfig.interactive;
    delete reqConfig.maxBudgetWaitMs;
    delete reqConfig.noRetry;
    delete reqConfig.toolRegistry;

    reqConfig.maxOutputTokens = options.role === 'catalog-probe'
        ? Math.max(options.config?.maxTokens || 256, 256)
        : (options.config?.maxTokens || 8192);
    if (options.systemInstruction) {
        reqConfig.systemInstruction = options.systemInstruction;
    }

    const toolsPresent = Boolean(reqConfig.tools && (Array.isArray(reqConfig.tools) ? reqConfig.tools.length > 0 : true));
    if (toolsPresent) {
        delete reqConfig.responseMimeType;
        delete reqConfig.responseSchema;
        delete reqConfig.tools;
        delete reqConfig.toolChoice;
    }

    if (isGemini3Or4Model(effectiveModelName)) {
        const rawThinkingConfig =
            reqConfig.thinkingConfig && typeof reqConfig.thinkingConfig === 'object'
                ? { ...reqConfig.thinkingConfig }
                : undefined;

        const requestedLevelRaw =
            rawThinkingConfig?.thinkingLevel ??
            rawThinkingConfig?.thinking_level ??
            reqConfig.thinkingLevel ??
            reqConfig.thinking_level;

        // Strip all deprecated Gemini 2.5 thinking_budget & snake_case aliases
        delete reqConfig.thinking_budget;
        delete reqConfig.thinkingBudget;
        delete reqConfig.thinking_level;
        delete reqConfig.thinkingLevel;
        if (rawThinkingConfig) {
            delete rawThinkingConfig.thinking_budget;
            delete rawThinkingConfig.thinkingBudget;
            delete rawThinkingConfig.thinking_level;
        }

        // Strip snake_case sampling fields everywhere on Gemini 3.x/4.x
        delete reqConfig.top_p;
        delete reqConfig.top_k;
        delete reqConfig.candidate_count;
        delete reqConfig.max_output_tokens;
        delete reqConfig.max_completion_tokens;

        // Gemini 3.6+ and Gemini 4 reject/ignore legacy sampling params (temperature, topP, topK, candidateCount)
        if (isGemini36PlusOr4Model(effectiveModelName)) {
            delete reqConfig.temperature;
            delete reqConfig.topP;
            delete reqConfig.topK;
            delete reqConfig.candidateCount;
        }

        let resolvedLevel: ThinkingLevel | undefined;
        if (typeof requestedLevelRaw === 'string' && requestedLevelRaw.trim()) {
            const normLevel = requestedLevelRaw.trim().toLowerCase();
            resolvedLevel = VALID_THINKING_LEVELS[normLevel];
            // MINIMAL is not supported on Gemini 4 (returns 400); clamp to LOW
            if (resolvedLevel === ThinkingLevel.MINIMAL && isGemini4Model(effectiveModelName)) {
                resolvedLevel = ThinkingLevel.LOW;
            }
        } else if (reqConfig.responseMimeType === 'application/json' || isGemini36PlusOr4Model(effectiveModelName)) {
            // Fast low-thinking default on Gemini 3.6+ / Gemini 4 and JSON compilation
            resolvedLevel = ThinkingLevel.LOW;
        }

        if (resolvedLevel) {
            reqConfig.thinkingConfig = {
                ...(rawThinkingConfig || {}),
                thinkingLevel: resolvedLevel
            };
        } else if (rawThinkingConfig && Object.keys(rawThinkingConfig).length > 0) {
            reqConfig.thinkingConfig = rawThinkingConfig;
        } else {
            delete reqConfig.thinkingConfig;
        }
    }

    return reqConfig;
}

export class GeminiAdapter implements ProviderAdapter {
    readonly providerName = 'gemini';

    async call(options: ProviderCallOptions): Promise<string> {
        let client = options.aiClient;
        const key = cleanToken(options.apiKey);

        if (!client && key) {
            client = new GoogleGenAI({
                apiKey: key,
                httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
            });
        }

        if (!client) {
            throw new Error('Gemini API client could not be initialized. Please configure a valid Gemini API key.');
        }

        const effectiveModelName = remapDeprecatedGeminiModel(options.modelName);
        const reqConfig = buildGeminiRequestConfig(effectiveModelName, options);

        const isJson = reqConfig.responseMimeType === 'application/json';
        const timeoutMs = options.timeoutMs || options.config?.timeoutMs || 30000; // 30s default: fail fast on free-tier stalls instead of hanging for 2 minutes

        const executeGeneration = async (cfg: any): Promise<any> => {
            let timeoutId: any;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`[TIMEOUT] Gemini request timed out after ${timeoutMs}ms.`));
                }, timeoutMs);
            });
            try {
                return await Promise.race([
                    client.models.generateContent({
                        model: effectiveModelName,
                        contents: options.prompt,
                        config: cfg
                    }),
                    timeoutPromise
                ]);
            } finally {
                clearTimeout(timeoutId);
            }
        };

        let response: any;
        const startTime = Date.now();
        let activeConfig = { ...reqConfig };
        try {
            try {
                response = await executeGeneration(activeConfig);
            } catch (firstErr: any) {
                const errStr = String(firstErr?.message || firstErr || '');
                const isFormatRejection = isJson && (
                    firstErr?.status === 400 ||
                    errStr.includes('400') ||
                    errStr.includes('INVALID_ARGUMENT') ||
                    errStr.toLowerCase().includes('responsemimetype') ||
                    errStr.toLowerCase().includes('format') ||
                    errStr.toLowerCase().includes('schema') ||
                    errStr.toLowerCase().includes('json')
                );
                if (isFormatRejection) {
                    console.warn(`[Gemini] Model '${options.modelName}' rejected responseMimeType (${errStr}); retrying without format flag.`);
                    const fallbackConfig = { ...activeConfig };
                    delete fallbackConfig.responseMimeType;
                    delete fallbackConfig.responseSchema;
                    response = await executeGeneration(fallbackConfig);
                } else {
                    throw firstErr;
                }
            }
        } catch (error: any) {
            const errStr = String(error?.message || error || '');
            const errStatus = typeof error?.status === 'number' ? error.status : undefined;
            if (
                errStatus === 429 ||
                errStr.includes('429') ||
                errStr.includes('RESOURCE_EXHAUSTED') ||
                errStr.includes('quota')
            ) {
                const retryMs = parseRetryAfterMs(error, 0, 100, 30000);
                if (retryMs > 0 && retryMs <= 8000) {
                    const jitterMs = Math.floor(Math.random() * 600) + 200;
                    await new Promise(r => setTimeout(r, retryMs + jitterMs));
                    try {
                        response = await executeGeneration(activeConfig);
                    } catch (retryErr: any) {
                        const retryErrStr = String(retryErr?.message || retryErr || '');
                        const wrapped: any = new Error(`[RATE_LIMIT_429] Gemini quota/rate limit exceeded: ${retryErrStr}`);
                        wrapped.status = 429;
                        throw wrapped;
                    }
                } else if (!errStr.startsWith('[RATE_LIMIT_429]')) {
                    const wrapped: any = new Error(`[RATE_LIMIT_429] Gemini quota/rate limit exceeded: ${errStr}`);
                    wrapped.status = 429;
                    throw wrapped;
                } else {
                    throw error;
                }
            } else {
                if (errStatus && !(error instanceof Error)) {
                    const wrapped: any = new Error(`Gemini API Error (${errStatus}): ${errStr}`);
                    wrapped.status = errStatus;
                    throw wrapped;
                }
                throw error;
            }
        }

        const durationMs = Date.now() - startTime;
        globalTelemetryCollector.recordModelLatency(durationMs);

        const rawText = response.text || '';

        // Record token usage
        if (response.usageMetadata) {
            globalTelemetryCollector.recordTokenUsage({
                promptTokens: response.usageMetadata.promptTokenCount || 0,
                completionTokens: response.usageMetadata.candidatesTokenCount || 0,
                provider: this.providerName,
                model: effectiveModelName
            });
        } else {
            const promptTokens = estimateTokens(options.prompt + (options.systemInstruction || ''));
            const completionTokens = estimateTokens(rawText);
            globalTelemetryCollector.recordTokenUsage({
                promptTokens,
                completionTokens,
                provider: this.providerName,
                model: effectiveModelName
            });
        }

        return sanitizeModelOutput(rawText, isJson);
    }
}
