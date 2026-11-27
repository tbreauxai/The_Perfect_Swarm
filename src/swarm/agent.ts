import type { GoogleGenAI } from '@google/genai';
import type { Provider, AgentRunConfig, ProviderCredential } from './types.ts';
import { SwarmContext } from './context.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { sanitizeModelOutput, extractLargestValidJson } from './providers/adapter.ts';
import { recordRunDebugFailover } from './engine/runDebugRecord.ts';
import { seatBudget } from './context/promptBudget.ts';
import { SwarmTracer } from './profiler.ts';
import { globalLoadBalancer, type AdaptiveLoadBalancer } from './loadBalancer.ts';
import { globalTokenBudgetManager } from './loadBalancer/tokenBudgetManager.ts';
import {
    globalProviderLimiter,
    estimateTokens,
    PROVIDER_CALL_TIMEOUT_MS,
    MAX_BUDGET_WAIT_MS,
    DEFAULT_STRICT_BUDGET_WAIT_MS,
    INTERACTIVE_MAX_BUDGET_WAIT_MS,
    FAILOVER_MAX_TPM_WAIT_MS,
    PROMPT_EXCEEDS_LIMIT_REASON,
    UNSATISFIABLE_BUDGET_WAIT_MS,
    MODEL_COOLDOWN_MS,
    BREAKER_OPEN_MS,
    BILLING_COOLDOWN_MS,
    isBillingOrAuthError,
    isGeminiProjectWideFailure
} from './providers/limiter.ts';
import { isGemini3Or4Model } from './providers/gemini.ts';
import { parseRetryAfterMs } from './utils/httpTimeouts.ts';
import { isModelDead, DEFAULT_PROVIDER_MODELS } from './server/modelsProvider.ts';
import { groqPromptCharCap, isGroqGptOss120b, isManagerSeatRole, resolveGroqGptOss120bReasoningEffort } from './providers/groq.ts';
import { globalPayloadCache, PayloadCache } from './cache.ts';
import { parseJsonSafe, parseJsonSafeWithStatus, guardManagerResponse, guardAnalystResponse } from './parser.ts';
import { ManagerResponseSchema, AnalystResponseSchema } from './schemas.ts';
import { isBlockedBuiltinTool } from './tools/registry.ts';

export { DEFAULT_PROVIDER_MODELS } from './server/modelsProvider.ts';

/**
 * Autonomous Swarm Agent decoupled from specific LLM provider implementations.
 * Features:
 * - Dynamic execution via ProviderRegistry adapters
 * - Multi-provider failover cascades on free-tier rate limits (429), timeouts, and 5xx errors
 * - Robust reasoning model sanitization (<think> tag stripping)
 */
/**
 * Extracts a numeric HTTP status code (e.g. 400, 429, 503) from an adapter error object or message.
 */
export function extractHttpStatus(err: unknown): number | null {
    if (!err) return null;
    if (typeof err === 'object') {
        const obj = err as Record<string, any>;
        const direct = obj.status ?? obj.statusCode ?? obj.code ?? obj.response?.status;
        if (typeof direct === 'number' && direct >= 100 && direct <= 599) {
            return direct;
        }
        if (typeof direct === 'string' && /^\d{3}$/.test(direct.trim())) {
            const parsed = Number(direct.trim());
            if (parsed >= 100 && parsed <= 599) return parsed;
        }
    }
    const msg = typeof err === 'string' ? err : String((err as any)?.message || err || '');
    const tagged = msg.match(/(?:RATE_LIMIT_|SERVER_ERROR_|HTTP\s+|status[=:\s]+|API Error\s*\()([1-5]\d{2})\b/i);
    if (tagged) return Number(tagged[1]);
    const generic = msg.match(/\b(400|401|402|403|404|408|409|422|429|500|502|503|504)\b/);
    if (generic) return Number(generic[1]);
    return null;
}

/**
 * Redacts API keys/tokens and truncates error text to <= maxLen (default 160 chars) for Flight Recorder / SSE telemetry.
 */
export function redactErrorSnippet(err: unknown, maxLen: number = 160): string {
    const raw = typeof err === 'string' ? err : String((err as any)?.message || err || '');
    const redacted = raw
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
        .replace(/([?&](?:key|api_key|apikey|token|access_token|secret)=)[^&\s'"]+/gi, '$1[REDACTED]')
        .replace(/\b(?:AIza[0-9A-Za-z_-]{8,}|gsk_[0-9A-Za-z_-]{8,}|sk-(?:or-v1-)?[0-9A-Za-z_-]{8,}|ghp_[0-9A-Za-z_-]{8,}|nvapi-[0-9A-Za-z_-]{8,})\b/g, '[REDACTED]')
        .replace(/\s+/g, ' ')
        .trim();
    if (redacted.length <= maxLen) return redacted;
    return `${redacted.slice(0, Math.max(0, maxLen - 3))}...`;
}

function resolveTargetModelName(
    target: { provider: string; modelName?: string },
    primaryProvider: string,
    defaultModelName: string
): string {
    return (
        target.modelName ||
        (target.provider === primaryProvider ? defaultModelName : null) ||
        DEFAULT_PROVIDER_MODELS[target.provider] ||
        defaultModelName
    );
}

function checkTargetLimits(
    target: { provider: string; modelName?: string },
    defaultModelName: string,
    prompt: string,
    systemInstruction: string | undefined,
    maxBudgetWait: number,
    groqMode?: 'chat' | 'morning',
    primaryProvider?: string
): {
    ok: boolean;
    targetModel: string;
    reason?: string;
    needsBudgetWait?: boolean;
    estimatedTokens: number;
    estimatedWaitMs: number;
} {
    const targetModel = primaryProvider
        ? resolveTargetModelName(target, primaryProvider, defaultModelName)
        : (target.modelName || defaultModelName);
    const knownSkip = globalProviderLimiter.getSkipReason(String(target.provider), targetModel);
    const promptCharCap = target.provider === 'groq' ? groqPromptCharCap(groqMode) : prompt.length;
    const effectivePrompt = target.provider === 'groq' && prompt.length > promptCharCap
        ? prompt.slice(0, promptCharCap)
        : prompt;
    const payloadToEstimate = systemInstruction
        ? `${systemInstruction}\n${effectivePrompt}`
        : effectivePrompt;
    const estimatedTokens = estimateTokens(payloadToEstimate);
    if (globalProviderLimiter.exceedsTokenBudgetCapacity(String(target.provider), estimatedTokens, targetModel)) {
        return {
            ok: false,
            targetModel,
            reason: knownSkip || PROMPT_EXCEEDS_LIMIT_REASON,
            needsBudgetWait: false,
            estimatedTokens,
            estimatedWaitMs: UNSATISFIABLE_BUDGET_WAIT_MS
        };
    }
    const limiterWait = globalProviderLimiter.budgetWaitMs(String(target.provider), estimatedTokens, targetModel);
    const managerWait = globalTokenBudgetManager.canAllocate(target.provider as any, estimatedTokens, targetModel)
        ? 0
        : globalTokenBudgetManager.estimateWaitMs(target.provider as any, estimatedTokens, targetModel);
    const estimatedWaitMs = Math.max(limiterWait, managerWait);

    if (knownSkip || !Number.isFinite(limiterWait) || limiterWait >= UNSATISFIABLE_BUDGET_WAIT_MS || limiterWait > maxBudgetWait) {
        const waitReason = !Number.isFinite(limiterWait) || limiterWait >= UNSATISFIABLE_BUDGET_WAIT_MS
            ? PROMPT_EXCEEDS_LIMIT_REASON
            : `skipped_tpm_wait: ${Math.ceil(limiterWait)}ms`;
        return {
            ok: false,
            targetModel,
            reason: knownSkip || waitReason,
            needsBudgetWait: false,
            estimatedTokens,
            estimatedWaitMs
        };
    }
    if (!globalTokenBudgetManager.canAllocate(target.provider as any, estimatedTokens, targetModel)) {
        if (managerWait > maxBudgetWait) {
            return {
                ok: false,
                targetModel,
                reason: `skipped_tpm_wait: ${Math.ceil(managerWait)}ms`,
                needsBudgetWait: false,
                estimatedTokens,
                estimatedWaitMs
            };
        }
        return {
            ok: false,
            targetModel,
            reason: `token budget remaining ${globalTokenBudgetManager.getRemainingBudget(target.provider as any, targetModel)} < ${estimatedTokens}; shifting seat`,
            needsBudgetWait: true,
            estimatedTokens,
            estimatedWaitMs
        };
    }
    return { ok: true, targetModel, estimatedTokens, estimatedWaitMs };
}

function hasHealthyFastAlternative(
    targetChain: ProviderCredential[],
    currentIndex: number,
    primaryProvider: string,
    defaultModelName: string,
    prompt: string,
    systemInstruction: string | undefined,
    groqMode?: 'chat' | 'morning'
): boolean {
    for (let j = currentIndex + 1; j < targetChain.length; j++) {
        const cand = targetChain[j];
        const candModel = resolveTargetModelName(cand, primaryProvider, defaultModelName);
        if (isModelDead(String(cand.provider), candModel)) continue;
        const candCheck = checkTargetLimits(
            cand,
            defaultModelName,
            prompt,
            systemInstruction,
            FAILOVER_MAX_TPM_WAIT_MS,
            groqMode,
            primaryProvider
        );
        if (candCheck.ok && candCheck.estimatedWaitMs <= FAILOVER_MAX_TPM_WAIT_MS) {
            return true;
        }
    }
    return false;
}

export class Agent {
    public role: string;
    public modelName: string;
    public provider: Provider;
    public id?: string;
    public maxTokens?: number;
    private apiKey: string;
    private aiClient?: GoogleGenAI;
    private systemInstruction?: string;
    private fallbacks: ProviderCredential[] = [];
    private loadBalancer?: AdaptiveLoadBalancer;
    /** PS3: when true, fallbacks run in the given order (manager chain) instead of load-balancer score order. */
    public preserveFallbackOrder = false;
    public disableFallback = false;

    constructor(
        role: string,
        modelName: string,
        provider: Provider,
        apiKey: string,
        aiClient?: GoogleGenAI,
        fallbacks: ProviderCredential[] = [],
        loadBalancer?: AdaptiveLoadBalancer,
        id?: string,
        maxTokens?: number
    ) {
        this.role = role;
        this.modelName = modelName;
        this.provider = provider;
        this.apiKey = apiKey;
        this.aiClient = aiClient;
        this.fallbacks = [...fallbacks];
        this.loadBalancer = loadBalancer;
        this.id = id;
        this.maxTokens = maxTokens;
    }

    setSystemInstruction(instruction: string): void {
        this.systemInstruction = instruction;
    }

    getSystemInstruction(): string | undefined {
        return this.systemInstruction;
    }

    setFallbacks(fallbacks: ProviderCredential[]): void {
        this.fallbacks = [...fallbacks];
    }

    addFallback(fallback: ProviderCredential): void {
        this.fallbacks.push(fallback);
    }

    getFallbacks(): ProviderCredential[] {
        return [...this.fallbacks];
    }

    async run(prompt: string, context: SwarmContext, config?: AgentRunConfig): Promise<any> {
        const startTime = Date.now();
        const eventRole = config?.agentRoleOverride || this.role;
        const roleNorm = this.role.toLowerCase();
        const isCriticRole = roleNorm.includes('critic') || roleNorm.includes('risk');
        const isQuantRole = roleNorm.includes('quant') || this.id === 'a1';
        const rawTimeoutMs = config?.timeoutMs || (isCriticRole ? 45000 : (isQuantRole ? 30000 : PROVIDER_CALL_TIMEOUT_MS));
        const timeoutMs = isQuantRole ? Math.min(rawTimeoutMs, 30000) : rawTimeoutMs; // Fresh budget per target in targetChain (NVIDIA a1 further capped to 15s below)

        const lb = (config?.loadBalancer as AdaptiveLoadBalancer) || this.loadBalancer || globalLoadBalancer;
        const candidateFallbacks =
            Array.isArray(config?.fallbackProviders) && config.fallbackProviders.length > 0
                ? config.fallbackProviders
                : this.fallbacks;
        const sortedFallbacks = candidateFallbacks.length > 1 && !this.preserveFallbackOrder
            ? [...candidateFallbacks].sort((a, b) => lb.calculateScore(b.provider) - lb.calculateScore(a.provider))
            : candidateFallbacks;

        const targetChain: ProviderCredential[] = [
            { provider: this.provider, modelName: this.modelName, apiKey: this.apiKey, aiClient: this.aiClient },
            ...sortedFallbacks
        ];

        context.addEvent({
            agentRole: eventRole,
            action: 'Started execution',
            modelName: `${this.provider} / ${this.modelName}`,
            prompt
        });

        let lastError: any = null;
        let lastFailedProvider = this.provider;
        let lastFailedModel = this.modelName;

        for (let targetIdx = 0; targetIdx < targetChain.length; targetIdx++) {
            const currentTarget = targetChain[targetIdx];
            const isFallback = targetIdx > 0;
            const targetModel = currentTarget.modelName || (currentTarget.provider === this.provider ? this.modelName : null) || DEFAULT_PROVIDER_MODELS[currentTarget.provider] || this.modelName;
            // A model the probe proved dead (404) is skipped, even if it is assigned
            // to this seat. The probe never opens the seat circuit; seats read its mark.
            if (isModelDead(String(currentTarget.provider), targetModel)) {
                lastFailedProvider = String(currentTarget.provider);
                lastFailedModel = targetModel;
                lastError = new Error(`model marked dead by catalog probe`);
                let deadFallback: ProviderCredential | undefined;
                let deadFallbackModel = '';
                for (let j = targetIdx + 1; j < targetChain.length; j++) {
                    const cand = targetChain[j];
                    const candModel = resolveTargetModelName(cand, String(this.provider), this.modelName);
                    if (isModelDead(String(cand.provider), candModel)) continue;
                    if (!globalProviderLimiter.getSkipReason(String(cand.provider), candModel)) {
                        deadFallback = cand;
                        deadFallbackModel = candModel;
                        break;
                    }
                }
                if (deadFallback) {
                    recordRunDebugFailover(
                        (context as any)?.id,
                        this.role,
                        String(deadFallback.provider),
                        seatBudget(String(deadFallback.provider)).maxPromptChars
                    );
                }
                context.addEvent({
                    agentRole: eventRole,
                    action: 'Provider Skipped',
                    modelName: `${currentTarget.provider}/${targetModel}`,
                    prompt: `Skipped provider target: model marked dead by catalog probe`,
                    durationMs: 0,
                    failover: {
                        fromProvider: String(currentTarget.provider),
                        fromModel: targetModel,
                        ...(deadFallback ? { toProvider: String(deadFallback.provider), toModel: deadFallbackModel } : {}),
                        status: null,
                        reason: 'dead_model',
                        errorSnippet: 'model marked dead by catalog probe',
                        durationMs: 0
                    },
                    output: {
                        provider: currentTarget.provider,
                        model: targetModel,
                        fromProvider: String(currentTarget.provider),
                        fromModel: targetModel,
                        ...(deadFallback ? { toProvider: String(deadFallback.provider), toModel: deadFallbackModel } : {}),
                        reason: 'model marked dead by catalog probe',
                        errorSnippet: 'model marked dead by catalog probe',
                        durationMs: 0
                    }
                });
                continue;
            }
            // Don't call a provider the limiter already knows will refuse. A circuit,
            // a dead model, or a token budget that needs more than the wait cap is not
            // an error worth logging: move to the next target.
            // Hard failover wait cap (5000ms): if this candidate needs > 5s of TPM wait AND
            // another healthy failover provider has <= 5s wait, immediately skip without sleeping.
            const baseMaxBudgetWait = config?.interactive
                ? INTERACTIVE_MAX_BUDGET_WAIT_MS
                : (config?.maxBudgetWaitMs ?? DEFAULT_STRICT_BUDGET_WAIT_MS);
            const hasFastBackup = isFallback && hasHealthyFastAlternative(
                targetChain,
                targetIdx,
                String(this.provider),
                this.modelName,
                prompt,
                this.systemInstruction,
                config?.groqMode
            );
            const maxBudgetWait = hasFastBackup
                ? Math.min(baseMaxBudgetWait, FAILOVER_MAX_TPM_WAIT_MS)
                : baseMaxBudgetWait;
            const preCheck = checkTargetLimits(
                currentTarget,
                this.modelName,
                prompt,
                this.systemInstruction,
                maxBudgetWait,
                config?.groqMode,
                String(this.provider)
            );
            if (!preCheck.ok) {
                if (!preCheck.needsBudgetWait) {
                    const skipReason = preCheck.reason || 'skipped by limiter/budget';
                    if (skipReason.startsWith('skipped_tpm_wait:')) {
                        console.warn(`[${this.role}][${currentTarget.provider}/${preCheck.targetModel}] ${skipReason}`);
                    }
                    const isBillingCooldownSkip = skipReason.includes('[BILLING_COOLDOWN_SKIP]');
                    const isCooldownSkip = !isBillingCooldownSkip && skipReason.includes('[COOLDOWN_SKIP]');
                    let nextHealthyFallback: ProviderCredential | undefined;
                    let nextHealthyFallbackModel = '';
                    for (let j = targetIdx + 1; j < targetChain.length; j++) {
                        const cand = targetChain[j];
                        const candModel = resolveTargetModelName(cand, String(this.provider), this.modelName);
                        if (isModelDead(String(cand.provider), candModel)) continue;
                        if (!globalProviderLimiter.getSkipReason(String(cand.provider), candModel)) {
                            nextHealthyFallback = cand;
                            nextHealthyFallbackModel = candModel;
                            break;
                        }
                    }
                    if (nextHealthyFallback) {
                        recordRunDebugFailover(
                            (context as any)?.id,
                            this.role,
                            String(nextHealthyFallback.provider),
                            seatBudget(String(nextHealthyFallback.provider)).maxPromptChars
                        );
                    }
                    lastFailedProvider = String(currentTarget.provider);
                    lastFailedModel = preCheck.targetModel;
                    lastError = new Error(skipReason);
                    const redactedSkipReason = redactErrorSnippet(skipReason);
                    const resolvedReason = isBillingCooldownSkip
                        ? '[BILLING_COOLDOWN_SKIP]'
                        : (isCooldownSkip ? '[COOLDOWN_SKIP]' : skipReason);
                    context.addEvent({
                        agentRole: eventRole,
                        action: 'Provider Skipped',
                        modelName: `${currentTarget.provider}/${preCheck.targetModel}`,
                        prompt: `Skipped provider target: ${skipReason}`,
                        durationMs: 0,
                        failover: {
                            fromProvider: String(currentTarget.provider),
                            fromModel: preCheck.targetModel,
                            ...(nextHealthyFallback ? { toProvider: String(nextHealthyFallback.provider), toModel: nextHealthyFallbackModel } : {}),
                            status: null,
                            reason: resolvedReason,
                            errorSnippet: redactedSkipReason,
                            durationMs: 0
                        },
                        output: {
                            provider: currentTarget.provider,
                            model: preCheck.targetModel,
                            fromProvider: String(currentTarget.provider),
                            fromModel: preCheck.targetModel,
                            ...(nextHealthyFallback ? { toProvider: String(nextHealthyFallback.provider), toModel: nextHealthyFallbackModel } : {}),
                            reason: resolvedReason,
                            errorSnippet: redactedSkipReason,
                            durationMs: 0,
                            ...(skipReason.startsWith('skipped_tpm_wait:')
                                ? { skipped_tpm_wait: Math.ceil(preCheck.estimatedWaitMs) }
                                : {})
                        }
                    });
                    continue;
                }

                const waitMs = Math.min(
                    maxBudgetWait,
                    Math.max(
                        globalProviderLimiter.budgetWaitMs(String(currentTarget.provider), preCheck.estimatedTokens, preCheck.targetModel),
                        preCheck.estimatedWaitMs || 0
                    )
                );
                if (Number.isFinite(waitMs) && waitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
                if (!globalTokenBudgetManager.canAllocate(currentTarget.provider, preCheck.estimatedTokens, preCheck.targetModel)) {
                    const reason = `token budget remaining ${globalTokenBudgetManager.getRemainingBudget(currentTarget.provider, preCheck.targetModel)} < ${preCheck.estimatedTokens}; shifting seat`;
                    let budgetFallback: ProviderCredential | undefined;
                    let budgetFallbackModel = '';
                    for (let j = targetIdx + 1; j < targetChain.length; j++) {
                        const cand = targetChain[j];
                        const candModel = resolveTargetModelName(cand, String(this.provider), this.modelName);
                        if (isModelDead(String(cand.provider), candModel)) continue;
                        if (!globalProviderLimiter.getSkipReason(String(cand.provider), candModel)) {
                            budgetFallback = cand;
                            budgetFallbackModel = candModel;
                            break;
                        }
                    }
                    if (budgetFallback) {
                        recordRunDebugFailover(
                            (context as any)?.id,
                            this.role,
                            String(budgetFallback.provider),
                            seatBudget(String(budgetFallback.provider)).maxPromptChars
                        );
                    }
                    const redactedBudgetReason = redactErrorSnippet(reason);
                    lastFailedProvider = String(currentTarget.provider);
                    lastFailedModel = preCheck.targetModel;
                    lastError = new Error(reason);
                    context.addEvent({
                        agentRole: eventRole,
                        action: 'Provider Skipped',
                        modelName: `${currentTarget.provider}/${preCheck.targetModel}`,
                        prompt: `Skipped provider target: ${reason}`,
                        durationMs: Math.max(0, Math.round(waitMs || 0)),
                        failover: {
                            fromProvider: String(currentTarget.provider),
                            fromModel: preCheck.targetModel,
                            ...(budgetFallback ? { toProvider: String(budgetFallback.provider), toModel: budgetFallbackModel } : {}),
                            status: null,
                            reason: 'LIMITER_SKIP',
                            errorSnippet: redactedBudgetReason,
                            durationMs: Math.max(0, Math.round(waitMs || 0))
                        },
                        output: {
                            provider: currentTarget.provider,
                            model: preCheck.targetModel,
                            fromProvider: String(currentTarget.provider),
                            fromModel: preCheck.targetModel,
                            ...(budgetFallback ? { toProvider: String(budgetFallback.provider), toModel: budgetFallbackModel } : {}),
                            reason,
                            errorSnippet: redactedBudgetReason,
                            durationMs: Math.max(0, Math.round(waitMs || 0))
                        }
                    });
                    continue;
                }
            }
            // Two attempts max: fail fast on free-tier stalls. Fatal (4xx) errors
            // never recover by retrying; transient (429/5xx/timeout) errors either
            // fail over immediately (when a backup exists) or get one quick retry.
            // S3.2: a1/Quant on NVIDIA uses a single-attempt 30s timeout so stalls fail over immediately.
            // config.noRetry (startup benchmark): one attempt per target, so a 429 is never retried.
            const maxRetries = (config?.noRetry || (isQuantRole && currentTarget.provider === 'nvidia')) ? 1 : 2;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                const attemptStartTime = Date.now();
                try {
                    const adapter = ProviderRegistry.get(currentTarget.provider);
                    
                    const roleLower = this.role.toLowerCase();
                    const isNvidiaReasoningTarget =
                        currentTarget.provider === 'nvidia' &&
                        /nemotron|deepseek-r1|qwq/i.test(targetModel);
                    const isGeminiThinkingTarget =
                        currentTarget.provider === 'gemini' &&
                        isGemini3Or4Model(targetModel) &&
                        roleLower !== 'catalog-probe';
                    const defaultRoleTokens = roleLower.includes('grader') ? 60
                        : roleLower.includes('prompt generator') ? 300
                        : roleLower.includes('manager') ? 2000
                        : (isNvidiaReasoningTarget || isGeminiThinkingTarget) ? 4096
                        : isQuantRole ? 1800
                        : 1500;

                    const requestedTokens = config?.maxTokens ?? this.maxTokens ?? defaultRoleTokens;
                    const effectiveMaxTokens = (isNvidiaReasoningTarget || isGeminiThinkingTarget)
                        ? Math.max(requestedTokens, 4096)
                        : (isQuantRole ? Math.min(requestedTokens, 1800) : requestedTokens);
                    const effectiveConfig: AgentRunConfig = {
                        ...config,
                        maxTokens: effectiveMaxTokens
                    };
                    const isStrictJsonRequest =
                        effectiveConfig.responseMimeType === 'application/json' ||
                        Boolean(effectiveConfig.zodSchema || (effectiveConfig as any)?.responseSchema || (effectiveConfig as any)?.schema);

                    let effectiveRuntimeConfig: AgentRunConfig;
                    if (isStrictJsonRequest) {
                        const { tools: _discardTools, toolChoice: _discardToolChoice, toolRegistry: _discardRegistry, ...restConfig } = effectiveConfig as any;
                        effectiveRuntimeConfig = restConfig;
                    } else {
                        const rawNativeTools = Array.isArray(effectiveConfig.tools)
                            ? effectiveConfig.tools
                            : (effectiveConfig.toolRegistry && typeof (effectiveConfig.toolRegistry as any).toOpenAiTools === 'function'
                                ? (effectiveConfig.toolRegistry as any).toOpenAiTools()
                                : undefined);
                        const nativeTools = Array.isArray(rawNativeTools)
                            ? rawNativeTools.filter((t: any) => !isBlockedBuiltinTool(t?.function?.name ?? t?.name ?? ''))
                            : undefined;
                        const requestedToolChoice = effectiveConfig.toolChoice;
                        const resolvedToolChoice = !requestedToolChoice || String(requestedToolChoice).toLowerCase().trim() === 'none'
                            ? 'auto'
                            : requestedToolChoice;
                        if (nativeTools && nativeTools.length > 0) {
                            effectiveRuntimeConfig = {
                                ...effectiveConfig,
                                tools: nativeTools,
                                toolChoice: resolvedToolChoice
                            };
                        } else {
                            const { tools: _discardTools, toolChoice: _discardToolChoice, ...restConfig } = effectiveConfig as any;
                            effectiveRuntimeConfig = restConfig;
                        }
                    }

                    const cacheFingerprint = PayloadCache.computeFingerprint(
                        `agent_run:${this.role}`,
                        prompt,
                        { model: currentTarget.modelName || this.modelName, maxTokens: effectiveConfig.maxTokens }
                    );
                    
                    let textOutput: string;
                    const cachedText = effectiveConfig.bypassCache ? null : globalPayloadCache.get<string>(cacheFingerprint);
                    
                    if (cachedText) {
                        textOutput = cachedText;
                        
                        const cacheHitEvent = {
                            agentRole: eventRole,
                            action: 'Cache Hit',
                            modelName: `${currentTarget.provider} / ${currentTarget.modelName || this.modelName}`,
                            prompt: `[CACHE HIT] ${prompt.substring(0, 100)}...`
                        };
                        context.addEvent(cacheHitEvent);
                        SwarmTracer.getInstance().logEvent(cacheHitEvent);
                    } else {
                        const targetModel = currentTarget.modelName || (currentTarget.provider === this.provider ? this.modelName : null) || DEFAULT_PROVIDER_MODELS[currentTarget.provider] || this.modelName;
                        // Budget estimate (chars/4) uses what the adapter will actually send: Groq caps the prompt by mode (chat 18k / morning 6k).
                        const promptCharCap = currentTarget.provider === 'groq' ? groqPromptCharCap(effectiveConfig.groqMode) : prompt.length;
                        const effectivePrompt = currentTarget.provider === 'groq' && prompt.length > promptCharCap
                            ? prompt.slice(0, promptCharCap)
                            : prompt;
                        const payloadToEstimate = this.systemInstruction
                            ? `${this.systemInstruction}\n${effectivePrompt}`
                            : effectivePrompt;
                        textOutput = await globalProviderLimiter.run(
                            {
                                provider: String(currentTarget.provider),
                                model: targetModel,
                                estTokens: estimateTokens(payloadToEstimate),
                                maxBudgetWaitMs: maxBudgetWait
                            },
                            () => lb.executeWithTelemetry(
                                currentTarget.provider,
                                async () => {
                                    let capturedHeaders: any = null;
                                    const isNonGoogleFastTimeoutProvider =
                                        currentTarget.provider === 'nvidia' ||
                                        currentTarget.provider === 'cloudflare' ||
                                        currentTarget.provider === 'groq' ||
                                        currentTarget.provider === 'openrouter';
                                    const isA1HydrogenTarget =
                                        isQuantRole &&
                                        currentTarget.provider === 'gemini' &&
                                        /gemini-4-hydrogen/i.test(targetModel);
                                    const isQuantNvidiaTarget =
                                        currentTarget.provider === 'nvidia' &&
                                        (isQuantRole || /nemotron.*ultra|550b/i.test(targetModel));
                                    const isProposerGeminiTarget =
                                        currentTarget.provider === 'gemini' &&
                                        (this.id === 'a1' || this.id === 'a2' || /\b(?:quant|market)\s*proposer\b|\bquant\b|\bmarket\s*analyst\b/i.test(this.role || ''));
                                    const targetTimeoutMs = isA1HydrogenTarget
                                        ? Math.min(timeoutMs, 20000)
                                        : (isNonGoogleFastTimeoutProvider
                                            ? Math.min(isQuantNvidiaTarget ? Math.min(timeoutMs, 15000) : timeoutMs, 18000)
                                            : (isProposerGeminiTarget ? Math.min(timeoutMs, 15000) : timeoutMs));
                                    const effectiveCallConfig = (() => {
                                        if (currentTarget.provider === 'groq' && isGroqGptOss120b(targetModel) && isManagerSeatRole(this.role, this.id)) {
                                            const cappedEffort = resolveGroqGptOss120bReasoningEffort({
                                                role: this.role,
                                                agentId: this.id,
                                                config: effectiveRuntimeConfig as Record<string, any> | undefined
                                            });
                                            return {
                                                ...effectiveRuntimeConfig,
                                                reasoning_effort: cappedEffort,
                                                ...(effectiveRuntimeConfig?.reasoning
                                                    ? { reasoning: { ...effectiveRuntimeConfig.reasoning, effort: cappedEffort } }
                                                    : {})
                                            };
                                        }
                                        if (currentTarget.provider !== 'gemini') return effectiveRuntimeConfig;
                                        const hasExplicitLevel = Boolean(
                                            (effectiveRuntimeConfig as any)?.thinkingLevel ||
                                            (effectiveRuntimeConfig as any)?.thinking_level ||
                                            (effectiveRuntimeConfig as any)?.thinkingConfig?.thinkingLevel ||
                                            (effectiveRuntimeConfig as any)?.thinkingConfig?.thinking_level
                                        );
                                        if (hasExplicitLevel) return effectiveRuntimeConfig;
                                        if (isQuantRole && String(targetModel || '').toLowerCase().includes('gemini-3.5-flash-lite')) {
                                            return { ...effectiveRuntimeConfig, thinkingLevel: 'medium' };
                                        }
                                        if (roleNorm.includes('manager') || isCriticRole || roleNorm.includes('verifier')) {
                                            return { ...effectiveRuntimeConfig, thinkingLevel: 'low' };
                                        }
                                        return effectiveRuntimeConfig;
                                    })();
                                    const out = await adapter.call({
                                        modelName: targetModel,
                                        prompt,
                                        systemInstruction: this.systemInstruction,
                                        apiKey: currentTarget.apiKey,
                                        aiClient: currentTarget.aiClient || this.aiClient,
                                        config: effectiveCallConfig,
                                        timeoutMs: targetTimeoutMs,
                                        role: this.role,
                                        agentId: this.id,
                                        onHeaders: (headers) => {
                                            capturedHeaders = headers;
                                            globalTokenBudgetManager.applyProviderHeaders(currentTarget.provider, headers, targetModel);
                                        }
                                    });
                                    if (capturedHeaders) {
                                        globalTokenBudgetManager.applyProviderHeaders(currentTarget.provider, capturedHeaders, targetModel);
                                    }
                                    return out;
                                }
                            )
                        );
                    }

                    if (textOutput.trim() === '') {
                        if (!effectiveConfig.bypassCache) {
                            globalPayloadCache.invalidate(cacheFingerprint);
                        }
                        throw new Error(`[EMPTY_COMPLETION] ${currentTarget.provider}/${targetModel} returned blank output`);
                    }
                    if (!cachedText) {
                        globalPayloadCache.set(cacheFingerprint, textOutput);
                    }

                    const durationMs = Date.now() - startTime;
                    let parsedOutput: any = textOutput;
                    let validationSuccess = true;

                    if (config?.responseMimeType === 'application/json' || config?.zodSchema) {
                        if (textOutput.includes('```tool_call') || textOutput.includes('[TOOL_CALL') || textOutput.includes('[TOOL_EXECUTION')) {
                            parsedOutput = textOutput;
                        } else {
                            const { data: candidate, repaired: parseRepaired } = parseJsonSafeWithStatus(textOutput);
                            const hasParsedKeys = candidate && typeof candidate === 'object' && (
                                Array.isArray(candidate) ? candidate.length > 0 : Object.keys(candidate).length > 0
                            );
                            // S2/S3: Treat unparsed/truncated non-JSON output on proposer seats (a1/a2) as parse_failed
                            // and trigger failover/retry instead of returning status: "ok" with truncated prose & picks: [].
                            const isProposerSeat =
                                this.id === 'a1' ||
                                this.id === 'a2' ||
                                /\b(?:quant|market)\s*proposer\b|\bquant\b|\bmarket\s*analyst\b/i.test(this.role || '');
                            const hasNativeToolCallInText =
                                typeof textOutput === 'string' &&
                                /"tool"\s*:|"tool_calls"\s*:|get_(?:matchup|injury|market|environment|player_prop|historical)/i.test(textOutput);
                            const rawTrimmedForTrunc = typeof textOutput === 'string' ? textOutput.trim() : '';
                            const hasTruncatedJson =
                                Boolean(rawTrimmedForTrunc) &&
                                (rawTrimmedForTrunc.startsWith('{') || rawTrimmedForTrunc.startsWith('[')) &&
                                extractLargestValidJson(rawTrimmedForTrunc) === null;
                            const missingProposerFieldsAfterRepair =
                                parseRepaired &&
                                !Array.isArray((candidate as any)?.scorecards) &&
                                (
                                    (hasTruncatedJson && (!Array.isArray((candidate as any)?.picks) || (candidate as any).picks.length === 0)) ||
                                    (
                                        !Array.isArray((candidate as any)?.picks) &&
                                        (!Array.isArray((candidate as any)?.insights) || (candidate as any).insights.length === 0)
                                    )
                                );
                            if (
                                (!hasParsedKeys || missingProposerFieldsAfterRepair) &&
                                isProposerSeat &&
                                !hasNativeToolCallInText &&
                                (targetIdx < targetChain.length - 1 || attempt < maxRetries)
                            ) {
                                const rawSnippet = redactErrorSnippet(textOutput || 'empty response', 120);
                                const parseErr: any = new Error(`[PARSE_FAILED:unparsed_json] ${rawSnippet}`);
                                parseErr.reason = 'unparsed_json';
                                parseErr.parseFailed = true;
                                parseErr.rawSnippet = rawSnippet;
                                throw parseErr;
                            }
                            parsedOutput = hasParsedKeys ? candidate : textOutput;
                            
                            if (config?.zodSchema) {
                                let parsed = config.zodSchema.safeParse(parsedOutput);
                                if (!parsed.success) {
                                    // Resilient schema repair before declaring validation failure
                                    if (
                                        config.zodSchema === ManagerResponseSchema ||
                                        (parsedOutput && typeof parsedOutput === 'object' && ('components' in (parsedOutput as any) || 'ui_title' in (parsedOutput as any)))
                                    ) {
                                        try {
                                            const repaired = guardManagerResponse(parsedOutput);
                                            parsed = config.zodSchema.safeParse(repaired);
                                        } catch {
                                            // Fall through to error reporting
                                        }
                                    } else if (
                                        config.zodSchema === AnalystResponseSchema ||
                                        (parsedOutput && typeof parsedOutput === 'object' && ('insights' in (parsedOutput as any) || 'anomalies' in (parsedOutput as any) || 'findings' in (parsedOutput as any)))
                                    ) {
                                        try {
                                            const repaired = guardAnalystResponse(parsedOutput, this.role);
                                            parsed = config.zodSchema.safeParse(repaired);
                                        } catch {
                                            // Fall through to error reporting
                                        }
                                    }
                                }

                                if (!parsed.success) {
                                    const errors = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ');
                                    validationSuccess = false;
                                    
                                    // Tracing the validation error
                                    const valErrorEvent = {
                                        agentRole: eventRole,
                                        action: 'Schema Validation Failed',
                                        modelName: `${currentTarget.provider} / ${currentTarget.modelName || this.modelName}`,
                                        prompt,
                                        error: `Zod Error: ${errors}`
                                    };
                                    context.addEvent(valErrorEvent);
                                    SwarmTracer.getInstance().logEvent(valErrorEvent);

                                    throw new Error(`SCHEMA_VALIDATION_FAILED: ${errors}`);
                                } else {
                                    parsedOutput = parsed.data;
                                }
                            }
                        }
                    }

                    const eventBase = {
                        agentRole: eventRole,
                        action: isFallback ? `Completed execution via failover (${currentTarget.provider})` : 'Completed execution',
                        modelName: `${currentTarget.provider} / ${currentTarget.modelName || this.modelName}`,
                        prompt,
                        output: parsedOutput,
                        durationMs
                    };
                    context.addEvent(eventBase);
                    SwarmTracer.getInstance().logEvent(eventBase);

                    return parsedOutput;
                } catch (err: any) {
                    lastError = err;
                    lastFailedProvider = currentTarget.provider;
                    lastFailedModel = currentTarget.modelName || this.modelName;
                    const errMsg = err?.message || String(err);
                    const errLower = errMsg.toLowerCase();
                    console.warn(`[${this.role}][${currentTarget.provider}] Attempt ${attempt}/${maxRetries} failed:`, errMsg);

                    // Auto-correction for schema failures (retry same provider once)
                    if (errMsg.includes('SCHEMA_VALIDATION_FAILED') && attempt < maxRetries) {
                        prompt = `${prompt}\n\n[SYSTEM: Your previous response failed schema validation. Please correct the following errors and output STRICT JSON only: ${errMsg}]`;
                        continue;
                    }

                    const isParseFailure = Boolean(err?.parseFailed) || /\[PARSE_FAILED:(?:unparsed_json|max_tokens)\]/i.test(errMsg);
                    const httpStatus = isParseFailure ? null : extractHttpStatus(err);
                    const errorSnippet = isParseFailure
                        ? redactErrorSnippet(err?.rawSnippet || errMsg.replace(/^\[PARSE_FAILED:[^\]]+\]\s*/i, ''), 120)
                        : redactErrorSnippet(err, 160);
                    const failoverReason = typeof err?.reason === 'string' && err.reason.trim()
                        ? err.reason.trim()
                        : errorSnippet;
                    const attemptDurationMs = Math.max(0, Date.now() - attemptStartTime);
                    const errorEvent = {
                        agentRole: eventRole,
                        action: `Provider Failover Triggered`,
                        modelName: `${currentTarget.provider} / ${targetModel}`,
                        prompt,
                        error: errorSnippet,
                        durationMs: attemptDurationMs,
                        output: {
                            fromProvider: String(currentTarget.provider),
                            fromModel: targetModel,
                            status: httpStatus,
                            errorSnippet,
                            reason: failoverReason,
                            durationMs: attemptDurationMs
                        },
                        failover: {
                            fromProvider: String(currentTarget.provider),
                            fromModel: targetModel,
                            status: httpStatus,
                            errorSnippet,
                            reason: failoverReason,
                            durationMs: attemptDurationMs
                        }
                    };
                    context.addEvent(errorEvent);
                    SwarmTracer.getInstance().logEvent(errorEvent);

                    const isLimiterSkip = errMsg.includes('[LIMITER_SKIP]');
                    const isRateLimit429 =
                        httpStatus === 429 ||
                        errMsg.includes('429') ||
                        errMsg.includes('RATE_LIMIT') ||
                        errLower.includes('rate limit') ||
                        errLower.includes('quota') ||
                        errMsg.includes('RESOURCE_EXHAUSTED');

                    const isTransientRateLimitOrSkip = isRateLimit429 || isLimiterSkip;

                    const effectiveDisableFallback = Boolean(
                        this.disableFallback ||
                        config?.disableFallback ||
                        (config as any)?.disableFallback
                    );

                    // Never disable provider fallbacks on transient rate limits (429) or limiter skips even if disableFallback is toggled
                    if (effectiveDisableFallback && !isTransientRateLimitOrSkip) {
                        targetIdx = targetChain.length;
                        break;
                    }

                    const isQuotaExhausted =
                        errMsg.includes('RESOURCE_EXHAUSTED') ||
                        errLower.includes('quota') ||
                        ((httpStatus === 429 || errMsg.includes('429')) && errLower.includes('quota'));

                    const isFailoverEligible =
                        isTransientRateLimitOrSkip ||
                        isParseFailure ||
                        (httpStatus !== null && httpStatus >= 500) ||
                        errMsg.includes('EMPTY_COMPLETION') ||
                        errMsg.includes('503') ||
                        errMsg.includes('502') ||
                        errMsg.includes('504') ||
                        errMsg.includes('500') ||
                        errMsg.includes('SERVER_ERROR') ||
                        errMsg.includes('401') ||
                        errMsg.includes('402') ||
                        errMsg.includes('403') ||
                        errMsg.includes('model_decommissioned') ||
                        errLower.includes('timeout') ||
                        errLower.includes('timed out') || // provider adapters emit "[TIMEOUT] ... timed out after Nms"
                        errLower.includes('tool choice') ||
                        errLower.includes('tool_use_failed') ||
                        errLower.includes('high traffic') ||
                        errLower.includes('overloaded') ||
                        errLower.includes('unavailable') ||
                        errLower.includes('capacity') ||
                        errLower.includes('econnreset') ||
                        errLower.includes('fetch failed');

                    const billingErrorInfo = isBillingOrAuthError(err);
                    const isTimeout =
                        errLower.includes('timeout') ||
                        errLower.includes('timed out') ||
                        err?.name === 'AbortError';
                    if (isTimeout) {
                        globalProviderLimiter.openModelCooldown(
                            String(currentTarget.provider),
                            targetModel,
                            10 * 60 * 1000,
                            `[COOLDOWN_SKIP] timeout after ${attemptDurationMs}ms on ${targetModel}`
                        );
                    }
                    const isFatal =
                        billingErrorInfo.match ||
                        httpStatus === 400 ||
                        httpStatus === 401 ||
                        httpStatus === 402 ||
                        httpStatus === 403 ||
                        httpStatus === 404 ||
                        errMsg.includes('404') ||
                        errMsg.includes('NOT_FOUND') ||
                        errMsg.includes('400') ||
                        errMsg.includes('401') ||
                        errMsg.includes('402') ||
                        errMsg.includes('403') ||
                        errMsg.includes('model_decommissioned') ||
                        errLower.includes('api key not valid') ||
                        errLower.includes('invalid api key') ||
                        errLower.includes('not found') ||
                        errLower.includes('does not exist') ||
                        errLower.includes('unsupported model');

                    if (billingErrorInfo.match && !(currentTarget.provider === 'gemini' && /free_tier/i.test(errMsg) && /\blimit\s*:\s*0\b/i.test(errMsg))) {
                        globalProviderLimiter.recordFailure(
                            String(currentTarget.provider),
                            targetModel,
                            errMsg,
                            true
                        );
                    }

                    const skipGeminiSiblings =
                        currentTarget.provider === 'gemini' && isGeminiProjectWideFailure(err);
                    if (skipGeminiSiblings) {
                        const cooldownMs = (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) ? BILLING_COOLDOWN_MS : MODEL_COOLDOWN_MS;
                        const reasonPrefix = (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) ? '[BILLING_COOLDOWN_SKIP] ' : '';
                        globalProviderLimiter.openProviderCooldown(
                            'gemini',
                            cooldownMs,
                            `${reasonPrefix}gemini project-wide error (${httpStatus ?? 'unknown'}): ${errorSnippet}`
                        );
                    }

                    const hasNextProvider = targetIdx < targetChain.length - 1;

                    if ((isFatal || isLimiterSkip || isTimeout) && !hasNextProvider) {
                        break; // Fatal error, limiter skip, or timeout: zero retry on same target
                    }

                    // If eligible for failover and a backup provider is ready, failover immediately without waiting
                    if ((isFailoverEligible || isFatal || isTimeout || isTransientRateLimitOrSkip || attempt === maxRetries) && hasNextProvider) {
                        let realFallback: typeof currentTarget | undefined;
                        let realFallbackIdx = -1;
                        for (let j = targetIdx + 1; j < targetChain.length; j++) {
                            const cand = targetChain[j];
                            if (skipGeminiSiblings && cand.provider === 'gemini') continue;
                            const candModel = resolveTargetModelName(cand, String(this.provider), this.modelName);
                            if (isModelDead(String(cand.provider), candModel)) continue;
                            const candHasFastBackup = hasHealthyFastAlternative(
                                targetChain,
                                j,
                                String(this.provider),
                                this.modelName,
                                prompt,
                                this.systemInstruction,
                                config?.groqMode
                            );
                            const candMaxWait = candHasFastBackup
                                ? Math.min(baseMaxBudgetWait, FAILOVER_MAX_TPM_WAIT_MS)
                                : baseMaxBudgetWait;
                            if (checkTargetLimits(cand, this.modelName, prompt, this.systemInstruction, candMaxWait, config?.groqMode, String(this.provider)).ok) {
                                realFallback = cand;
                                realFallbackIdx = j;
                                break;
                            }
                        }
                        if (realFallback) {
                            const fallbackModel = resolveTargetModelName(realFallback, String(this.provider), this.modelName);
                            recordRunDebugFailover(
                                (context as any)?.id,
                                this.role,
                                String(realFallback.provider),
                                seatBudget(String(realFallback.provider)).maxPromptChars
                            );
                            context.addEvent({
                                agentRole: eventRole,
                                action: 'Provider Failover Triggered',
                                modelName: `${currentTarget.provider} -> ${realFallback.provider}`,
                                prompt: `Cascading to backup provider due to error: ${errorSnippet}`,
                                durationMs: attemptDurationMs,
                                output: {
                                    fromProvider: String(currentTarget.provider),
                                    fromModel: targetModel,
                                    toProvider: String(realFallback.provider),
                                    toModel: fallbackModel,
                                    failedProvider: currentTarget.provider,
                                    failedModel: targetModel,
                                    fallbackProvider: realFallback.provider,
                                    fallbackModel,
                                    status: httpStatus,
                                    errorSnippet,
                                    reason: failoverReason,
                                    durationMs: attemptDurationMs
                                },
                                failover: {
                                    fromProvider: String(currentTarget.provider),
                                    fromModel: targetModel,
                                    toProvider: String(realFallback.provider),
                                    toModel: fallbackModel,
                                    status: httpStatus,
                                    errorSnippet,
                                    reason: failoverReason,
                                    durationMs: attemptDurationMs
                                }
                            });
                            // S3.1: Jump directly to the chosen non-Gemini fallback in 1 hop
                            if (skipGeminiSiblings && realFallbackIdx > targetIdx + 1) {
                                targetIdx = realFallbackIdx - 1;
                            }
                        } else if (skipGeminiSiblings) {
                            // No non-Gemini fallback available; skip remaining Gemini siblings so loop exits cleanly
                            let lastSkippedIdx = targetIdx;
                            while (lastSkippedIdx + 1 < targetChain.length && targetChain[lastSkippedIdx + 1].provider === 'gemini') {
                                lastSkippedIdx += 1;
                            }
                            targetIdx = lastSkippedIdx;
                        }
                        break; // Exit retry loop to advance to next target in chain
                    }

                    // Quota exhaustion won't recover in seconds — surface immediately if no fallback
                    if (isQuotaExhausted && !hasNextProvider) {
                        break;
                    }

                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, attempt - 1)));
                    }
                }
            }
        }

        const durationMs = Date.now() - startTime;
        const errorEvent = {
            agentRole: eventRole,
            action: 'Failed execution',
            modelName: `${lastFailedProvider} / ${lastFailedModel}`,
            prompt,
            error: lastError?.stack || lastError?.message || String(lastError),
            durationMs
        };
        context.addEvent(errorEvent);
        SwarmTracer.getInstance().logEvent(errorEvent);

        throw lastError;
    }
}
