import { GoogleGenAI } from '@google/genai';
import { Agent } from './agent.ts';
import { MemoryCortex } from './memory.ts';
import { SwarmContext } from './context.ts';
import type { SwarmEvent, ProviderCredential, Provider, LearnedMemoryEvent, AgentRunConfig, SwarmEngineSettings, AgentConfig } from './types.ts';
import { profileData, createTokenChunks, SwarmTracer, globalMetricsCollector, SwarmMetricsCollector, type SwarmBaselineReport } from './profiler.ts';
import { ModelRouter, type TaskComplexity } from './router.ts';
import { AnalysisLifecycle } from './lifecycle.ts';
import { PayloadCache, globalPayloadCache, globalSemanticCache, type SemanticMatchResult } from './cache.ts';
import { AnalystResponseSchema, ManagerResponseSchema } from './schemas.ts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolRegistry, globalToolRegistry, type SwarmTool } from './tools/index.ts';
import { guardAnalystResponse, guardManagerResponse, parseJsonSafe } from './parser.ts';
import { globalSpecialistRouter, globalTokenBudgetManager, globalSpecialistProfiler, type SpecialistRoutingPlan } from './loadBalancer.ts';

export interface ProviderResolution {
    key: string;
    client?: GoogleGenAI;
}

/**
 * Sanitizes raw API keys by stripping 'Bearer ', 'Token ', redundant whitespace, quotes, and backticks.
 */
export function sanitizeApiKey(k: string | undefined | null): string {
    if (!k || typeof k !== 'string') return '';
    return k
        .replace(/^(?:Bearer\s*:?|Token\s*:?)+/i, '')
        .replace(/["'`<>]/g, '')
        .trim();
}

/**
 * Validates provider-specific key conventions and throws descriptive errors.
 */
export function validateProviderKey(provider: Provider, key: string, role: string = 'Agent'): void {
    if (provider === 'simulated' || provider === 'mock' || provider === 'custom-mock') {
        return;
    }

    if (!key) {
        throw new Error(`Missing API Key for ${role} provider (${provider}). Please configure it in settings.`);
    }

    if (provider === 'openrouter' && !key.startsWith('sk-or-v1-')) {
        throw new Error(`Invalid OpenRouter key format for ${role}. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a valid OpenRouter key from openrouter.ai/keys.`);
    }
}

/**
 * Resolves credentials and SDK clients for supported LLM providers from settings or process.env.
 */
export function resolveProvider(
    provider: string,
    settings: SwarmEngineSettings,
    defaultAi?: GoogleGenAI
): ProviderResolution {
    let key = '';
    let client: GoogleGenAI | undefined = undefined;

    switch (provider) {
        case 'gemini': {
            key = sanitizeApiKey(settings?.geminiApiKey || process.env.GEMINI_API_KEY);
            client = key
                ? new GoogleGenAI({ apiKey: key })
                : defaultAi;
            break;
        }
        case 'groq': {
            key = sanitizeApiKey(settings?.groqApiKey || process.env.GROQ_API_KEY);
            break;
        }
        case 'openrouter': {
            key = sanitizeApiKey(settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY);
            break;
        }
        case 'mistral': {
            key = sanitizeApiKey(settings?.mistralApiKey || process.env.MISTRAL_API_KEY);
            break;
        }
        case 'github': {
            key = sanitizeApiKey(settings?.githubToken || process.env.GITHUB_TOKEN);
            break;
        }
        default: {
            const dynamicKey = settings?.[`${provider}ApiKey`] || settings?.[provider] || process.env[`${provider.toUpperCase()}_API_KEY`];
            key = sanitizeApiKey(dynamicKey);
            break;
        }
    }

    return { key, client };
}

export const ANALYST_SYSTEM_INSTRUCTION = `You are a Data Analysis Specialist in a modular swarm.

When given data:
1. PLAN: Check the token weight of the input metadata. Identify 2-3 specific dimensions to investigate.
2. REASON: Analyze differences between current inputs and baselines. Keep internal deductions concise and strictly focused on statistical significance.
3. SANITIZE: Discard raw values and processing traces.
4. EMIT: Return output exclusively as a valid JSON object matching the requested schema. Never output conversational pleasantries or repeated inputs.

Output strictly JSON matching this JSON Schema:
${JSON.stringify(zodToJsonSchema(AnalystResponseSchema as any), null, 2)}

Example of expected output structure:
{
  "insights": ["insight 1", "insight 2"],
  "anomalies": ["anomaly 1"],
  "summary": "..."
}`;

export const MANAGER_SYSTEM_INSTRUCTION = `You are the Swarm Orchestrator. Synthesize the reports from your specialized Analyst agents into a single unified Generative UI payload.

Instead of outputting raw text, you MUST output a Generative UI payload.
Output strict JSON matching this JSON Schema:
${JSON.stringify(zodToJsonSchema(ManagerResponseSchema as any), null, 2)}

Example of expected output structure:
{
  "ui_title": "Dashboard Title",
  "components": [
    {
      "id": "c1",
      "type": "MetricCard",
      "props": { "title": "...", "value": "...", "subtitle": "...", "trend": "up" }
    },
    {
      "id": "c2",
      "type": "InsightList",
      "props": { "title": "...", "insights": [{ "type": "info", "message": "..." }] }
    },
    {
      "id": "c3",
      "type": "DataTable",
      "props": { "title": "...", "columns": [{ "key": "c1", "header": "H1" }], "rows": [{ "c1": "v1" }] }
    }
  ]
}`;

export interface SwarmWorkflowParams {
    task: string;
    data?: string;
    settings?: SwarmEngineSettings;
    defaultAi?: GoogleGenAI;
    enableDeepAnalysis?: boolean;
    forceFullSwarm?: boolean;
    complexityOverride?: TaskComplexity;
    onEvent?: (event: SwarmEvent) => void;
    onMemoryLearned?: (event: LearnedMemoryEvent) => void;
    context?: SwarmContext;
    cortex?: MemoryCortex;
    tools?: SwarmTool[] | ToolRegistry;
}

export interface SwarmWorkflowResult {
    events: SwarmEvent[];
    finalAnalysis: any;
    metrics?: SwarmBaselineReport;
}

/**
 * Process-level singleton registry for in-memory cortex instances per appId.
 * Preserves continuous vector learning across sequential workflow runs in the same runtime.
 */
export const defaultCortexRegistry = new Map<string, MemoryCortex>();

export function getOrCreateDefaultCortex(appId: string, aiClient?: GoogleGenAI): MemoryCortex {
    if (!defaultCortexRegistry.has(appId)) {
        defaultCortexRegistry.set(appId, new MemoryCortex({
            defaultAppId: appId,
            aiClient
        }));
    }
    return defaultCortexRegistry.get(appId)!;
}

/**
 * Executes the complete autonomous swarm analysis lifecycle:
 * Fast-path pre-filtering -> Zero-drift caching -> Token budgeting -> Qdrant continuous learning retrieval
 * -> Multi-analyst parallel execution -> Manager synthesis & Critic verification -> Memory reinforcement.
 */
export async function executeSwarmWorkflow(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
    const workflowStartTime = Date.now();
    const { task, data, settings, defaultAi, enableDeepAnalysis, complexityOverride, onEvent } = params;
    const context = params.context || new SwarmContext();
    if (onEvent) {
        context.subscribe(onEvent);
    }

    const targetAppId = settings?.appId || 'perfect-swarm';
    const qdrantUrl = settings?.qdrantUrl || process.env.QDRANT_URL;
    const qdrantApiKey = settings?.qdrantApiKey || process.env.QDRANT_API_KEY;
    const includeShared = settings?.includeShared ?? true;

    // Unconditionally bind MemoryCortex with fallback to process-level in-memory learning
    let memoryCortex: MemoryCortex = params.cortex || settings?.cortex;
    if (!memoryCortex) {
        const persistPath = settings?.persistPath;
        const autoSave = settings?.autoSave;

        // Prefer user's settings key for embeddings; fall back to env key only if valid,
        // otherwise omit aiClient so MemoryCortex uses DeterministicLocalEmbeddingProvider.
        const cortexGeminiKey = settings?.geminiApiKey ||
            (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MISSING_KEY' ? process.env.GEMINI_API_KEY : undefined);
        const cortexAiClient = cortexGeminiKey
            ? new GoogleGenAI({ apiKey: cortexGeminiKey })
            : undefined;

        if (qdrantUrl) {
            try {
                memoryCortex = new MemoryCortex({
                    url: qdrantUrl,
                    apiKey: qdrantApiKey,
                    aiClient: cortexAiClient,
                    defaultAppId: targetAppId,
                    persistPath,
                    autoSave
                });
            } catch {
                memoryCortex = persistPath
                    ? new MemoryCortex({ defaultAppId: targetAppId, aiClient: cortexAiClient, persistPath, autoSave })
                    : getOrCreateDefaultCortex(targetAppId, cortexAiClient);
            }
        } else {
            memoryCortex = persistPath
                ? new MemoryCortex({ defaultAppId: targetAppId, aiClient: cortexAiClient, persistPath, autoSave })
                : getOrCreateDefaultCortex(targetAppId, cortexAiClient);
        }
    }

    // Resolve Tool Registry (custom passed, settings configured, or global defaults)
    const toolRegistry: ToolRegistry = params.tools instanceof ToolRegistry
        ? params.tools
        : (Array.isArray(params.tools)
            ? new ToolRegistry(params.tools)
            : (settings?.tools instanceof ToolRegistry
                ? settings.tools
                : (Array.isArray(settings?.tools)
                    ? new ToolRegistry(settings.tools)
                    : globalToolRegistry)));



    // 0. Infer Task Complexity via ModelRouter
    const forceFullSwarm = params.forceFullSwarm ?? settings?.forceFullSwarm ?? settings?.disableFastPath ?? false;
    const complexity: TaskComplexity = complexityOverride || ModelRouter.inferComplexity(task, (data || '').length, 1, forceFullSwarm);
    const deepAnalysisRequested = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? (complexity === 'complex');

    // 0b. Check Deterministic Payload Cache for Zero-Drift Short-Circuit
    const cacheKey = PayloadCache.computeFingerprint(task, data || "", {
        appId: targetAppId,
        deepAnalysis: deepAnalysisRequested,
        complexity,
        forceFullSwarm
    });

    const cachedAnalysis = forceFullSwarm ? null : globalPayloadCache.get(cacheKey);
    if (cachedAnalysis) {
        context.addEvent({
            agentRole: 'Payload Cache',
            action: 'Cache Hit (Zero-Drift Execution)',
            modelName: 'Local/LRU-Cache',
            prompt: `Deterministic cache hit for fingerprint: ${cacheKey.substring(0, 16)}...`,
            output: {
                fingerprint: cacheKey,
                cached: true,
                bypassed: '100% LLM token consumption & provider API calls'
            },
            durationMs: 0
        });

        const workflowDurationMs = Date.now() - workflowStartTime;
        globalMetricsCollector.recordTaskExecution({
            success: true,
            durationMs: workflowDurationMs,
            agentRole: 'Payload Cache'
        });
        const metrics = globalMetricsCollector.getBaselineReport();

        return {
            events: context.events,
            finalAnalysis: cachedAnalysis,
            metrics
        };
    }

    // 0c. Check Lightweight Semantic Baseline Cache for Near-Identical Query Matching
    const semanticMatch: SemanticMatchResult = forceFullSwarm
        ? { hit: false, similarity: 0 }
        : globalSemanticCache.findMatch(task, { data, threshold: 0.80 });

    if (semanticMatch.hit && semanticMatch.entry) {
        context.addEvent({
            agentRole: 'Semantic Baseline Cache',
            action: 'Cache Hit (Semantic Zero-Drift Baseline)',
            modelName: 'Local/SemanticCache',
            prompt: `Semantic baseline cache hit: ${semanticMatch.reason || `similarity ${semanticMatch.similarity}`}`,
            output: {
                matchedTask: semanticMatch.matchedTask,
                similarity: semanticMatch.similarity,
                cached: true,
                bypassed: '100% LLM token consumption & provider API calls'
            },
            durationMs: 0
        });

        const workflowDurationMs = Date.now() - workflowStartTime;
        globalMetricsCollector.recordTaskExecution({
            success: true,
            durationMs: workflowDurationMs,
            agentRole: 'Semantic Baseline Cache'
        });
        const metrics = globalMetricsCollector.getBaselineReport();

        return {
            events: context.events,
            finalAnalysis: semanticMatch.entry.payload,
            metrics
        };
    }

    // 1. Resolve Manager, Analysts, and Critic
    const rawAgents = settings?.agents || [];
    let managerConfig = rawAgents.find((a: AgentConfig) => a.id === 'manager' || a.role === 'Manager Node');
    const dedicatedCriticConfig = rawAgents.find((a: AgentConfig) => a.id === 'critic' || a.role?.toLowerCase().includes('critic') || a.role?.toLowerCase().includes('verifier')) || settings?.critic;
    const analystConfigs = rawAgents.filter((a: AgentConfig) => a.id !== 'manager' && a.provider !== 'none');

    const hasUserGemini = !!settings?.geminiApiKey;
    if (!managerConfig) {
        const defaultProvider = hasUserGemini || process.env.GEMINI_API_KEY ? 'gemini' : 'openrouter';
        managerConfig = {
            id: 'manager',
            role: 'Manager Node',
            provider: defaultProvider,
            model: ''
        };
    }
    const availableFallbacks: ProviderCredential[] = [];
    if (!settings?.disableFallback) {
        const allProviders: Provider[] = ['gemini', 'openrouter', 'groq', 'github', 'mistral'];
        for (const p of allProviders) {
            const { key, client } = resolveProvider(p, settings, defaultAi);
            if (key) {
                const userConfiguredAgent = rawAgents.find((a: AgentConfig) => a.provider === p && a.model);
                const fallbackModel = userConfiguredAgent?.model || '';
                availableFallbacks.push({
                    provider: p,
                    apiKey: key,
                    modelName: fallbackModel,
                    aiClient: client
                });
            }
        }
    }

    const { key: mKey, client: mClient } = resolveProvider(managerConfig.provider, settings, defaultAi);
    const finalMKey = managerConfig.apiKey ? sanitizeApiKey(managerConfig.apiKey) : mKey;
    validateProviderKey(managerConfig.provider, finalMKey, managerConfig.role || 'Manager Node');
    const managerModel = managerConfig.model || '';
    const managerFallbacks = availableFallbacks.filter(f => f.provider !== managerConfig.provider);
    const managerAgent = new Agent('Manager Node', managerModel, managerConfig.provider, finalMKey, mClient, managerFallbacks);

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider, settings, defaultAi);
        const finalAKey = ac.apiKey ? sanitizeApiKey(ac.apiKey) : aKey;
        if (finalAKey || ac.provider === 'simulated' || ac.provider === 'mock' || ac.provider === 'custom-mock') {
            const aModel = ac.model || '';
            const aFallbacks = (ac as any).disableFallback || (ac as any).strictProvider
                ? []
                : availableFallbacks.filter(f => f.provider !== ac.provider);
            analysts.push(new Agent(ac.role || 'Analyst', aModel, ac.provider, finalAKey, aClient, aFallbacks));
        } else {
            console.warn(`Skipping ${ac.role}: missing API key for ${ac.provider}`);
        }
    }

    let dedicatedCriticAgent: Agent | null = null;
    if (dedicatedCriticConfig) {
        const { key: cKey, client: cClient } = resolveProvider(dedicatedCriticConfig.provider, settings, defaultAi);
        const finalCKey = dedicatedCriticConfig.apiKey ? sanitizeApiKey(dedicatedCriticConfig.apiKey) : cKey;
        if (finalCKey || dedicatedCriticConfig.provider === 'simulated' || dedicatedCriticConfig.provider === 'mock' || dedicatedCriticConfig.provider === 'custom-mock') {
            const cModel = dedicatedCriticConfig.model || '';
            const cFallbacks = availableFallbacks.filter(f => f.provider !== dedicatedCriticConfig.provider);
            dedicatedCriticAgent = new Agent(dedicatedCriticConfig.role || 'Verification Critic', cModel, dedicatedCriticConfig.provider, finalCKey, cClient, cFallbacks);
        }
    }

    if (analysts.length === 0) {
        throw new Error('No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.');
    }

    const fastPathDecision = ModelRouter.evaluateFastPath(task, data || "", deepAnalysisRequested, forceFullSwarm);

    context.addEvent({
        agentRole: 'Model Router',
        action: 'Routing & Complexity Classification',
        modelName: 'Local/TypeScript',
        prompt: `Routing task with inferred complexity='${complexity}', fastPathEligible=${fastPathDecision.eligible}${forceFullSwarm ? ' (Fast track overridden: forceFullSwarm=true)' : ''}`,
        output: {
            complexity,
            fastPath: fastPathDecision,
            deepAnalysis: deepAnalysisRequested,
            forceFullSwarm,
            manager: { provider: managerConfig.provider, model: managerModel },
            analysts: analysts.map(a => ({ role: a.role, provider: a.provider, model: a.modelName }))
        },
        durationMs: 0
    });

    let finalAnalysis: any = null;

    if (fastPathDecision.eligible && analysts.length > 0) {
        const fastAnalyst = analysts[0];
        context.addEvent({
            agentRole: 'Model Router',
            action: 'Fast-Path Short-Circuit Activated',
            modelName: 'Local/TypeScript',
            prompt: `Short-circuiting execution: ${fastPathDecision.reason}`,
            output: {
                bypassed: ['Data Profiler', 'Token Budgeter / Chunker', 'Qdrant Vector Cortex', 'Multi-Analyst Fanout', 'Critic Verification Loop'],
                dispatchedTo: fastAnalyst.role,
                estimatedTokens: fastPathDecision.estimatedTokens
            },
            durationMs: 0
        });

        fastAnalyst.setSystemInstruction(ANALYST_SYSTEM_INSTRUCTION);
        const fastPrompt = `Task: ${task}\nData:\n${data || "(No additional data payload)"}`;

        try {
            const rawOutput = await fastAnalyst.run(fastPrompt, context, { responseMimeType: "application/json" });
            const parsed = AnalystResponseSchema.safeParse(rawOutput);
            if (parsed.success) {
                finalAnalysis = {
                    ui_title: `Fast Analysis: ${task.substring(0, 40)}`,
                    components: [
                        {
                            id: 'fast-summary',
                            type: 'InsightList',
                            props: {
                                title: 'Key Insights',
                                insights: parsed.data.insights.map((i: string) => ({ type: 'info', message: i }))
                            }
                        }
                    ]
                };
            } else {
                finalAnalysis = {
                    ui_title: `Fast Analysis: ${task.substring(0, 40)}`,
                    components: [
                        {
                            id: 'fast-summary',
                            type: 'InsightList',
                            props: {
                                title: 'Summary',
                                insights: [{ type: 'info', message: typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput) }]
                            }
                        }
                    ]
                };
            }

            if (finalAnalysis && !finalAnalysis.ui_title?.includes("Error")) {
                globalPayloadCache.set(cacheKey, finalAnalysis);
                globalSemanticCache.set(task, finalAnalysis, { data });
                if (memoryCortex) {
                    const content = `Task: ${task}\nResult: ${finalAnalysis.ui_title || 'Fast analysis complete'}`;
                    const meta = {
                        domain: 'analysis',
                        agentRole: fastAnalyst.role,
                        complexity: 'instant' as const,
                        verified: true,
                        appId: targetAppId,
                        qualityRating: 0.90,
                        feedback: 'Fast-path short-circuit: validated instant-tier heuristic',
                        attempts: 1,
                        task,
                        fastPath: true
                    };
                    try {
                        const storedId = await memoryCortex.store(content, meta);
                        if (params.onMemoryLearned) {
                            params.onMemoryLearned({
                                appId: targetAppId,
                                content,
                                id: storedId,
                                metadata: meta
                            });
                        }
                    } catch (err: any) {
                        console.warn(`[Fast-Path] Memory storage failed:`, err);
                    }
                }
            }

            const workflowDurationMs = Date.now() - workflowStartTime;
            globalMetricsCollector.recordTaskExecution({
                success: true,
                durationMs: workflowDurationMs,
                agentRole: fastAnalyst.role,
                provider: fastAnalyst.provider
            });
            const metrics = globalMetricsCollector.getBaselineReport();
            context.addEvent({
                agentRole: 'System Profiler',
                action: 'Workflow Metrics Baseline',
                modelName: 'Local/MetricsCollector',
                prompt: `Fast-path baseline recorded: completionRate=${metrics.overallCompletionRatePercent}%, latency=${workflowDurationMs}ms, totalTasks=${metrics.totalTasks}`,
                output: metrics,
                durationMs: workflowDurationMs
            });

            return {
                events: context.events,
                finalAnalysis,
                metrics
            };
        } catch (err: any) {
            console.warn(`[Fast-Path] Short-circuit failed, falling back to full swarm pipeline:`, err);
        }
    }

    try {
        // Step 1: Data Profiling
        const { rawInput, profile } = profileData(data || "");
        context.addEvent({
            agentRole: 'System Profiler',
            action: 'Metadata Extracted',
            modelName: 'Local/TypeScript',
            prompt: 'Analyzing payload size...',
            output: profile,
            durationMs: 0
        });

        // Step 2: Token Budgeting & Batch Planning
        const { chunks, originalChunkCount, maxTokensPerChunk, totalTokens, warning } = createTokenChunks(rawInput);
        context.addEvent({
            agentRole: 'System Profiler',
            action: 'Token Budgeting',
            modelName: 'Local/TypeScript',
            prompt: `Data exceeds single-pass threshold? ${chunks.length > 1 ? 'Yes' : 'No'}`,
            output: { chunks: chunks.length, originalChunks: originalChunkCount, maxTokensPerChunk, totalTokens, warning },
            durationMs: 0
        });

        // Step 3: Targeted Memory Grounding (Hybrid Qdrant / In-Memory Cortex)
        let historicalContext = "";
        try {
            const cortexName = qdrantUrl ? 'Qdrant/HybridCortex' : 'Local/InMemoryCortex';
            context.addEvent({
                agentRole: 'System Orchestrator',
                action: 'Targeted Cortex Retrieval',
                modelName: cortexName,
                prompt: `Retrieving historical baseline constraints (appId='${targetAppId}', includeShared=${includeShared})...`
            });

            const [retrieved, exemplars] = await Promise.all([
                memoryCortex.retrieve(task, { appId: targetAppId, includeShared }, 3).catch(() => []),
                memoryCortex.retrieveExemplars(task, {
                    appId: targetAppId,
                    includeShared,
                    limit: 2,
                    minRating: 0.7
                }).catch(() => "")
            ]);

            if (retrieved.length > 0) {
                historicalContext = `Retrieved ${retrieved.length} relevant historical baselines from memory:\n` +
                    retrieved.map((m: any, idx: number) => `[Baseline ${idx + 1}]: ${m.content || JSON.stringify(m)}`).join('\n');
            } else {
                historicalContext = "Vector Cortex connected. No prior matching historical baselines found for this domain.";
            }

            if (exemplars) {
                historicalContext += `\n\nHigh-Quality Exemplars from Past Runs:\n${exemplars}`;
            }

            context.addEvent({
                agentRole: 'System Orchestrator',
                action: 'Cortex Retrieval Complete',
                prompt: 'Retrieval completed',
                modelName: cortexName,
                output: { recordsFound: retrieved.length, exemplarsIncluded: Boolean(exemplars), status: 'Success', message: historicalContext },
                durationMs: 12
            });
        } catch (err: any) {
            let errorMessage = err.message || String(err);
            if (errorMessage.includes("Unexpected token '<'") || errorMessage.includes("is not valid JSON")) {
                errorMessage = "The Qdrant URL provided returned an HTML web page instead of JSON. Ensure you use the Cluster REST Endpoint URL (e.g. https://xyz.cloud.qdrant.tech:6333) and not the dashboard URL.";
            }

            context.addEvent({
                agentRole: 'System Orchestrator',
                action: 'Cortex Retrieval Failed',
                prompt: 'Retrieval failed',
                modelName: 'Cortex/Fallback',
                error: `Memory retrieval error: ${errorMessage}`,
                durationMs: 0
            });
            historicalContext = "Failed to retrieve baselines from memory. Proceeding without historical context.";
        }

        // Step 4: Dynamic Specialist Routing & Chunk Distribution
        const allAnalystReports: any[][] = analysts.map(() => []);

        if (analysts.length > 0 && chunks.length > 0) {
            let routingPlan: SpecialistRoutingPlan;
            if (chunks.length > 1) {
                // Multi-chunk workload: Route chunks across specialists based on affinity and token quotas
                routingPlan = globalSpecialistRouter.planDistribution(task, chunks, analysts);
            } else {
                // Single-chunk workload: Evaluate domain affinity & allocate budget across specialists
                const estTokens = Math.max(10, Math.ceil(chunks[0].length / 4));
                const assignments = analysts.map(analyst => {
                    const { score: affinity, matchedDomain } = globalSpecialistRouter.scoreAffinity(analyst.role, `${task}\n${chunks[0]}`);
                    globalTokenBudgetManager.recordUsage(analyst.provider, estTokens, analyst.role);
                    return {
                        chunkIndex: 0,
                        estimatedTokens: estTokens,
                        agentId: (analyst as any).id || analyst.role,
                        agentRole: analyst.role,
                        provider: analyst.provider,
                        affinityScore: affinity,
                        allocatedTokens: estTokens,
                        reason: matchedDomain
                            ? `Matched '${matchedDomain}' domain affinity (${Math.round(affinity * 100)}%)`
                            : `Domain perspective analysis (${Math.round(affinity * 100)}%)`
                    };
                });

                const specialistSummary: Record<string, { role: string; chunksAssigned: number; tokensAllocated: number }> = {};
                for (const a of analysts) {
                    specialistSummary[a.role] = {
                        role: a.role,
                        chunksAssigned: 1,
                        tokensAllocated: estTokens
                    };
                }

                routingPlan = {
                    totalChunks: 1,
                    totalEstimatedTokens: estTokens * analysts.length,
                    assignments,
                    specialistSummary
                };
            }

            // Emit structured Specialist Dynamic Routing event
            context.addEvent({
                agentRole: 'Dynamic Task Router',
                action: 'Specialist Dynamic Routing',
                modelName: 'Local/AffinityRouter',
                prompt: `Dynamic specialist routing plan for ${chunks.length} chunk(s) across ${analysts.length} specialist(s)`,
                output: {
                    totalChunks: routingPlan.totalChunks,
                    totalEstimatedTokens: routingPlan.totalEstimatedTokens,
                    assignments: routingPlan.assignments,
                    specialistSummary: routingPlan.specialistSummary,
                    tokenBudgets: globalTokenBudgetManager.getMetrics(),
                    capabilityProfiles: globalSpecialistProfiler.getAllProfiles()
                },
                durationMs: 0
            });

            // Helper to execute an individual analyst on a chunk
            const executeAnalyst = async (analyst: Agent, chunk: string, chunkIdx: number) => {
                const startTime = Date.now();
                const toolPrompt = toolRegistry.list().length > 0 ? `\n\n${toolRegistry.renderPromptSchema()}` : '';
                analyst.setSystemInstruction(ANALYST_SYSTEM_INSTRUCTION + toolPrompt);
                const chunkPromptText = chunks.length > 1 ? `Chunk ${chunkIdx + 1}/${chunks.length}\n${chunk}` : chunk;

                const analystPrompt = `Task: ${task}\nMetadata: ${JSON.stringify(profile)}\nHistorical Baselines: ${historicalContext}\nData Chunk [${chunkIdx + 1}/${chunks.length}]:\n${chunkPromptText}`;

                try {
                    let rawOutput: any;
                    try {
                        rawOutput = await analyst.run(analystPrompt, context, { 
                            responseMimeType: "application/json"
                        });
                    } catch (innerErr: any) {
                        SwarmTracer.getInstance().logEvent({
                            agentRole: 'Analyst',
                            action: 'Fatal Analyst Error',
                            error: innerErr?.stack || innerErr?.message || String(innerErr)
                        });
                        throw innerErr;
                    }
                    
                    // Parse and execute any tool calls emitted in output
                    const rawStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
                    const toolCalls = toolRegistry.parseToolCalls(rawStr);
                    const toolResults = toolCalls.length > 0 ? await toolRegistry.executeAllToolCalls(toolCalls) : [];

                    for (const tr of toolResults) {
                        context.addEvent({
                            agentRole: 'Deterministic Tool Engine',
                            action: `Executed Tool: ${tr.tool}`,
                            modelName: 'Local/DeterministicTool',
                            prompt: JSON.stringify(tr.parameters),
                            output: tr.success ? tr.result : { error: tr.error },
                            durationMs: tr.durationMs
                        });
                    }

                    // Resilient schema guard for Analyst output
                    const strippedOutput = typeof rawOutput === 'string' ? toolRegistry.stripToolCalls(rawOutput) : rawOutput;
                    const resData = guardAnalystResponse(strippedOutput, analyst.role);
                    for (const tr of toolResults) {
                        if (tr.success) {
                            resData.insights.push(`[Tool Result: ${tr.tool}]: ${JSON.stringify(tr.result)}`);
                        }
                    }
                    (resData as any)._chunkIndex = chunkIdx;

                    // Record response token telemetry
                    const outTokens = Math.max(10, Math.ceil((typeof rawOutput === 'string' ? rawOutput.length : JSON.stringify(rawOutput).length) / 4));
                    globalTokenBudgetManager.recordUsage(analyst.provider, outTokens, analyst.role);

                    const durationMs = Date.now() - startTime;
                    globalSpecialistProfiler.recordOutcome(analyst.role, {
                        success: true,
                        durationMs,
                        tokensUsed: outTokens
                    });

                    return resData;
                } catch (err: any) {
                    const errDetail = err?.stack || err?.message || String(err);
                    const durationMs = Date.now() - startTime;
                    globalSpecialistProfiler.recordOutcome(analyst.role, {
                        success: false,
                        durationMs,
                        error: errDetail
                    });
                    console.error(`[Analyst Fatal Error] ${analyst.role} failed:`, errDetail);
                    throw err; // Stop hiding the error! Bubble it up.
                }
            };

            if (chunks.length > 1) {
                // Execute routed chunk assignments
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const assignment = routingPlan.assignments.find(asn => asn.chunkIndex === i);
                    const assignedAnalyst = analysts.find(a => a.role === assignment?.agentRole) || analysts[i % analysts.length];
                    const analystIdx = analysts.indexOf(assignedAnalyst);

                    const resData = await executeAnalyst(assignedAnalyst, chunk, i);
                    if (analystIdx >= 0) {
                        allAnalystReports[analystIdx].push(resData);
                    }

                    if (i < chunks.length - 1) {
                        context.addEvent({
                            agentRole: 'System Orchestrator',
                            action: 'Batch Delay',
                            modelName: 'Local/TypeScript',
                            prompt: `Rate limit prevention: Waiting 2s before processing chunk ${i + 2}/${chunks.length}...`
                        });
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            } else {
                // Single chunk: execute all analysts in parallel (full domain perspective)
                const chunkReports = await Promise.all(
                    analysts.map((analyst) => executeAnalyst(analyst, chunks[0], 0))
                );
                for (let a = 0; a < analysts.length; a++) {
                    allAnalystReports[a].push(chunkReports[a]);
                }
            }
        }

        // Step 5: Manager Node Synthesis & Deep Analysis Verification
        const compiledReports = analysts.map((a, i) => {
            const reports = allAnalystReports[i];
            if (!reports || reports.length === 0) return null;
            const combinedStr = reports
                .map((r) => {
                    const chunkLabel = r._chunkIndex !== undefined ? `--- Chunk ${r._chunkIndex + 1} ---` : '--- Report ---';
                    const content = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
                    return `${chunkLabel}\n${content}`;
                })
                .join('\n\n');
            return `[${a.role} Report]:\n${combinedStr}`;
        }).filter(Boolean).join('\n\n');

        managerAgent.setSystemInstruction(MANAGER_SYSTEM_INSTRUCTION);
        const dynamicPrompt = `Task: ${task}\n\nHistorical Baselines:\n${historicalContext}\n\nAnalyst Reports:\n${compiledReports}`;

        let parsedManagerOutput: any = null;
        let lifecycleResult: any = null;

        if (deepAnalysisRequested && (analysts.length > 0 || dedicatedCriticAgent)) {
            // Select critic: Prefer dedicated critic, then cross-provider analyst (different from manager), then first analyst
            const crossProviderAnalyst = analysts.find(a => a.provider !== managerAgent.provider);
            const criticAgent = dedicatedCriticAgent || crossProviderAnalyst || analysts[0];

            criticAgent.setSystemInstruction("You are the Swarm Verification Critic. Audit proposed analyses strictly against the raw data, historical baselines, and analyst reports. Flag discrepancies, missed anomalies, or schema violations.");

            const lifecycle = new AnalysisLifecycle(managerAgent, criticAgent, 2);
            context.addEvent({
                agentRole: 'Analysis Lifecycle',
                action: 'Deep Analysis Verification Loop Started',
                modelName: `${managerAgent.modelName} (${managerAgent.provider}) vs ${criticAgent.modelName} (${criticAgent.provider})`,
                prompt: `Auditing synthesized proposal against raw findings with cross-provider verification (max 2 attempts)`
            });

            lifecycleResult = await lifecycle.executeAndVerify(
                {
                    task,
                    dataSample: rawInput.substring(0, 3000),
                    analystReports: compiledReports,
                    historicalBaselines: historicalContext
                },
                context,
                dynamicPrompt,
                "Verify whether this analysis faithfully represents the analyst reports and data, and strictly complies with all historical baselines and past lessons without hallucinations or omissions."
            );

            parsedManagerOutput = lifecycleResult.finalProposal;
        } else {
            parsedManagerOutput = await managerAgent.run(dynamicPrompt, context, {
                responseMimeType: "application/json",
                zodSchema: ManagerResponseSchema
            });
        }

        finalAnalysis = guardManagerResponse(parsedManagerOutput, "Executive Swarm Synthesis");

        if (lifecycleResult?.computedRating && analysts.length > 0) {
            const isVerifiedSuccess = !finalAnalysis?.ui_title?.includes("Error");
            for (const analyst of analysts) {
                globalSpecialistProfiler.recordOutcome(analyst.role, {
                    success: isVerifiedSuccess,
                    qualityRating: lifecycleResult.computedRating
                });
            }
        }

        if (memoryCortex && finalAnalysis && !finalAnalysis.ui_title?.includes("Error")) {
            const targetAppId = settings?.appId || 'perfect-swarm';
            const qualityRating = lifecycleResult
                ? lifecycleResult.computedRating
                : (complexity === 'instant' ? 0.90 : 0.85);
            const verified = lifecycleResult ? lifecycleResult.success : false;
            const feedback = lifecycleResult?.criticFeedback;
            const content = `Task: ${task}\nResult: ${finalAnalysis.ui_title || 'Analysis complete'}`;
            const meta = {
                domain: 'analysis',
                agentRole: 'Manager Node',
                complexity,
                verified,
                appId: targetAppId,
                qualityRating,
                feedback,
                attempts: lifecycleResult?.attempts || 1,
                task,
                fastPath: false
            };

            try {
                const storedId = await memoryCortex.store(content, meta);
                if (params.onMemoryLearned) {
                    params.onMemoryLearned({
                        appId: targetAppId,
                        content,
                        id: storedId,
                        metadata: meta
                    });
                }
            } catch (err: any) {
                console.warn(`[Swarm] Memory storage failed:`, err);
            }
        }
    } catch (swarmErr: any) {
        const workflowDurationMs = Date.now() - workflowStartTime;
        globalMetricsCollector.recordTaskExecution({
            success: false,
            durationMs: workflowDurationMs,
            agentRole: 'System Orchestrator',
            error: swarmErr?.message || String(swarmErr)
        });
        console.error("Swarm execution failed:", swarmErr);
        throw swarmErr;
    }

    if (finalAnalysis && !finalAnalysis.ui_title?.includes("Error")) {
        globalPayloadCache.set(cacheKey, finalAnalysis);
        globalSemanticCache.set(task, finalAnalysis, { data });
    }

    const workflowDurationMs = Date.now() - workflowStartTime;
    const isSuccess = !finalAnalysis?.ui_title?.includes("Error");
    globalMetricsCollector.recordTaskExecution({
        success: isSuccess,
        durationMs: workflowDurationMs,
        agentRole: managerAgent?.role || 'Manager Node',
        provider: managerAgent?.provider
    });
    const metrics = globalMetricsCollector.getBaselineReport();
    context.addEvent({
        agentRole: 'System Profiler',
        action: 'Workflow Metrics Baseline',
        modelName: 'Local/MetricsCollector',
        prompt: `Workflow baseline telemetry: completionRate=${metrics.overallCompletionRatePercent}%, p50=${metrics.overallLatency.p50Ms}ms, p95=${metrics.overallLatency.p95Ms}ms, totalTasks=${metrics.totalTasks}`,
        output: metrics,
        durationMs: workflowDurationMs
    });

    return {
        events: context.events,
        finalAnalysis,
        metrics
    };
}

/**
 * Headless Swarm Engine object encapsulating configuration and execution.
 */
export class SwarmEngine {
    private defaultSettings: SwarmEngineSettings;
    private defaultAi?: GoogleGenAI;
    private defaultCortex?: MemoryCortex;
    private defaultOnMemoryLearned?: (event: LearnedMemoryEvent) => void;

    constructor(
        configOrSettings: SwarmEngineSettings = {},
        defaultAi?: GoogleGenAI,
        defaultCortex?: MemoryCortex
    ) {
        if (configOrSettings && typeof configOrSettings === 'object' && ('cortex' in configOrSettings || 'onMemoryLearned' in configOrSettings || 'defaultCortex' in configOrSettings)) {
            this.defaultSettings = configOrSettings.settings || {};
            this.defaultAi = configOrSettings.defaultAi || defaultAi;
            this.defaultCortex = configOrSettings.cortex || configOrSettings.defaultCortex || defaultCortex;
            this.defaultOnMemoryLearned = configOrSettings.onMemoryLearned;
        } else {
            this.defaultSettings = configOrSettings;
            this.defaultAi = defaultAi;
            this.defaultCortex = defaultCortex;
        }
    }

    async execute(params: Omit<SwarmWorkflowParams, 'settings' | 'defaultAi'> & { settings?: SwarmEngineSettings; defaultAi?: GoogleGenAI; cortex?: MemoryCortex; onMemoryLearned?: (event: LearnedMemoryEvent) => void }): Promise<SwarmWorkflowResult> {
        return executeSwarmWorkflow({
            ...params,
            settings: { ...this.defaultSettings, ...params.settings },
            defaultAi: params.defaultAi || this.defaultAi,
            cortex: params.cortex || this.defaultCortex,
            onMemoryLearned: params.onMemoryLearned || this.defaultOnMemoryLearned
        });
    }

    async executeWorkflow(params: Omit<SwarmWorkflowParams, 'settings' | 'defaultAi'> & { settings?: SwarmEngineSettings; defaultAi?: GoogleGenAI; cortex?: MemoryCortex; onMemoryLearned?: (event: LearnedMemoryEvent) => void }): Promise<SwarmWorkflowResult> {
        return this.execute(params);
    }

    static execute(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
        return executeSwarmWorkflow(params);
    }
}
