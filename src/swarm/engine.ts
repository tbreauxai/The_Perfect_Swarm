import { GoogleGenAI } from '@google/genai';
import { MemoryCortex } from './memory.ts';
import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import type { SwarmEvent, ProviderCredential, Provider } from './types.ts';
import { profileData, createTokenChunks } from './profiler.ts';
import { ModelRouter, type TaskComplexity } from './router.ts';
import { AnalysisLifecycle } from './lifecycle.ts';
import { PayloadCache, globalPayloadCache } from './cache.ts';
import { AnalystResponseSchema, ManagerResponseSchema } from './schemas.ts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolRegistry, globalToolRegistry, type SwarmTool } from './tools/index.ts';

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
    settings: any,
    defaultAi?: GoogleGenAI
): ProviderResolution {
    let key = '';
    let client: GoogleGenAI | undefined = undefined;

    switch (provider) {
        case 'gemini': {
            key = sanitizeApiKey(settings?.geminiApiKey || process.env.GEMINI_API_KEY);
            client = key
                ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
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
    settings?: any;
    defaultAi?: GoogleGenAI;
    enableDeepAnalysis?: boolean;
    complexityOverride?: TaskComplexity;
    onEvent?: (event: SwarmEvent) => void;
    context?: SwarmContext;
    cortex?: MemoryCortex;
    tools?: SwarmTool[] | ToolRegistry;
}

export interface SwarmWorkflowResult {
    events: SwarmEvent[];
    finalAnalysis: any;
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
        if (qdrantUrl) {
            try {
                memoryCortex = new MemoryCortex({
                    url: qdrantUrl,
                    apiKey: qdrantApiKey,
                    aiClient: defaultAi,
                    defaultAppId: targetAppId
                });
            } catch {
                memoryCortex = getOrCreateDefaultCortex(targetAppId, defaultAi);
            }
        } else {
            memoryCortex = getOrCreateDefaultCortex(targetAppId, defaultAi);
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
    const complexity: TaskComplexity = complexityOverride || ModelRouter.inferComplexity(task, (data || '').length);
    const deepAnalysisRequested = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? (complexity === 'complex');

    // 0b. Check Deterministic Payload Cache for Zero-Drift Short-Circuit
    const cacheKey = PayloadCache.computeFingerprint(task, data || "", {
        appId: targetAppId,
        deepAnalysis: deepAnalysisRequested,
        complexity
    });

    const cachedAnalysis = globalPayloadCache.get(cacheKey);
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

        return {
            events: context.events,
            finalAnalysis: cachedAnalysis
        };
    }

    // 1. Resolve Manager, Analysts, and Critic
    const rawAgents = settings?.agents || [];
    let managerConfig = rawAgents.find((a: any) => a.id === 'manager' || a.role === 'Manager Node');
    const dedicatedCriticConfig = rawAgents.find((a: any) => a.id === 'critic' || a.role?.toLowerCase().includes('critic') || a.role?.toLowerCase().includes('verifier')) || settings?.critic;
    const analystConfigs = rawAgents.filter((a: any) => a.id !== 'manager' && a.provider !== 'none');

    const hasUserGemini = !!settings?.geminiApiKey;
    if (!managerConfig) {
        const defaultProvider = hasUserGemini || process.env.GEMINI_API_KEY ? 'gemini' : 'openrouter';
        managerConfig = {
            role: 'Manager Node',
            provider: defaultProvider,
            model: ModelRouter.getRecommendedModel(defaultProvider, complexity)
        };
    }

    const availableFallbacks: ProviderCredential[] = [];
    const allProviders: Provider[] = ['gemini', 'openrouter', 'groq', 'github', 'mistral'];
    for (const p of allProviders) {
        const { key, client } = resolveProvider(p, settings, defaultAi);
        if (key) {
            availableFallbacks.push({
                provider: p,
                apiKey: key,
                modelName: ModelRouter.getRecommendedModel(p, complexity),
                aiClient: client
            });
        }
    }

    const { key: mKey, client: mClient } = resolveProvider(managerConfig.provider, settings, defaultAi);
    const finalMKey = managerConfig.apiKey ? sanitizeApiKey(managerConfig.apiKey) : mKey;
    validateProviderKey(managerConfig.provider, finalMKey, managerConfig.role || 'Manager Node');
    const managerModel = managerConfig.model || ModelRouter.getRecommendedModel(managerConfig.provider, complexity);
    const managerFallbacks = availableFallbacks.filter(f => f.provider !== managerConfig.provider);
    const managerAgent = new Agent('Manager Node', managerModel, managerConfig.provider, finalMKey, mClient, managerFallbacks);

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider, settings, defaultAi);
        const finalAKey = ac.apiKey ? sanitizeApiKey(ac.apiKey) : aKey;
        if (finalAKey) {
            const aModel = ac.model || ModelRouter.getRecommendedModel(ac.provider, complexity);
            const aFallbacks = availableFallbacks.filter(f => f.provider !== ac.provider);
            analysts.push(new Agent(ac.role || 'Analyst', aModel, ac.provider, finalAKey, aClient, aFallbacks));
        } else {
            console.warn(`Skipping ${ac.role}: missing API key for ${ac.provider}`);
        }
    }

    let dedicatedCriticAgent: Agent | null = null;
    if (dedicatedCriticConfig) {
        const { key: cKey, client: cClient } = resolveProvider(dedicatedCriticConfig.provider, settings, defaultAi);
        const finalCKey = dedicatedCriticConfig.apiKey ? sanitizeApiKey(dedicatedCriticConfig.apiKey) : cKey;
        if (finalCKey) {
            const cModel = dedicatedCriticConfig.model || ModelRouter.getRecommendedModel(dedicatedCriticConfig.provider, complexity);
            const cFallbacks = availableFallbacks.filter(f => f.provider !== dedicatedCriticConfig.provider);
            dedicatedCriticAgent = new Agent(dedicatedCriticConfig.role || 'Verification Critic', cModel, dedicatedCriticConfig.provider, finalCKey, cClient, cFallbacks);
        }
    }

    if (analysts.length === 0) {
        throw new Error('No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.');
    }

    const fastPathDecision = ModelRouter.evaluateFastPath(task, data || "", deepAnalysisRequested);

    context.addEvent({
        agentRole: 'Model Router',
        action: 'Routing & Complexity Classification',
        modelName: 'Local/TypeScript',
        prompt: `Routing task with inferred complexity='${complexity}', fastPathEligible=${fastPathDecision.eligible}`,
        output: {
            complexity,
            fastPath: fastPathDecision,
            deepAnalysis: deepAnalysisRequested,
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
                if (memoryCortex) {
                    memoryCortex.store(
                        `Task: ${task}\nResult: ${finalAnalysis.ui_title || 'Fast analysis complete'}`,
                        {
                            domain: 'analysis',
                            agentRole: fastAnalyst.role,
                            complexity: 'instant',
                            verified: true,
                            appId: targetAppId,
                            qualityRating: 0.90,
                            feedback: 'Fast-path short-circuit: validated instant-tier heuristic',
                            attempts: 1
                        }
                    ).catch(() => {});
                }
            }

            return {
                events: context.events,
                finalAnalysis
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

            const retrieved = await memoryCortex.retrieve(task, { appId: targetAppId, includeShared }, 3);
            const exemplars = await memoryCortex.retrieveExemplars(task, {
                appId: targetAppId,
                includeShared,
                limit: 2,
                minRating: 0.7
            }).catch(() => "");

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

        // Step 4: Run Analysts across Chunks
        const allAnalystReports: any[][] = analysts.map(() => []);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            const analystPromises = analysts.map(async analyst => {
                const toolPrompt = toolRegistry.list().length > 0 ? `\n\n${toolRegistry.renderPromptSchema()}` : '';
                analyst.setSystemInstruction(ANALYST_SYSTEM_INSTRUCTION + toolPrompt);
                const analystPrompt = `Task: ${task}\nMetadata: ${JSON.stringify(profile)}\nHistorical Baselines: ${historicalContext}\nData Chunk [${i + 1}/${chunks.length}]:\n${chunk}`;

                try {
                    const rawOutput = await analyst.run(analystPrompt, context, { responseMimeType: "application/json" });
                    
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

                    // Clean output before schema validation
                    let cleanOutput = rawOutput;
                    if (typeof cleanOutput === 'string') {
                        const stripped = toolRegistry.stripToolCalls(cleanOutput);
                        try {
                            cleanOutput = JSON.parse(stripped);
                        } catch {
                            const firstObj = stripped.indexOf('{');
                            const lastObj = stripped.lastIndexOf('}');
                            if (firstObj !== -1 && lastObj > firstObj) {
                                try {
                                    cleanOutput = JSON.parse(stripped.substring(firstObj, lastObj + 1));
                                } catch {
                                    // ignore
                                }
                            }
                        }
                    }

                    const parsed = AnalystResponseSchema.safeParse(cleanOutput);
                    if (!parsed.success) {
                        console.warn(`[${analyst.role}] Output failed Zod schema validation:`, parsed.error);
                        const issues = (parsed.error as any).issues || (parsed.error as any).errors || [];
                        const baseInsights = [`${analyst.role} provided invalid schema. Validation errors: ${issues.map((e: any) => e.message).join(', ')}`];
                        for (const tr of toolResults) {
                            if (tr.success) baseInsights.push(`[Tool Result: ${tr.tool}]: ${JSON.stringify(tr.result)}`);
                        }
                        return {
                            insights: baseInsights,
                            anomalies: [],
                            summary: "Schema validation failed."
                        };
                    }

                    const resData = parsed.data;
                    for (const tr of toolResults) {
                        if (tr.success) {
                            resData.insights.push(`[Tool Result: ${tr.tool}]: ${JSON.stringify(tr.result)}`);
                        }
                    }
                    return resData;
                } catch (err: any) {
                    return {
                        insights: [`${analyst.role} was unable to process this chunk due to API constraints.`],
                        anomalies: [],
                        summary: `Failed to process: ${err.message || String(err)}`
                    };
                }
            });

            const chunkReports = await Promise.all(analystPromises);
            for (let a = 0; a < analysts.length; a++) {
                allAnalystReports[a].push(chunkReports[a]);
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

        // Step 5: Manager Node Synthesis & Deep Analysis Verification
        const compiledReports = analysts.map((a, i) => {
            const combinedStr = allAnalystReports[i]
                .map((r, chunkIdx) => `--- Chunk ${chunkIdx + 1} ---\n${typeof r === 'string' ? r : JSON.stringify(r, null, 2)}`)
                .join('\n\n');
            return `[${a.role} Report]:\n${combinedStr}`;
        }).join('\n\n');

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
                { task, dataSample: rawInput.substring(0, 3000), analystReports: compiledReports },
                context,
                dynamicPrompt,
                "Verify whether this analysis faithfully represents the analyst reports and data without hallucinations or missing key metrics."
            );

            parsedManagerOutput = lifecycleResult.finalProposal;
        } else {
            const orchestratorPlan = await managerAgent.run(dynamicPrompt, context, {
                responseMimeType: "application/json"
            });

            if (typeof orchestratorPlan === "string") {
                let cleanText = (orchestratorPlan || "").replace(/```(?:json)?/gi, '').trim();
                const startIdx = cleanText.indexOf('{');
                const endIdx = cleanText.lastIndexOf('}');
                if (startIdx !== -1 && endIdx !== -1) {
                    cleanText = cleanText.substring(startIdx, endIdx + 1);
                }
                parsedManagerOutput = JSON.parse(cleanText || "{}");
            } else {
                parsedManagerOutput = orchestratorPlan;
            }
        }

        try {
            const parsed = ManagerResponseSchema.safeParse(parsedManagerOutput);
            if (!parsed.success) {
                console.warn("[Manager] Output failed Zod schema validation:", parsed.error);
                const issues = (parsed.error as any).issues || (parsed.error as any).errors || [];
                finalAnalysis = { 
                    ui_title: "Validation Error",
                    components: [
                        {
                            id: "error1",
                            type: "InsightList",
                            props: {
                                title: "Schema Validation Failed",
                                insights: issues.map((e: any) => ({ type: "error", message: e.message }))
                            }
                        }
                    ]
                };
            } else {
                finalAnalysis = parsed.data;
            }
        } catch (e) {
            console.error("JSON Parse error:", e);
            finalAnalysis = { 
                ui_title: "JSON Parse Error", 
                components: [
                    { id: "e1", type: "InsightList", props: { title: "Error", insights: [{ type: "error", message: "Failed to parse orchestrator output as JSON. Check console for raw output." }] } }
                ] 
            };
        }

        if (memoryCortex && finalAnalysis && !finalAnalysis.ui_title?.includes("Error")) {
            const targetAppId = settings?.appId || 'perfect-swarm';
            const qualityRating = lifecycleResult
                ? lifecycleResult.computedRating
                : (complexity === 'instant' ? 0.90 : 0.85);
            const verified = lifecycleResult ? lifecycleResult.success : false;
            const feedback = lifecycleResult?.criticFeedback;

            memoryCortex.store(
                `Task: ${task}\nResult: ${finalAnalysis.ui_title || 'Analysis complete'}`,
                {
                    domain: 'analysis',
                    agentRole: 'Manager Node',
                    complexity,
                    verified,
                    appId: targetAppId,
                    qualityRating,
                    feedback,
                    attempts: lifecycleResult?.attempts || 1
                }
            ).catch(() => {});
        }
    } catch (swarmErr) {
        console.error("Swarm execution failed:", swarmErr);
    }

    if (finalAnalysis && !finalAnalysis.ui_title?.includes("Error")) {
        globalPayloadCache.set(cacheKey, finalAnalysis);
    }

    return {
        events: context.events,
        finalAnalysis
    };
}

/**
 * Headless Swarm Engine object encapsulating configuration and execution.
 */
export class SwarmEngine {
    private defaultSettings: any;
    private defaultAi?: GoogleGenAI;
    private defaultCortex?: MemoryCortex;

    constructor(defaultSettings: any = {}, defaultAi?: GoogleGenAI, defaultCortex?: MemoryCortex) {
        this.defaultSettings = defaultSettings;
        this.defaultAi = defaultAi;
        this.defaultCortex = defaultCortex;
    }

    async execute(params: Omit<SwarmWorkflowParams, 'settings' | 'defaultAi'> & { settings?: any; defaultAi?: GoogleGenAI; cortex?: MemoryCortex }): Promise<SwarmWorkflowResult> {
        return executeSwarmWorkflow({
            ...params,
            settings: { ...this.defaultSettings, ...params.settings },
            defaultAi: params.defaultAi || this.defaultAi,
            cortex: params.cortex || this.defaultCortex
        });
    }

    static execute(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
        return executeSwarmWorkflow(params);
    }
}
