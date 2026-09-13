import { GoogleGenAI } from '@google/genai';
import { MemoryCortex } from '../memory.ts';
import { Agent, SwarmContext, type SwarmEvent } from '../../swarm.ts';
import { resolveProvider, validateProviderKey } from './providerService.ts';
import { profileData, createTokenChunks } from './profilerService.ts';

import { ModelRouter, type TaskComplexity } from '../router.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';

import { AnalystResponseSchema, ManagerResponseSchema } from '../schemas.ts';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
}

export interface SwarmWorkflowResult {
    events: SwarmEvent[];
    finalAnalysis: any;
}

export async function executeSwarmWorkflow(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
    const { task, data, settings, defaultAi, enableDeepAnalysis, complexityOverride } = params;
    const context = new SwarmContext();

    // 0. Infer Task Complexity via ModelRouter
    const complexity: TaskComplexity = complexityOverride || ModelRouter.inferComplexity(task, (data || '').length);
    const deepAnalysisRequested = enableDeepAnalysis ?? settings?.enableDeepAnalysis ?? (complexity === 'complex');

    // 1. Resolve Manager and Analysts
    const rawAgents = settings?.agents || [];
    let managerConfig = rawAgents.find((a: any) => a.id === 'manager' || a.role === 'Manager Node');
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

    const { key: mKey, client: mClient } = resolveProvider(managerConfig.provider, settings, defaultAi);
    validateProviderKey(managerConfig.provider, mKey, managerConfig.role || 'Manager Node');
    const managerModel = managerConfig.model || ModelRouter.getRecommendedModel(managerConfig.provider, complexity);
    const managerAgent = new Agent('Manager Node', managerModel, managerConfig.provider, mKey, mClient);

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider, settings, defaultAi);
        if (aKey) {
            const aModel = ac.model || ModelRouter.getRecommendedModel(ac.provider, complexity);
            analysts.push(new Agent(ac.role || 'Analyst', aModel, ac.provider, aKey, aClient));
        } else {
            console.warn(`Skipping ${ac.role}: missing API key for ${ac.provider}`);
        }
    }

    if (analysts.length === 0) {
        throw new Error('No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.');
    }

    context.addEvent({
        agentRole: 'Model Router',
        action: 'Routing & Complexity Classification',
        modelName: 'Local/TypeScript',
        prompt: `Routing task with inferred complexity='${complexity}', deepAnalysis=${deepAnalysisRequested}`,
        output: {
            complexity,
            deepAnalysis: deepAnalysisRequested,
            manager: { provider: managerConfig.provider, model: managerModel },
            analysts: analysts.map(a => ({ role: a.role, provider: a.provider, model: a.modelName }))
        },
        durationMs: 0
    });

    let finalAnalysis: any = null;

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

        // Step 3: Targeted Memory Grounding (Qdrant Cortex)
        let historicalContext = "";
        const qdrantUrl = settings?.qdrantUrl || process.env.QDRANT_URL;
        const qdrantApiKey = settings?.qdrantApiKey || process.env.QDRANT_API_KEY;

        let memoryCortex: MemoryCortex | null = null;

        if (qdrantUrl) {
            try {
                const parsedUrl = new URL(qdrantUrl);
                memoryCortex = new MemoryCortex({
                    url: qdrantUrl,
                    apiKey: qdrantApiKey,
                    aiClient: defaultAi
                });

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Targeted Cortex Retrieval',
                    modelName: 'Qdrant/HybridCortex',
                    prompt: `Connecting to ${parsedUrl.host} for historical baseline constraints...`
                });

                const retrieved = await memoryCortex.retrieve(task, undefined, 3);
                if (retrieved.length > 0) {
                    historicalContext = `Retrieved ${retrieved.length} relevant historical baselines from memory:\n` +
                        retrieved.map((m: any, idx: number) => `[Baseline ${idx + 1}]: ${m.content || JSON.stringify(m)}`).join('\n');
                } else {
                    historicalContext = "Vector Cortex connected. No prior matching historical baselines found for this domain.";
                }

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Cortex Retrieval Complete',
                    prompt: 'Retrieval completed',
                    modelName: 'Qdrant/HybridCortex',
                    output: { recordsFound: retrieved.length, status: 'Success', message: historicalContext },
                    durationMs: 120
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
                    modelName: 'Qdrant/VectorDB',
                    error: `Qdrant connection error: ${errorMessage}`,
                    durationMs: 0
                });
                historicalContext = "Failed to retrieve baselines from Qdrant. Proceeding without historical context.";
            }
        }

        // Step 4: Run Analysts across Chunks
        const allAnalystReports: any[][] = analysts.map(() => []);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            const analystPromises = analysts.map(analyst => {
                analyst.setSystemInstruction(ANALYST_SYSTEM_INSTRUCTION);
                const analystPrompt = `Task: ${task}\nMetadata: ${JSON.stringify(profile)}\nHistorical Baselines: ${historicalContext}\nData Chunk [${i + 1}/${chunks.length}]:\n${chunk}`;

                return analyst.run(analystPrompt, context, { responseMimeType: "application/json" })
                    .then(rawOutput => {
                        const parsed = AnalystResponseSchema.safeParse(rawOutput);
                        if (!parsed.success) {
                            console.warn(`[${analyst.role}] Output failed Zod schema validation:`, parsed.error);
                            const issues = (parsed.error as any).issues || (parsed.error as any).errors || [];
                            return {
                                insights: [`${analyst.role} provided invalid schema. Validation errors: ${issues.map((e: any) => e.message).join(', ')}`],
                                anomalies: [],
                                summary: "Schema validation failed."
                            };
                        }
                        return parsed.data;
                    })
                    .catch(err => ({
                        insights: [`${analyst.role} was unable to process this chunk due to API constraints.`],
                        anomalies: [],
                        summary: `Failed to process: ${err.message || String(err)}`
                    }));
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

        if (deepAnalysisRequested && analysts.length > 0) {
            const criticAgent = analysts[0];
            criticAgent.setSystemInstruction("You are the Swarm Verification Critic. Audit proposed analyses strictly against the raw data, historical baselines, and analyst reports. Flag discrepancies, missed anomalies, or schema violations.");

            const lifecycle = new AnalysisLifecycle(managerAgent, criticAgent, 2);
            context.addEvent({
                agentRole: 'Analysis Lifecycle',
                action: 'Deep Analysis Verification Loop Started',
                modelName: `${managerAgent.modelName} (Proposer) vs ${criticAgent.modelName} (Critic)`,
                prompt: `Auditing synthesized proposal against raw findings (max 2 attempts)`
            });

            const lifecycleResult = await lifecycle.executeAndVerify(
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
            memoryCortex.store(
                `Task: ${task}\nResult: ${finalAnalysis.ui_title || 'Analysis complete'}`,
                { domain: 'analysis', agentRole: 'Manager Node', complexity, verified: deepAnalysisRequested }
            ).catch(() => {});
        }
    } catch (swarmErr) {
        console.error("Swarm execution failed:", swarmErr);
    }

    return {
        events: context.events,
        finalAnalysis
    };
}
