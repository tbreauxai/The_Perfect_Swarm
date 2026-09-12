const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

// Update State
code = code.replace(
`  const [settings, setSettings] = useState({
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    mistralApiKey: '',
    qdrantUrl: '',
    qdrantApiKey: '',
    githubToken: ''
  });`,
`  const [settings, setSettings] = useState({
    geminiApiKey: '',
    geminiModel: 'gemini-3.1-pro-preview',
    openRouterApiKey: '',
    openRouterModel: 'google/gemma-2-9b-it:free',
    groqApiKey: '',
    groqModel: 'openai/gpt-oss-120b',
    mistralApiKey: '',
    mistralModel: 'mistral-small-latest',
    qdrantUrl: '',
    qdrantApiKey: '',
    githubToken: ''
  });`
);

// We want to replace the whole AI Providers section.
// The easiest way is to use a regex to match from `<div className="space-y-4 pt-4">` to `{/* Vector DB Section */}`
const newProvidersUI = `<div className="space-y-4 pt-4">
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                  <Cpu className="w-4 h-4" /> AI Providers & Models
                </h3>
                
                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-neutral-900 font-semibold">Gemini</label>
                    {envStatus.hasGeminiKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">API Key</label>
                        <input type="password" value={settings.geminiApiKey || ''} onChange={(e) => updateSetting('geminiApiKey', e.target.value)} placeholder="AIza..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">Analyst Model</label>
                        <input type="text" value={settings.geminiModel} onChange={(e) => updateSetting('geminiModel', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm font-mono text-neutral-700" />
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-neutral-900 font-semibold">OpenRouter</label>
                    {envStatus.hasOpenRouterKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">API Key</label>
                        <input type="password" value={settings.openRouterApiKey || ''} onChange={(e) => updateSetting('openRouterApiKey', e.target.value)} placeholder="sk-or-v1-..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">Analyst Model</label>
                        <input type="text" value={settings.openRouterModel} onChange={(e) => updateSetting('openRouterModel', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm font-mono text-neutral-700" />
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-neutral-900 font-semibold">Groq</label>
                    {envStatus.hasGroqKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">API Key</label>
                        <input type="password" value={settings.groqApiKey || ''} onChange={(e) => updateSetting('groqApiKey', e.target.value)} placeholder="gsk_..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">Analyst Model</label>
                        <input type="text" value={settings.groqModel} onChange={(e) => updateSetting('groqModel', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm font-mono text-neutral-700" />
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-neutral-900 font-semibold">Mistral</label>
                    {envStatus.hasMistralKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">API Key</label>
                        <input type="password" value={settings.mistralApiKey || ''} onChange={(e) => updateSetting('mistralApiKey', e.target.value)} placeholder="Mistral Key..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-medium text-neutral-500 mb-1">Analyst Model</label>
                        <input type="text" value={settings.mistralModel} onChange={(e) => updateSetting('mistralModel', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm font-mono text-neutral-700" />
                    </div>
                  </div>
                </div>

              </div>

              {/* Vector DB Section */}`;

code = code.replace(/<div className="space-y-4 pt-4">[\s\S]*?\{\/\* Vector DB Section \*\/\}/, newProvidersUI);

fs.writeFileSync('src/App.tsx', code);
console.log("App.tsx patched");
