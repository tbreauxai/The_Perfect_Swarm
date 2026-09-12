const fs = require('fs');

// swarm.ts update
let swarm = fs.readFileSync('swarm.ts', 'utf-8');
swarm = swarm.replace(
    "export type Provider = 'gemini' | 'groq' | 'openrouter' | 'github';",
    "export type Provider = 'gemini' | 'groq' | 'openrouter' | 'github' | 'mistral' | 'xai';"
);

const newProviders = `
                else if (this.provider === 'mistral' || this.provider === 'xai') {
                    const messages: any[] = [];
                    if (this.systemInstruction) {
                        messages.push({ role: 'system', content: this.systemInstruction });
                    }
                    messages.push({ role: 'user', content: prompt });
                    
                    const endpoint = this.provider === 'mistral' 
                        ? 'https://api.mistral.ai/v1/chat/completions'
                        : 'https://api.x.ai/v1/chat/completions';

                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Authorization': \`Bearer \${this.apiKey}\`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: this.modelName,
                            messages: messages,
                            response_format: config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
                        })
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(\`\${this.provider === 'mistral' ? 'Mistral' : 'xAI'} API Error: \${errorText}\`);
                    }
                    const data = await response.json();
                    textOutput = data.choices[0]?.message?.content || '';
                }`;

swarm = swarm.replace(
    "                else if (this.provider === 'github') {",
    newProviders + "\n                else if (this.provider === 'github') {"
);
fs.writeFileSync('swarm.ts', swarm);

// server.ts update
let server = fs.readFileSync('server.ts', 'utf-8');

// Update /api/config/status
server = server.replace(
    "hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,",
    "hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY,\n    hasMistralKey: !!process.env.MISTRAL_API_KEY,\n    hasXaiKey: !!process.env.XAI_API_KEY,"
);

// Update /api/swarm/analyze key checks
server = server.replace(
    "const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey || settings?.githubToken;",
    "const hasUserKeys = settings?.geminiApiKey || settings?.groqApiKey || settings?.openRouterApiKey || settings?.githubToken || settings?.mistralApiKey || settings?.xaiApiKey;"
);
server = server.replace(
    "if (!geminiKey && !settings?.openRouterApiKey && !settings?.groqApiKey && !settings?.githubToken) {",
    "if (!geminiKey && !settings?.openRouterApiKey && !settings?.groqApiKey && !settings?.githubToken && !settings?.mistralApiKey && !settings?.xaiApiKey) {"
);

server = server.replace(
    "let lightProvider: 'gemini' | 'groq' | 'openrouter' | 'github';",
    "let lightProvider: 'gemini' | 'groq' | 'openrouter' | 'github' | 'mistral' | 'xai';"
);

// Add analysts
const newAnalysts = `
    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }
    if (settings?.mistralApiKey || process.env.MISTRAL_API_KEY) {
        analysts.push(new Agent('Mistral Analyst', 'mistral-small-latest', 'mistral', settings?.mistralApiKey || process.env.MISTRAL_API_KEY as string));
    }
    if (settings?.xaiApiKey || process.env.XAI_API_KEY) {
        analysts.push(new Agent('xAI Analyst', 'grok-beta', 'xai', settings?.xaiApiKey || process.env.XAI_API_KEY as string));
    }
`;

server = server.replace(
    `    if (settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY) {
        analysts.push(new Agent('OpenRouter Analyst', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY as string));
    }`,
    newAnalysts
);

fs.writeFileSync('server.ts', server);

// App.tsx update
let app = fs.readFileSync('src/App.tsx', 'utf-8');

app = app.replace(
    "groqApiKey: '',",
    "groqApiKey: '',\n    mistralApiKey: '',\n    xaiApiKey: '',"
);

const newUIInputs = `
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Mistral API Key</label>
                    {envStatus.hasMistralKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <input 
                    type="password" 
                    value={settings.mistralApiKey || ''}
                    onChange={(e) => updateSetting('mistralApiKey', e.target.value)}
                    placeholder="Mistral Key..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700 flex items-center gap-2">
                      xAI (Grok) API Key
                      <span className="text-[10px] uppercase font-bold tracking-wider text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">Info Share API</span>
                    </label>
                    {envStatus.hasXaiKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <input 
                    type="password" 
                    value={settings.xaiApiKey || ''}
                    onChange={(e) => updateSetting('xaiApiKey', e.target.value)}
                    placeholder="xAI Key..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>
`;

app = app.replace(
    `                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Groq API Key</label>
                    {envStatus.hasGroqKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <input 
                    type="password" 
                    value={settings.groqApiKey || ''}
                    onChange={(e) => updateSetting('groqApiKey', e.target.value)}
                    placeholder="gsk_..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>
              </div>`,
    `                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Groq API Key</label>
                    {envStatus.hasGroqKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <input 
                    type="password" 
                    value={settings.groqApiKey || ''}
                    onChange={(e) => updateSetting('groqApiKey', e.target.value)}
                    placeholder="gsk_..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>${newUIInputs}
              </div>`
);

fs.writeFileSync('src/App.tsx', app);
