const fs = require('fs');

// 1. swarm.ts
let swarm = fs.readFileSync('swarm.ts', 'utf-8');
swarm = swarm.replace(" | 'xai'", "");
swarm = swarm.replace("this.provider === 'mistral' || this.provider === 'xai'", "this.provider === 'mistral'");
swarm = swarm.replace(
    /const endpoint = this\.provider === 'mistral'[\s\S]*?'https:\/\/api\.x\.ai\/v1\/chat\/completions';/,
    "const endpoint = 'https://api.mistral.ai/v1/chat/completions';"
);
swarm = swarm.replace(
    /throw new Error\(`\$\\{this\.provider === 'mistral' \? 'Mistral' : 'xAI'\\} API Error: \$\\{errorText\\}`\);/,
    "throw new Error(`Mistral API Error: ${errorText}`);"
);
fs.writeFileSync('swarm.ts', swarm);

// 2. server.ts
let server = fs.readFileSync('server.ts', 'utf-8');
server = server.replace(/\n\s*hasXaiKey: !!process\.env\.XAI_API_KEY,/, "");
server = server.replace(" || settings?.xaiApiKey", "");
server = server.replace(" && !settings?.xaiApiKey", "");
server = server.replace(" | 'xai'", "");
server = server.replace(/(\s*if \(settings\?\.xaiApiKey \|\| process\.env\.XAI_API_KEY\) \{[\s\S]*?\}\n)/g, "\n");
fs.writeFileSync('server.ts', server);

// 3. src/App.tsx
let app = fs.readFileSync('src/App.tsx', 'utf-8');
app = app.replace(/\n\s*xaiApiKey: '',/, "");

const xaiBlockRegex = /\s*<div>\s*<div className="flex items-center justify-between mb-1">\s*<label className="block text-sm font-medium text-neutral-700">xAI \(Grok\) API Key<\/label>\s*\{envStatus\.hasXaiKey[^}]+\}\s*<\/div>\s*<input[^>]+onChange=\{\(e\) => updateSetting\('xaiApiKey', e\.target\.value\)\}[^>]+>\s*<\/div>/g;
app = app.replace(xaiBlockRegex, "");
fs.writeFileSync('src/App.tsx', app);
