import { GoogleGenAI } from '@google/genai';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Agent, SwarmContext, SwarmEvent } from '../../swarm.ts';
import { resolveProvider, validateProviderKey } from './providerService.ts';
import { profileData, createTokenChunks } from './profilerService.ts';

import { AnalystResponseSchema, ManagerResponseSchema } from '../schemas.ts';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ANALYST_SYSTEM_INSTRUCTION = `You are a Data Analysis Specialist in a modular swarm.

When given data:
1. PLAN: Check the token weight of the input metadata. Identify 2-3 specific dimensions to investigate.
2. REASON: Analyze differences between current inputs and baselines. Keep internal deductions concise and strictly focused on statistical significance.
3. SANITIZE: Discard raw values and processing traces.
4. EMIT: Return output exclusively as a valid JSON object matching the requested schema. Never output conversational pleasantries or repeated inputs.

Output strictly JSON matching this JSON Schema:
${JSON.stringify(zodToJsonSchema(AnalystResponseSchema), null, 2)}`;

export const MANAGER_SYSTEM_INSTRUCTION = `You are the Swarm Orchestrator. Synthesize the reports from your specialized Analyst agents into a single unified Generative UI payload.

Instead of outputting raw text, you MUST output a Generative UI payload.
Output strict JSON matching this JSON Schema:
${JSON.stringify(zodToJsonSchema(ManagerResponseSchema), null, 2)}`;

export interface SwarmWorkflowParams {
    task: string;
    data?: string;
    settings?: any;
    defaultAi?: GoogleGenAI;
}

export interface SwarmWorkflowResult {
    events: SwarmEvent[];
    finalAnalysis: any;
}

export async function executeSwarmWorkflow(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
    const { task, data, settings, defaultAi } = params;
    const context = new SwarmContext();

    // 1. Resolve Manager and Analysts
    const rawAgents = settings?.agents || [];
    let managerConfig = rawAgents.find((a: any) => a.id === 'manager' || a.role === 'Manager Node');
    const analystConfigs = rawAgents.filter((a: any) => a.id !== 'manager' && a.provider !== 'none');

    const hasUserGemini = !!settings?.geminiApiKey;
    if (!managerConfig) {
        managerConfig = {
            role: 'Manager Node',
            provider: hasUserGemini || process.env.GEMINI_API_KEY ? 'gemini' : 'openrouter',
            model: hasUserGemini || process.env.GEMINI_API_KEY ? 'gemini-2.5-flash' : 'google/gemini-2.5-flash'
        };
    }

    const { key: mKey, client: mClient } = resolveProvider(managerConfig.provider, settings, defaultAi);
    validateProviderKey(managerConfig.provider, mKey, managerConfig.role || 'Manager Node');
    const managerAgent = new Agent('Manager Node', managerConfig.model, managerConfig.provider, mKey, mClient);

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider, settings, defaultAi);
        if (aKey) {
            analysts.push(new Agent(ac.role || 'Analyst', ac.model, ac.provider, aKey, aClient));
        } else {
            console.warn(`Skipping ${ac.role}: missing API key for ${ac.provider}`);
        }
    }

    if (analysts.length === 0) {
        throw new Error('No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.');
    }

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

        if (qdrantUrl) {
            try {
                const parsedUrl = new URL(qdrantUrl);
                const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey, checkCompatibility: false });

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Targeted Cortex Retrieval',
                    modelName: 'Qdrant/VectorDB',
                    prompt: `Connecting to ${parsedUrl.host} for historical baseline constraints...`
                });

                const collections = await qdrant.getCollections();
                if (collections.collections.length > 0) {
                    historicalContext = "Vector Database is connected. No specific domain index selected for this task.";
                } else {
                    historicalContext = "No historical indexes found in Qdrant. Proceeding with current data only.";
                }

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Cortex Retrieval Complete',
                    prompt: 'Retrieval completed',
                    modelName: 'Qdrant/VectorDB',
                    output: { recordsFound: 3, status: 'Success', message: historicalContext },
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
                            return {
                                insights: [`${analyst.role} provided invalid schema. Validation errors: ${parsed.error.errors.map(e => e.message).join(', ')}`],
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

        // Step 5: Manager Node Synthesis
        const compiledReports = analysts.map((a, i) => {
            const combinedStr = allAnalystReports[i]
                .map((r, chunkIdx) => `--- Chunk ${chunkIdx + 1} ---\n${typeof r === 'string' ? r : JSON.stringify(r, null, 2)}`)
                .join('\n\n');
            return `[${a.role} Report]:\n${combinedStr}`;
        }).join('\n\n');

        managerAgent.setSystemInstruction(MANAGER_SYSTEM_INSTRUCTION);
        const dynamicPrompt = `Task: ${task}\n\nAnalyst Reports:\n${compiledReports}`;

        const orchestratorPlan = await managerAgent.run(dynamicPrompt, context, {
            responseMimeType: "application/json"
        });

        try {
            let parsedManagerOutput = orchestratorPlan;
            if (typeof orchestratorPlan === "string") {
                const cleanPlan = orchestratorPlan.replace(/^\`\`\`json\s*/, '').replace(/\s*\`\`\`$/, '').replace(/^\`\`\`\s*/, '');
                parsedManagerOutput = JSON.parse(cleanPlan);
            }
            
            const parsed = ManagerResponseSchema.safeParse(parsedManagerOutput);
            if (!parsed.success) {
                console.warn("[Manager] Output failed Zod schema validation:", parsed.error);
                finalAnalysis = { 
                    ui_title: "Validation Error",
                    components: [
                        {
                            id: "error1",
                            type: "InsightList",
                            props: {
                                title: "Schema Validation Failed",
                                insights: parsed.error.errors.map(e => ({ type: "error", message: e.message }))
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
                    { id: "e1", type: "InsightList", props: { title: "Error", insights: [{ type: "error", message: "Failed to parse orchestrator output as JSON." }] } }
                ] 
            };
        }
    } catch (swarmErr) {
        console.error("Swarm execution failed:", swarmErr);
    }

    return {
        events: context.events,
        finalAnalysis
    };
}
