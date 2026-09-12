const fs = require('fs');
let appCode = fs.readFileSync('src/App.tsx', 'utf-8');

// Update initial state
appCode = appCode.replace(
    /githubToken: ''\n  }\);/,
    "githubToken: '',\n    cerebrasApiKey: ''\n  });"
);

// Add UI for Cerebras
const groqUI = `                <div className="pt-4 border-t border-neutral-200 mt-2">
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
                </div>`;

const cerebrasUI = `                <div className="pt-4 border-t border-neutral-200 mt-2">
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

                <div className="pt-4 border-t border-neutral-200 mt-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Cerebras API Key</label>
                  </div>
                  <input 
                    type="password" 
                    value={settings.cerebrasApiKey || ''}
                    onChange={(e) => updateSetting('cerebrasApiKey', e.target.value)}
                    placeholder="csk-..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>`;

appCode = appCode.replace(groqUI, cerebrasUI);
fs.writeFileSync('src/App.tsx', appCode);
