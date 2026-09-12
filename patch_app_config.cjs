const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf-8');

const stateStr = `  const [settings, setSettings] = useState(() => {`;
const newStateStr = `  const [envStatus, setEnvStatus] = useState<any>({});
  
  useEffect(() => {
    fetch('/api/config/status').then(res => res.json()).then(data => setEnvStatus(data)).catch(console.error);
  }, []);

  const [settings, setSettings] = useState(() => {`;

code = code.replace(stateStr, newStateStr);

const geminiStr = `<label className="block text-sm font-medium text-neutral-700 mb-1">Gemini API Key</label>`;
const newGeminiStr = `<div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Gemini API Key</label>
                    {envStatus.hasGeminiKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>`;
code = code.replace(geminiStr, newGeminiStr);

const groqStr = `<label className="block text-sm font-medium text-neutral-700 mb-1">Groq API Key</label>`;
const newGroqStr = `<div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Groq API Key</label>
                    {envStatus.hasGroqKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>`;
code = code.replace(groqStr, newGroqStr);

const openRouterStr = `<label className="block text-sm font-medium text-neutral-700 mb-1">OpenRouter API Key</label>`;
const newOpenRouterStr = `<div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">OpenRouter API Key</label>
                    {envStatus.hasOpenRouterKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>`;
code = code.replace(openRouterStr, newOpenRouterStr);

const qdrantUrlStr = `<label className="block text-sm font-medium text-neutral-700 mb-1">Qdrant URL</label>`;
const newQdrantUrlStr = `<div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Qdrant URL</label>
                    {envStatus.hasQdrantUrl && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>`;
code = code.replace(qdrantUrlStr, newQdrantUrlStr);

const qdrantKeyStr = `<label className="block text-sm font-medium text-neutral-700 mb-1">Qdrant API Key</label>`;
const newQdrantKeyStr = `<div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-neutral-700">Qdrant API Key</label>
                    {envStatus.hasQdrantKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                  </div>`;
code = code.replace(qdrantKeyStr, newQdrantKeyStr);

fs.writeFileSync('src/App.tsx', code);
