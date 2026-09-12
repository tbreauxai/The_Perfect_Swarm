const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const target = `    // 3. Analysts (Heavy Models)
    const analysts: Agent[] = [];
    
    // GitHub Models API is retired and has been removed from the swarm.

    if (geminiKey) {
        analysts.push(new Agent('Gemini Analyst', 'gemini-3.1-pro-preview', 'gemini', geminiKey, ai));
    }
    if (settings?.groqApiKey || process.env.GROQ_API_KEY) {
        analysts.push(new Agent('Groq Analyst', 'openai/gpt-oss-120b', 'groq', settings?.groqApiKey || process.env.GROQ_API_KEY as string));
    }
    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }
    if (settings?.mistralApiKey || process.env.MISTRAL_API_KEY) {
        analysts.push(new Agent('Mistral Analyst', 'mistral-small-latest', 'mistral', settings?.mistralApiKey || process.env.MISTRAL_API_KEY as string));
    }`;

const replacement = `    // Read model configurations from frontend or fallback to defaults
    const geminiModel = settings?.geminiModel || 'gemini-3.1-pro-preview';
    const groqModel = settings?.groqModel || 'openai/gpt-oss-120b';
    const openRouterModel = settings?.openRouterModel || 'nvidia/nemotron-3-ultra-550b-a55b:free';
    const mistralModel = settings?.mistralModel || 'mistral-small-latest';

    // 3. Analysts (Heavy Models)
    const analysts: Agent[] = [];
    
    // GitHub Models API is retired and has been removed from the swarm.

    if (geminiKey) {
        analysts.push(new Agent('Gemini Analyst', geminiModel, 'gemini', geminiKey, ai));
    }
    if (settings?.groqApiKey || process.env.GROQ_API_KEY) {
        analysts.push(new Agent('Groq Analyst', groqModel, 'groq', settings?.groqApiKey || process.env.GROQ_API_KEY as string));
    }
    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', openRouterModel, 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }
    if (settings?.mistralApiKey || process.env.MISTRAL_API_KEY) {
        analysts.push(new Agent('Mistral Analyst', mistralModel, 'mistral', settings?.mistralApiKey || process.env.MISTRAL_API_KEY as string));
    }`;

if(code.includes('// 3. Analysts (Heavy Models)')) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server.ts', code);
    console.log("server.ts patched.");
} else {
    console.log("Could not find target string.");
}
