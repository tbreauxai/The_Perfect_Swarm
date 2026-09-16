import type { GoogleGenAI } from '@google/genai';
import type { Provider, AgentRunConfig, ProviderCredential } from './types.ts';
import { SwarmContext } from './context.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { sanitizeModelOutput } from './providers/adapter.ts';
import { SwarmTracer } from './profiler.ts';
import { globalLoadBalancer, type AdaptiveLoadBalancer } from './loadBalancer.ts';
import { globalPayloadCache, PayloadCache } from './cache.ts';
import { parseJsonSafe } from './parser.ts';

/**
 * Autonomous Swarm Agent decoupled from specific LLM provider implementations.
 * Features:
 * - Dynamic execution via ProviderRegistry adapters
 * - Multi-provider failover cascades on free-tier rate limits (429), timeouts, and 5xx errors
 * - Robust reasoning model sanitization (<think> tag stripping)
 */
export class Agent {
    public role: string;
    public modelName: string;
    public provider: Provider;
    private apiKey: string;
    private aiClient?: GoogleGenAI;
    private systemInstruction?: string;
    private fallbacks: ProviderCredential[] = [];
    private loadBalancer?: AdaptiveLoadBalancer;

    constructor(
        role: string,
        modelName: string,
        provider: Provider,
        apiKey: string,
        aiClient?: GoogleGenAI,
        fallbacks: ProviderCredential[] = [],
        loadBalancer?: AdaptiveLoadBalancer
    ) {
        this.role = role;
        this.modelName = modelName;
        this.provider = provider;
        this.apiKey = apiKey;
        this.aiClient = aiClient;
        this.fallbacks = [...fallbacks];
        this.loadBalancer = loadBalancer;
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
        const timeoutMs = config?.timeoutMs || 120000;

        const lb = (config?.loadBalancer as AdaptiveLoadBalancer) || this.loadBalancer || globalLoadBalancer;
        const candidateFallbacks = config?.fallbackProviders || this.fallbacks;
        const sortedFallbacks = candidateFallbacks.length > 1
            ? [...candidateFallbacks].sort((a, b) => lb.calculateScore(b.provider) - lb.calculateScore(a.provider))
            : candidateFallbacks;

        const targetChain: ProviderCredential[] = [
            { provider: this.provider, modelName: this.modelName, apiKey: this.apiKey, aiClient: this.aiClient },
            ...sortedFallbacks
        ];

        context.addEvent({
            agentRole: this.role,
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
            const maxRetries = 4;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const adapter = ProviderRegistry.get(currentTarget.provider);
                    
                    const cacheFingerprint = PayloadCache.computeFingerprint(
                        `agent_run:${this.role}`,
                        prompt,
                        { model: currentTarget.modelName || this.modelName }
                    );
                    
                    let textOutput: string;
                    const cachedText = globalPayloadCache.get<string>(cacheFingerprint);
                    
                    if (cachedText) {
                        textOutput = cachedText;
                        
                        const cacheHitEvent = {
                            agentRole: this.role,
                            action: 'Cache Hit',
                            modelName: `${currentTarget.provider} / ${currentTarget.modelName || this.modelName}`,
                            prompt: `[CACHE HIT] ${prompt.substring(0, 100)}...`
                        };
                        context.addEvent(cacheHitEvent);
                        SwarmTracer.getInstance().logEvent(cacheHitEvent);
                    } else {
                        textOutput = await lb.executeWithTelemetry(
                            currentTarget.provider,
                            () => adapter.call({
                                modelName: currentTarget.modelName || this.modelName,
                                prompt,
                                systemInstruction: this.systemInstruction,
                                apiKey: currentTarget.apiKey,
                                aiClient: currentTarget.aiClient || this.aiClient,
                                config,
                                timeoutMs
                            })
                        );
                        globalPayloadCache.set(cacheFingerprint, textOutput);
                    }

                    const durationMs = Date.now() - startTime;
                    let parsedOutput: any = textOutput;
                    let validationSuccess = true;

                    if (config?.responseMimeType === 'application/json') {
                        if (textOutput.includes('```tool_call') || textOutput.includes('[TOOL_CALL]')) {
                            parsedOutput = textOutput;
                        } else {
                            parsedOutput = parseJsonSafe(textOutput);
                            
                            if (config?.zodSchema) {
                                const parsed = config.zodSchema.safeParse(parsedOutput);
                                if (!parsed.success) {
                                    const errors = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ');
                                    validationSuccess = false;
                                    
                                    // Tracing the validation error
                                    const valErrorEvent = {
                                        agentRole: this.role,
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
                        agentRole: this.role,
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
                        // Insert the current target back into the chain so we don't skip the next fallback
                        targetChain.splice(targetIdx + 1, 0, currentTarget);
                    }

                    const errorEvent = {
                        agentRole: this.role,
                        action: `Provider Failover Triggered`,
                        modelName: `${currentTarget.provider} / ${currentTarget.modelName || this.modelName}`,
                        prompt,
                        error: errMsg
                    };
                    context.addEvent(errorEvent);
                    SwarmTracer.getInstance().logEvent(errorEvent);

                    const isQuotaExhausted =
                        errMsg.includes('RESOURCE_EXHAUSTED') ||
                        errLower.includes('quota') ||
                        (errMsg.includes('429') && errLower.includes('quota'));

                    const isFailoverEligible = 
                        errMsg.includes('429') ||
                        errMsg.includes('RATE_LIMIT') ||
                        errMsg.includes('503') ||
                        errMsg.includes('502') ||
                        errMsg.includes('504') ||
                        errMsg.includes('500') ||
                        errMsg.includes('SERVER_ERROR') ||
                        errMsg.includes('401') ||
                        errMsg.includes('403') ||
                        errLower.includes('rate limit') ||
                        errLower.includes('quota') ||
                        errLower.includes('timeout') ||
                        errLower.includes('high traffic') ||
                        errLower.includes('overloaded') ||
                        errLower.includes('unavailable') ||
                        errLower.includes('capacity');

                    const isFatal = 
                        errMsg.includes('404') || 
                        errMsg.includes('NOT_FOUND') ||
                        errMsg.includes('400') ||
                        errMsg.includes('401') ||
                        errMsg.includes('403') ||
                        errLower.includes('api key not valid') ||
                        errLower.includes('invalid api key') ||
                        errLower.includes('not found') ||
                        errLower.includes('does not exist') ||
                        errLower.includes('unsupported model');

                    const hasNextProvider = targetIdx < targetChain.length - 1;

                    if (isFatal && !hasNextProvider) {
                        break; // Fatal error (like model not found), don't waste time retrying
                    }

                    // If eligible for failover and a backup provider is ready, failover immediately without waiting
                    if ((isFailoverEligible || isFatal) && hasNextProvider) {
                        const nextTarget = targetChain[targetIdx + 1];
                        context.addEvent({
                            agentRole: this.role,
                            action: 'Provider Failover Triggered',
                            modelName: `${currentTarget.provider} -> ${nextTarget.provider}`,
                            prompt: `Cascading to backup provider due to error: ${errMsg}`,
                            output: {
                                failedProvider: currentTarget.provider,
                                fallbackProvider: nextTarget.provider,
                                reason: errMsg
                            },
                            failover: {
                                fromProvider: String(currentTarget.provider),
                                toProvider: String(nextTarget.provider),
                                reason: errMsg
                            }
                        });
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
            agentRole: this.role,
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
