const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const stateTarget = `  const [settings, setSettings] = useState({
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    qdrantUrl: '',
    qdrantApiKey: ''
  });`;

const stateReplacement = `  const [settings, setSettings] = useState({
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    qdrantUrl: '',
    qdrantApiKey: '',
    vertexProjectId: '',
    vertexLocation: '',
    vertexAccessToken: ''
  });`;

code = code.replace(stateTarget, stateReplacement);

const uiTarget = `                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Gemini API Key</label>
                  <input 
                    type="password" 
                    value={settings.geminiApiKey}
                    onChange={(e) => updateSetting('geminiApiKey', e.target.value)}
                    placeholder="AIza..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>`;

const uiReplacement = `                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Gemini API Key (AI Studio)</label>
                  <input 
                    type="password" 
                    value={settings.geminiApiKey}
                    onChange={(e) => updateSetting('geminiApiKey', e.target.value)}
                    placeholder="AIza..."
                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm transition-shadow"
                  />
                </div>
                
                <div className="pt-4 border-t border-neutral-200 mt-2">
                  <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">Google Cloud Vertex AI</h4>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Project ID</label>
                      <input 
                        type="text" 
                        value={settings.vertexProjectId}
                        onChange={(e) => updateSetting('vertexProjectId', e.target.value)}
                        placeholder="my-gcp-project-123"
                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">Location</label>
                      <input 
                        type="text" 
                        value={settings.vertexLocation}
                        onChange={(e) => updateSetting('vertexLocation', e.target.value)}
                        placeholder="us-central1"
                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">OAuth Access Token</label>
                      <input 
                        type="password" 
                        value={settings.vertexAccessToken}
                        onChange={(e) => updateSetting('vertexAccessToken', e.target.value)}
                        placeholder="ya29.a0..."
                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-sm"
                      />
                    </div>
                  </div>
                </div>`;

code = code.replace(uiTarget, uiReplacement);

fs.writeFileSync('src/App.tsx', code);
