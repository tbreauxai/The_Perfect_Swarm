const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const target1 = `    const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey;
    const geminiKey = settings?.geminiApiKey || (!hasUserKeys ? process.env.GEMINI_API_KEY : undefined);

    if (!geminiKey && !settings?.openRouterApiKey && !settings?.groqApiKey) {
      return res.status(401).json({ error: 'No AI API keys provided in environment or settings.' });
    }

    if (!task) {
        return res.status(400).json({ error: 'Task is required.' });
    }

    // Initialize request-specific Gemini client
    const ai = geminiKey ? new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    }) : defaultAi;`;

const replacement1 = `    const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey || (settings?.vertexProjectId && settings?.vertexAccessToken);
    const geminiKey = settings?.geminiApiKey || (!hasUserKeys && !settings?.vertexAccessToken ? process.env.GEMINI_API_KEY : undefined);

    if (!geminiKey && !settings?.openRouterApiKey && !settings?.groqApiKey && !settings?.vertexAccessToken) {
      return res.status(401).json({ error: 'No AI API keys or Vertex Tokens provided in environment or settings.' });
    }

    if (!task) {
        return res.status(400).json({ error: 'Task is required.' });
    }

    // Initialize request-specific Gemini client (AI Studio or Vertex)
    let ai;
    if (settings?.vertexProjectId && settings?.vertexAccessToken) {
        ai = new GoogleGenAI({
            vertexai: true,
            project: settings.vertexProjectId,
            location: settings.vertexLocation || 'us-central1',
            httpOptions: { 
                headers: { 
                    'Authorization': \`Bearer \${settings.vertexAccessToken}\`,
                    'User-Agent': 'aistudio-build' 
                } 
            }
        });
    } else if (geminiKey) {
        ai = new GoogleGenAI({
            apiKey: geminiKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
        });
    } else {
        ai = defaultAi;
    }`;

code = code.replace(target1, replacement1);

const target2 = `    let lightProvider: 'gemini' | 'groq' | 'openrouter';
    let lightModel: string;
    let lightKey: string;
    let lightAiClient: any;

    if (geminiKey) {
        lightProvider = 'gemini';
        lightModel = 'gemini-flash-latest';
        lightKey = geminiKey;
        lightAiClient = ai;
    }`;

const replacement2 = `    let lightProvider: 'gemini' | 'groq' | 'openrouter';
    let lightModel: string;
    let lightKey: string;
    let lightAiClient: any;

    if (settings?.vertexProjectId && settings?.vertexAccessToken) {
        lightProvider = 'gemini';
        lightModel = 'gemini-2.5-flash'; // Note: Vertex often prefers concrete version tags
        lightKey = 'vertex-token-provided';
        lightAiClient = ai;
    } else if (geminiKey) {
        lightProvider = 'gemini';
        lightModel = 'gemini-flash-latest';
        lightKey = geminiKey;
        lightAiClient = ai;
    }`;
code = code.replace(target2, replacement2);

const target3 = `    // 3. Analysts (Heavy Models)
    const analysts: Agent[] = [];
    if (geminiKey) analysts.push(new Agent('Gemini Analyst', 'gemini-3.1-pro-preview', 'gemini', geminiKey, ai));`;

const replacement3 = `    // 3. Analysts (Heavy Models)
    const analysts: Agent[] = [];
    if (settings?.vertexProjectId && settings?.vertexAccessToken) {
        analysts.push(new Agent('Gemini Analyst (Vertex)', 'gemini-2.5-pro', 'gemini', 'vertex-token', ai));
    } else if (geminiKey) {
        analysts.push(new Agent('Gemini Analyst', 'gemini-3.1-pro-preview', 'gemini', geminiKey, ai));
    }`;
code = code.replace(target3, replacement3);

fs.writeFileSync('server.ts', code);
