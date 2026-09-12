const fs = require('fs');

let code = fs.readFileSync('src/App.tsx', 'utf-8');

// 1. Update the state initialization
code = code.replace(
    /const \[settings, setSettings\] = useState\(\{[\s\S]*?githubToken: ''\n\s*\}\);/,
    `const [settings, setSettings] = useState({
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    mistralApiKey: '',
    qdrantUrl: '',
    qdrantApiKey: '',
    githubToken: '',
    agents: [
      { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-2.5-flash' },
      { id: 'a1', role: 'Analyst 1', provider: 'gemini', model: 'gemini-2.5-pro' },
      { id: 'a2', role: 'Analyst 2', provider: 'groq', model: 'openai/gpt-oss-120b' },
      { id: 'a3', role: 'Analyst 3', provider: 'openrouter', model: 'google/gemma-2-9b-it:free' },
      { id: 'a4', role: 'Analyst 4', provider: 'mistral', model: 'mistral-small-latest' }
    ]
  });

  const [activeTab, setActiveTab] = useState<'keys'|'swarm'>('keys');

  const updateAgent = (id: string, field: string, value: string) => {
    setSettings(prev => ({
        ...prev,
        agents: prev.agents.map(a => a.id === id ? { ...a, [field]: value } : a)
    }));
  };`
);

// 2. Replace the modal body
const targetModal = `            <div className="p-5 overflow-y-auto space-y-6">
              
              {/* AI APIs Section */}
              <div className="space-y-4 pt-4">
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                  <Bot className="w-4 h-4" /> AI Providers & Models
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

              {/* Vector DB Section */}
              <div className="space-y-4 pt-4 border-t border-neutral-100">
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                  <Database className="w-4 h-4" /> Qdrant Vector DB
                </h3>
                
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Qdrant URL</label>
                    {envStatus.hasQdrantUrl && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <input 
                    type="url" 
                    value={settings.qdrantUrl || ''}
                    onChange={(e) => updateSetting('qdrantUrl', e.target.value)}
                    placeholder="https://your-cluster.qdrant.tech"
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Qdrant API Key</label>
                    {envStatus.hasQdrantKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>
                  <input 
                    type="password" 
                    value={settings.qdrantApiKey || ''}
                    onChange={(e) => updateSetting('qdrantApiKey', e.target.value)}
                    placeholder="API Key"
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>
              </div>
            </div>`;

const newModal = `            <div className="flex border-b border-neutral-200">
                <button onClick={() => setActiveTab('keys')} className={\`flex-1 py-3 text-sm font-medium \${activeTab === 'keys' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-neutral-500 hover:text-neutral-700'}\`}>API Keys</button>
                <button onClick={() => setActiveTab('swarm')} className={\`flex-1 py-3 text-sm font-medium \${activeTab === 'swarm' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-neutral-500 hover:text-neutral-700'}\`}>Swarm Agents</button>
            </div>

            <div className="p-5 overflow-y-auto space-y-6 max-h-[60vh]">
              {activeTab === 'keys' && (
                  <div className="space-y-6">
                      <div className="space-y-4">
                        <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-sm font-medium text-neutral-900 font-semibold">Gemini API Key</label>
                            {envStatus.hasGeminiKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                          </div>
                          <input type="password" value={settings.geminiApiKey || ''} onChange={(e) => updateSetting('geminiApiKey', e.target.value)} placeholder="AIza..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                        </div>
                        
                        <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-sm font-medium text-neutral-900 font-semibold">OpenRouter API Key</label>
                            {envStatus.hasOpenRouterKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                          </div>
                          <input type="password" value={settings.openRouterApiKey || ''} onChange={(e) => updateSetting('openRouterApiKey', e.target.value)} placeholder="sk-or-v1-..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                        </div>
                        
                        <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-sm font-medium text-neutral-900 font-semibold">Groq API Key</label>
                            {envStatus.hasGroqKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                          </div>
                          <input type="password" value={settings.groqApiKey || ''} onChange={(e) => updateSetting('groqApiKey', e.target.value)} placeholder="gsk_..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                        </div>
                        
                        <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-sm font-medium text-neutral-900 font-semibold">Mistral API Key</label>
                            {envStatus.hasMistralKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                          </div>
                          <input type="password" value={settings.mistralApiKey || ''} onChange={(e) => updateSetting('mistralApiKey', e.target.value)} placeholder="Mistral Key..." className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                        </div>
                      </div>

                      <div className="space-y-4 pt-4 border-t border-neutral-100">
                        <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                          <Database className="w-4 h-4" /> Qdrant Vector DB
                        </h3>
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-sm font-medium text-neutral-700">Qdrant URL</label>
                            {envStatus.hasQdrantUrl && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                          </div>
                          <input type="url" value={settings.qdrantUrl || ''} onChange={(e) => updateSetting('qdrantUrl', e.target.value)} placeholder="https://your-cluster.qdrant.tech" className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-sm font-medium text-neutral-700">Qdrant API Key</label>
                            {envStatus.hasQdrantKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                          </div>
                          <input type="password" value={settings.qdrantApiKey || ''} onChange={(e) => updateSetting('qdrantApiKey', e.target.value)} placeholder="API Key" className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm" />
                        </div>
                      </div>
                  </div>
              )}
              {activeTab === 'swarm' && (
                  <div className="space-y-4">
                      {settings.agents?.map(agent => (
                          <div key={agent.id} className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-2">
                              <div className="flex items-center justify-between mb-1">
                                  <label className="text-sm font-semibold text-neutral-900">{agent.role}</label>
                              </div>
                              <div className="flex gap-2">
                                  <div className="w-1/3">
                                      <select value={agent.provider} onChange={e => updateAgent(agent.id, 'provider', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm bg-white focus:border-indigo-500">
                                          <option value="none">None / Disabled</option>
                                          <option value="gemini">Gemini</option>
                                          <option value="groq">Groq</option>
                                          <option value="openrouter">OpenRouter</option>
                                          <option value="mistral">Mistral</option>
                                      </select>
                                  </div>
                                  <div className="w-2/3">
                                      <input type="text" value={agent.model} onChange={e => updateAgent(agent.id, 'model', e.target.value)} disabled={agent.provider === 'none'} className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm font-mono focus:border-indigo-500 disabled:opacity-50 disabled:bg-neutral-100" placeholder="Model Name..." />
                                  </div>
                              </div>
                          </div>
                      ))}
                      <div className="text-xs text-neutral-500 px-1 pt-2">
                          * If an agent's provider is set to "None", it will be skipped during execution. The Manager Node cannot be skipped.
                      </div>
                  </div>
              )}
            </div>`;

code = code.replace(targetModal, newModal);
fs.writeFileSync('src/App.tsx', code);
console.log("Patched UI!");
