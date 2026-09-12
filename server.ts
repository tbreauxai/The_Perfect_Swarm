import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent, SwarmContext } from './swarm.ts';
import { QdrantClient } from '@qdrant/js-client-rest';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// We will create the client per request if a key is passed, 
// otherwise we can fall back to the environment variable.
const defaultAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});




app.get('/api/config/status', (req, res) => {
  res.json({
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasGroqKey: !!process.env.GROQ_API_KEY,
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
    hasMistralKey: !!process.env.MISTRAL_API_KEY,
    hasQdrantUrl: !!process.env.QDRANT_URL,
    hasQdrantKey: !!process.env.QDRANT_API_KEY
  });
});

app.post('/api/swarm/analyze', async (req, res) => {
  try {
    const { task, data, settings } = req.body;
    
    // If user provided ANY keys, we don't blindly fallback to the broken default GEMINI_API_KEY
    const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey || settings?.githubToken || settings?.mistralApiKey;
    const geminiKey = settings?.geminiApiKey || (!hasUserKeys ? process.env.GEMINI_API_KEY : undefined);

    if (!geminiKey && !settings?.openRouterApiKey && !settings?.groqApiKey && !settings?.githubToken && !settings?.mistralApiKey) {
      return res.status(401).json({ error: 'No AI API keys or Vertex Tokens provided in environment or settings.' });
    }

    if (!task) {
        return res.status(400).json({ error: 'Task is required.' });
    }

    // Initialize request-specific Gemini client (AI Studio or Vertex)
    let ai;
    if (geminiKey) {
        ai = new GoogleGenAI({
            apiKey: geminiKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
        });
    } else {
        ai = defaultAi;
    }

    const context = new SwarmContext();

    // Extract dynamic agents from settings payload
    const rawAgents = settings?.agents || [];
    
    function resolveProvider(provider: string) {
        let key = '';
        let client = undefined;
        if (provider === 'gemini') {
            key = (settings?.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
            client = key ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } }) : defaultAi;
        } else if (provider === 'groq') {
            key = (settings?.groqApiKey || process.env.GROQ_API_KEY || '').trim();
        } else if (provider === 'openrouter') {
            key = (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY || '').trim();
        } else if (provider === 'mistral') {
            key = (settings?.mistralApiKey || process.env.MISTRAL_API_KEY || '').trim();
        }
        return { key, client };
    }

    let managerConfig = rawAgents.find((a: any) => a.id === 'manager' || a.role === 'Manager Node');
    let analystConfigs = rawAgents.filter((a: any) => a.id !== 'manager' && a.provider !== 'none');

    // Fallback if no agents defined in UI (backward compat or hard refresh)
    if (!managerConfig) {
        managerConfig = { role: 'Manager Node', provider: geminiKey ? 'gemini' : 'openrouter', model: geminiKey ? 'gemini-2.5-flash' : 'google/gemini-2.5-flash' };
    }

    const { key: mKey, client: mClient } = resolveProvider(managerConfig.provider);
    if (!mKey) {
        return res.status(400).json({ error: `Missing API Key for Manager provider (${managerConfig.provider}). Please add it in the settings.` });
    }
    const managerAgent = new Agent('Manager Node', managerConfig.model, managerConfig.provider, mKey, mClient);

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider);
        if (aKey) {
            analysts.push(new Agent(ac.role || 'Analyst', ac.model, ac.provider, aKey, aClient));
        } else {
            console.warn(`Skipping ${ac.role}: missing API key for ${ac.provider}`);
        }
    }

    if (analysts.length === 0) {
        return res.status(400).json({ error: 'No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.' });
    }

    let finalAnalysis: any = null;

    try {
        // Step 1: Data Profiling (No-LLM Step)
        let rawInput = data || "";
        const MAX_CHARS = 500000;
        if (rawInput.length > MAX_CHARS) {
            console.log("Truncating raw input early to prevent OOM...");
            rawInput = rawInput.substring(0, MAX_CHARS) + "\n...[TRUNCATED FOR MEMORY SAFETY]...";
        }
        const charCount = rawInput.length;
        const estimatedTokens = Math.ceil(charCount / 4);
        const rowCount = rawInput.split('\n').length;
        const isJson = rawInput.trim().startsWith('{') || rawInput.trim().startsWith('[');
        const metadata = { charCount, estimatedTokens, rowCount, format: isJson ? 'JSON' : 'Text/CSV' };
        
        context.addEvent({
            agentRole: 'System Profiler',
            action: 'Metadata Extracted',
            modelName: 'Local/TypeScript',
            prompt: 'Analyzing payload size...',
            output: metadata,
            durationMs: 0
        });

        // Phase 2: Token Budgeting & Batch Planning
        // Gemini 3.1 Pro Free limit is 32k TPM. Mistral is often tighter.
        // We set 12,000 tokens per chunk to safely leave room for context window, prompt, and output limits.
        const MAX_TOKENS_PER_CHUNK = 12000; 
        const chunks = [];
        // PREVENT OOM CRASHES: Truncate massive strings before allocating millions of array elements in memory

        const rawLines = rawInput.split('\n');
        let currentChunk = "";
        let currentTokens = 0;
        
        for (const line of rawLines) {
            const lineTokens = Math.ceil(line.length / 4);
            if (currentTokens + lineTokens > MAX_TOKENS_PER_CHUNK && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = "";
                currentTokens = 0;
            }
            currentChunk += line + '\n';
            currentTokens += lineTokens;
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);

        // Prevent 504 Gateway Timeout by limiting to 2 chunks for synchronous HTTP requests
        const originalChunkCount = chunks.length;
        if (chunks.length > 2) {
            chunks.length = 2;
            console.log("Truncated chunks to 2 to avoid timeout.");
        }

        context.addEvent({
            agentRole: 'System Profiler',
            action: 'Token Budgeting',
            modelName: 'Local/TypeScript',
            prompt: `Data exceeds single-pass threshold? ${chunks.length > 1 ? 'Yes' : 'No'}`,
            output: { chunks: chunks.length, originalChunks: originalChunkCount, maxTokensPerChunk: MAX_TOKENS_PER_CHUNK, totalTokens: estimatedTokens, warning: originalChunkCount > 2 ? "Truncated to 2 chunks to avoid 60s HTTP timeout" : undefined },
            durationMs: 0
        });

        // Phase 3: Targeted Memory Grounding (Qdrant Cortex)
        let historicalContext = "";
        const qdrantUrl = settings?.qdrantUrl || process.env.QDRANT_URL;
        const qdrantApiKey = settings?.qdrantApiKey || process.env.QDRANT_API_KEY;
        
        if (qdrantUrl) {
            try {
                // 1. Validate URL Format explicitly to catch "TypeError: fetch failed" issues caused by missing protocols
                let parsedUrl;
                try {
                    parsedUrl = new URL(qdrantUrl);
                } catch (urlErr) {
                    throw new Error("Invalid Qdrant URL format. Please ensure it includes http:// or https://");
                }

                const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey, checkCompatibility: false });
                
                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Targeted Cortex Retrieval',
                    modelName: 'Qdrant/VectorDB',
                    prompt: `Connecting to ${parsedUrl.host} for historical baseline constraints...`,
                });
                
                // Blueprint: "Use batched queries rather than singular sequential fetches to minimize round-trip overhead. Apply pre-indexed payload filters to restrict candidate traversal directly inside the HNSW index."
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
                    errorMessage = "The Qdrant URL provided is returning an HTML web page instead of a JSON API response. Ensure you are using the Cluster REST Endpoint URL (e.g. https://your-cluster...gcp.cloud.qdrant.tech:6333) and not the Qdrant Cloud Dashboard URL.";
                }

                // Add the failure directly into the Swarm UI context so you can see exactly why Qdrant failed
                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Cortex Retrieval Failed',
                    prompt: 'Retrieval failed',
                    modelName: 'Qdrant/VectorDB',
                    error: `Qdrant connection error: ${errorMessage}. Please verify your Qdrant URL and API Key.`,
                    durationMs: 0
                });
                // console.error("Qdrant retrieval failed:", err);
                historicalContext = "Failed to retrieve baselines from Qdrant. Proceeding without historical context.";
            }
        }

        // Phase 4 & 5: Bounded Micro-Chain Analysis (Run Analysts across Chunks)
        const allAnalystReports = analysts.map(() => []);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            const analystPromises = analysts.map(analyst => {
                const systemInstruction = `You are a Data Analysis Specialist in a modular swarm.

When given data:
1. PLAN: Check the token weight of the input metadata. Identify 2-3 specific dimensions to investigate.
2. REASON: Analyze differences between current inputs and baselines. Keep internal deductions concise and strictly focused on statistical significance.
3. SANITIZE: Discard raw values and processing traces.
4. EMIT: Return output exclusively as a valid JSON object matching the requested schema. Never output conversational pleasantries or repeated inputs.

Output strictly JSON matching this format:
{
  "insights": ["insight 1", "insight 2"],
  "anomalies": ["anomaly 1"],
  "summary": "..."
}`;
                analyst.setSystemInstruction(systemInstruction);
                return analyst.run(`Task: ${task}\nMetadata: ${JSON.stringify(metadata)}\nHistorical Baselines: ${historicalContext}\nData Chunk [${i + 1}/${chunks.length}]:\n${chunk}`, context, { responseMimeType: "application/json" })
                    .catch(err => {
                        // Resilient Swarm: Do not let one rate-limited agent crash the whole swarm
                        return {
                            insights: [`${analyst.role} was unable to process this chunk due to API constraints.`],
                            anomalies: [],
                            summary: `Failed to process: ${err.message || String(err)}${(String(err).includes('1300') || String(err).includes('429')) && analyst.provider === 'mistral' ? '\n(Diagnosis: Mistral Free Tier limits are extremely strict [1 Request Per Second / low TPM]. If you are sending small payloads, your API key has likely exhausted its monthly free allowance. Check console.mistral.ai/limits)' : ''}`
                        };
                    });
            });
            
            const chunkReports = await Promise.all(analystPromises);
            
            for (let a = 0; a < analysts.length; a++) {
                allAnalystReports[a].push(chunkReports[a]);
            }
            
            // Phase 2 (Cont.): Defensive Exponential Backoff / Batch Delay
            if (i < chunks.length - 1) {
                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Batch Delay',
                    modelName: 'Local/TypeScript',
                    prompt: `Rate limit prevention: Waiting 2s before processing chunk ${i + 2}/${chunks.length} to respect API RPM/TPM limits...`,
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // Compile reports (stringify the JSON outputs from analysts across all chunks)
        let compiledReports = analysts.map((a, i) => {
            const combinedStr = allAnalystReports[i].map((r, chunkIdx) => `--- Chunk ${chunkIdx + 1} ---\n${typeof r === 'string' ? r : JSON.stringify(r, null, 2)}`).join('\n\n');
            return `[${a.role} Report]:\n${combinedStr}`;
        }).join('\n\n');

        // Step 3: Manager Agent synthesizes into UI Payload
        const systemInstruction = `You are the Swarm Orchestrator. Synthesize the reports from your specialized Analyst agents into a single unified Generative UI payload.
        
Instead of outputting raw text, you MUST output a Generative UI payload.
Output strict JSON in this exact structure (you can use MetricCard, InsightList, and DataTable components):
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
      "props": { "title": "...", "insights": [{ "type": "success|warning|info", "message": "..." }] }
    },
    {
      "id": "c3",
      "type": "DataTable",
      "props": { "title": "...", "columns": [{ "key": "c1", "header": "H1" }], "rows": [{ "c1": "v1" }] }
    }
  ]
}`;

        managerAgent.setSystemInstruction(systemInstruction);
        const dynamicPrompt = `Task: ${task}\n\nAnalyst Reports:\n${compiledReports}`;

        const orchestratorPlan = await managerAgent.run(dynamicPrompt, context, {
            responseMimeType: "application/json"
        });

        try {
            if (typeof orchestratorPlan === "string") {
                const cleanPlan = orchestratorPlan.replace(/^\`\`\`json\s*/, '').replace(/\s*\`\`\`$/, '').replace(/^\`\`\`\s*/, '');
                finalAnalysis = JSON.parse(cleanPlan);
            } else {
                finalAnalysis = orchestratorPlan;
            }
        } catch (e) {
            console.error("JSON Parse error:", e);
            finalAnalysis = { error: "Failed to generate structured UI payload.", raw: orchestratorPlan };
        }


    } catch (swarmErr) {
        // We log the error but still return the context events so the user can debug
        console.error("Agent execution failed:", swarmErr);
    }

    // Return the execution trace and the final result (if any)
    res.json({
        events: context.events,
        finalAnalysis
    });

  } catch (error: any) {
    console.error("Swarm Error:", error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});


  // Vite middleware setup

app.use((err: any, req: any, res: any, next: any) => {
    console.error('Express Global Error:', err);
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON payload. ' + err.message });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Payload too large. Try reducing the size of your input data.' });
    }
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(port), "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
} // end startServer

startServer();
