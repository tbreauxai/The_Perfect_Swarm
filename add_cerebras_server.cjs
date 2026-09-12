const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

// hasUserKeys check
code = code.replace(
    /const hasUserKeys = settings\?\.geminiApiKey \|\| settings\?\.groqApiKey \|\| settings\?\.openRouterApiKey \|\| settings\?\.githubToken;/,
    "const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey || settings?.githubToken || settings?.cerebrasApiKey;"
);

// Fallback check
code = code.replace(
    /if \(!geminiKey && !settings\?\.openRouterApiKey && !settings\?\.groqApiKey && !settings\?\.githubToken\) {/,
    "if (!geminiKey && !settings?.openRouterApiKey && !settings?.groqApiKey && !settings?.githubToken && !settings?.cerebrasApiKey) {"
);

// lightProvider union type
code = code.replace(
    /let lightProvider: 'gemini' \| 'groq' \| 'openrouter' \| 'github';/,
    "let lightProvider: 'gemini' | 'groq' | 'openrouter' | 'github' | 'cerebras';"
);

// push analyst
const openRouterPush = `    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }`;

const cerebrasPush = `    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }
    if (settings?.cerebrasApiKey || process.env.CEREBRAS_API_KEY) {
        analysts.push(new Agent('Cerebras Analyst', 'llama3.1-70b', 'cerebras', settings?.cerebrasApiKey || process.env.CEREBRAS_API_KEY as string));
    }`;

code = code.replace(openRouterPush, cerebrasPush);

fs.writeFileSync('server.ts', code);
