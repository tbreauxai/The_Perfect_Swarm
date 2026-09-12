const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const targetServerLogic = `    // Dynamically pick the best available light model based on provided keys
    let lightProvider: 'gemini' | 'groq' | 'openrouter' | 'github' | 'mistral';
    let lightModel: string;
    let lightKey: string;
    let lightAiClient: any;

    if (geminiKey) {
        lightProvider = 'gemini';
        lightModel = settings?.geminiModel || 'gemini-2.5-pro';
        lightKey = geminiKey;
        lightAiClient = ai;
    } else if (settings?.groqApiKey || process.env.GROQ_API_KEY) {
        lightProvider = 'groq';
        lightModel = settings?.groqModel || 'llama-3.1-8b-instant';
        lightKey = settings?.groqApiKey || process.env.GROQ_API_KEY as string;
    } else {
        lightProvider = 'openrouter';
        lightModel = settings?.openRouterModel || 'google/gemini-2.5-flash';
        lightKey = settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string;
    }

    // 1. Manager (Light Model)
    const managerAgent = new Agent('Manager', lightModel, lightProvider, lightKey, lightAiClient);
    
    // 3. Analysts (Heavy Models)
    const analysts: Agent[] = [];
    // GitHub Models API is retired and has been removed from the swarm.
    if (geminiKey) {
        analysts.push(new Agent('Gemini Analyst', settings?.geminiModel || 'gemini-2.5-pro', 'gemini', geminiKey, ai));
    }
    if (settings?.groqApiKey || process.env.GROQ_API_KEY) {
        analysts.push(new Agent('Groq Analyst', settings?.groqModel || 'openai/gpt-oss-120b', 'groq', settings?.groqApiKey || process.env.GROQ_API_KEY as string));
    }

    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', settings?.openRouterModel || 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }
    if (settings?.mistralApiKey || process.env.MISTRAL_API_KEY) {
        analysts.push(new Agent('Mistral Analyst', settings?.mistralModel || 'mistral-small-latest', 'mistral', settings?.mistralApiKey || process.env.MISTRAL_API_KEY as string));
    }


    if (analysts.length === 0) {
        return res.status(400).json({ error: 'No API keys provided for any Heavy Analyst models.' });
    }`;

const newServerLogic = `    // Extract dynamic agents from settings payload
    const rawAgents = settings?.agents || [];
    
    function resolveProvider(provider: string) {
        let key = '';
        let client = undefined;
        if (provider === 'gemini') {
            key = settings?.geminiApiKey || process.env.GEMINI_API_KEY || '';
            client = key ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } }) : defaultAi;
        } else if (provider === 'groq') {
            key = settings?.groqApiKey || process.env.GROQ_API_KEY || '';
        } else if (provider === 'openrouter') {
            key = settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY || '';
        } else if (provider === 'mistral') {
            key = settings?.mistralApiKey || process.env.MISTRAL_API_KEY || '';
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
        return res.status(400).json({ error: \`Missing API Key for Manager provider (\${managerConfig.provider}). Please add it in the settings.\` });
    }
    const managerAgent = new Agent('Manager Node', managerConfig.model, managerConfig.provider, mKey, mClient);

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider);
        if (aKey) {
            analysts.push(new Agent(ac.role || 'Analyst', ac.model, ac.provider, aKey, aClient));
        } else {
            console.warn(\`Skipping \${ac.role}: missing API key for \${ac.provider}\`);
        }
    }

    if (analysts.length === 0) {
        return res.status(400).json({ error: 'No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.' });
    }`;

code = code.replace(targetServerLogic, newServerLogic);
fs.writeFileSync('server.ts', code);
console.log("Patched server.ts!");
