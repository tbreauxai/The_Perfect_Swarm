/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { Loader2, BrainCircuit, FileText, BarChart, ChevronDown, ChevronRight, Activity, Clock, CheckCircle2, AlertCircle, Settings, X, Database, Bot, Cpu } from 'lucide-react';
import { ComponentRegistry } from './components/generative/ComponentRegistry';

interface SwarmEvent {
    id: string;
    timestamp: string;
    agentRole: string;
    action: string;
    modelName: string;
    prompt: string;
    output?: any;
    error?: string;
    durationMs?: number;
}

export default function App() {
  const [task, setTask] = useState('');
  const [data, setData] = useState('');
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [finalAnalysis, setFinalAnalysis] = useState<any>(null);
  const [error, setError] = useState('');
  
  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [envStatus, setEnvStatus] = useState<any>({});
  
  useEffect(() => {
    fetch('/api/config/status').then(res => res.text()).then(text => { try { setEnvStatus(JSON.parse(text)); } catch(e) { console.error('Config status parse error:', text); } }).catch(console.error);
  }, []);

  const [settings, setSettings] = useState({
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
  };

  // Load settings on mount
  useEffect(() => {
    const saved = localStorage.getItem('swarm_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSettings(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    }
  }, []);

  const updateSetting = (key: keyof typeof settings, value: string) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    localStorage.setItem('swarm_settings', JSON.stringify(newSettings));
  };
  
  // State to track expanded sections
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});

  const toggleEvent = (id: string) => {
      setExpandedEvents(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const runSwarm = async () => {
    if (!task) {
      setError('Please provide a task.');
      return;
    }
    
    setLoading(true);
    setError('');
    setEvents([]);
    setFinalAnalysis('');

    // Prevent 50MB browser uploads from crashing the Express JSON parser or network request
    let safeData = data;
    if (safeData.length > 500000) {
        safeData = safeData.substring(0, 500000) + "\n...[TRUNCATED TO 500KB FOR NETWORK/MEMORY SAFETY]...";
    }

    try {
      const response = await fetch('/api/swarm/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, data: safeData, settings })
      });

      if (!response.ok) {
        let errorMsg = 'Failed to execute swarm.';
        const errorText = await response.text();
        try {
            const errorData = JSON.parse(errorText);
            errorMsg = errorData.error || errorMsg;
        } catch (e) {
            errorMsg = `Server Error (${response.status}): ${errorText.substring(0, 100)}...`;
        }
        throw new Error(errorMsg);
      }

      const rawText = await response.text();
      let resData;
      try {
          resData = JSON.parse(rawText);
      } catch (parseError) {
          console.error("RAW SERVER RESPONSE:", rawText);
          throw new Error("The server returned HTML instead of JSON. Check the browser console for the 'RAW SERVER RESPONSE' to see what the server actually sent.");
      }
      setEvents(resData.events || []);
      setFinalAnalysis(resData.finalAnalysis || '');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        <header className="border-b border-neutral-200 pb-6 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-800 flex items-center gap-3">
              <BrainCircuit className="w-8 h-8 text-indigo-600" />
              AI Swarm Debugger
            </h1>
            <p className="text-neutral-500 mt-2">
              Execute tasks through multiple specialized LLMs and track their logic, inputs, outputs, and errors.
            </p>
          </div>
          <button 
            onClick={() => setShowSettings(true)}
            className="p-2 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-xl transition-colors"
            title="Configure Swarm Settings"
          >
            <Settings className="w-6 h-6" />
          </button>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          <div className="lg:col-span-4 space-y-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 sticky top-8">
              <h2 className="text-xl font-medium mb-4 flex items-center gap-2">
                <FileText className="w-5 h-5 text-neutral-500" />
                Input Data & Task
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">
                    Raw Data
                  </label>
                  <textarea 
                    className="w-full h-48 px-4 py-3 rounded-xl border border-neutral-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-colors outline-none resize-none font-mono text-sm"
                    placeholder="Paste your raw data here (logs, text, CSV, etc.)..."
                    value={data}
                    onChange={(e) => setData(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">
                    Objective / Task
                  </label>
                  <input 
                    type="text"
                    className="w-full px-4 py-3 rounded-xl border border-neutral-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-colors outline-none"
                    placeholder="e.g., Extract sentiments."
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                  />
                </div>

                <button 
                  onClick={runSwarm}
                  disabled={loading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-xl transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Executing...
                    </>
                  ) : (
                    <>
                      Run Swarm
                    </>
                  )}
                </button>
                
                {error && (
                  <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 text-sm flex gap-2">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-8 space-y-6">
            {(events.length > 0 || finalAnalysis) ? (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200">
                <h2 className="text-xl font-medium flex items-center gap-2 border-b border-neutral-100 pb-4 mb-6">
                  <Activity className="w-5 h-5 text-indigo-600" />
                  Execution Trace
                </h2>

                <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-neutral-200 before:to-transparent">
                  {events.map((event, index) => {
                    const isExpanded = expandedEvents[event.id];
                    const isError = !!event.error;
                    const isCompletion = event.action.includes("Completed");
                    
                    return (
                        <div key={event.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                          <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 border-white shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-sm ${isError ? 'bg-red-500' : isCompletion ? 'bg-green-500' : 'bg-blue-500'}`}>
                            {isError ? (
                                <AlertCircle className="w-4 h-4 text-white" />
                            ) : isCompletion ? (
                                <CheckCircle2 className="w-4 h-4 text-white" />
                            ) : (
                                <Loader2 className="w-4 h-4 text-white animate-spin" style={{animationDuration: '3s'}} />
                            )}
                          </div>
                          
                          <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded-xl border border-neutral-200 bg-white shadow-sm hover:shadow-md transition-shadow">
                            <div 
                                className="flex items-center justify-between cursor-pointer"
                                onClick={() => toggleEvent(event.id)}
                            >
                                <div>
                                    <h3 className="font-semibold text-neutral-800 text-sm flex items-center gap-2">
                                        {event.agentRole} <span className="text-xs font-normal text-neutral-500 px-2 py-0.5 bg-neutral-100 rounded-full">{event.modelName}</span>
                                    </h3>
                                    <p className="text-xs text-neutral-500 mt-1">{event.action}</p>
                                </div>
                                <div className="flex items-center gap-3">
                                    {event.durationMs && (
                                        <span className="text-xs text-neutral-400 flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            {event.durationMs}ms
                                        </span>
                                    )}
                                    {isExpanded ? <ChevronDown className="w-4 h-4 text-neutral-400" /> : <ChevronRight className="w-4 h-4 text-neutral-400" />}
                                </div>
                            </div>
                            
                            {isExpanded && (
                                <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4 text-sm">
                                    {event.prompt && (
                                        <div>
                                            <span className="font-semibold text-neutral-700 block mb-1">Prompt:</span>
                                            <pre className="bg-neutral-50 p-3 rounded-lg border border-neutral-100 text-xs text-neutral-600 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
                                                {event.prompt}
                                            </pre>
                                        </div>
                                    )}
                                    {event.output && (
                                        <div>
                                            <span className="font-semibold text-green-700 block mb-1">Output:</span>
                                            <pre className="bg-green-50 p-3 rounded-lg border border-green-100 text-xs text-green-800 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
                                                {typeof event.output === 'object' ? JSON.stringify(event.output, null, 2) : event.output}
                                            </pre>
                                        </div>
                                    )}
                                    {event.error && (
                                        <div>
                                            <span className="font-semibold text-red-700 block mb-1">Error:</span>
                                            <div className="bg-red-50 p-3 rounded-lg border border-red-100 text-xs text-red-700 font-mono">
                                                {event.error}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                          </div>
                        </div>
                    );
                  })}
                </div>

                {finalAnalysis && (
                    <div className="mt-8 pt-6 border-t border-neutral-200">
                        <h3 className="text-lg font-semibold text-neutral-800 mb-4 flex items-center gap-2">
                            <BarChart className="w-5 h-5 text-indigo-600" />
                            {finalAnalysis.ui_title || "Generated Dashboard"}
                        </h3>
                        
                        {finalAnalysis.error ? (
                          <div className="bg-red-50 p-5 rounded-xl border border-red-100 text-red-800 text-sm whitespace-pre-wrap leading-relaxed">
                              {finalAnalysis.error}
                          </div>
                        ) : finalAnalysis.components ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {finalAnalysis.components.map((comp: any) => (
                              <div key={comp.id || Math.random()} className={comp.type === 'DataTable' ? 'md:col-span-2' : ''}>
                                <ComponentRegistry component={comp} />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="bg-indigo-50 p-5 rounded-xl border border-indigo-100 text-neutral-800 text-sm whitespace-pre-wrap leading-relaxed">
                              {JSON.stringify(finalAnalysis, null, 2)}
                          </div>
                        )}
                    </div>
                )}
              </div>
            ) : (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 h-full flex flex-col items-center justify-center text-center space-y-3 min-h-[400px]">
                <div className="w-16 h-16 bg-neutral-50 rounded-full flex items-center justify-center mb-2 border border-neutral-100">
                  <Activity className="w-8 h-8 text-neutral-300" />
                </div>
                <h3 className="text-lg font-medium text-neutral-700">No Traces Yet</h3>
                <p className="text-sm text-neutral-500 max-w-[250px]">
                  Provide data and a task, then execute the swarm to see the detailed execution log.
                </p>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-neutral-100 flex items-center justify-between bg-neutral-50/50">
              <h2 className="text-lg font-semibold text-neutral-800 flex items-center gap-2">
                <Settings className="w-5 h-5 text-neutral-500" />
                Swarm Configuration
              </h2>
              <button 
                onClick={() => setShowSettings(false)}
                className="text-neutral-400 hover:text-neutral-800 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex border-b border-neutral-200">
                <button onClick={() => setActiveTab('keys')} className={`flex-1 py-3 text-sm font-medium ${activeTab === 'keys' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-neutral-500 hover:text-neutral-700'}`}>API Keys</button>
                <button onClick={() => setActiveTab('swarm')} className={`flex-1 py-3 text-sm font-medium ${activeTab === 'swarm' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-neutral-500 hover:text-neutral-700'}`}>Swarm Agents</button>
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
            </div>

            <div className="p-5 border-t border-neutral-100 bg-neutral-50/50">
              <button 
                onClick={() => setShowSettings(false)}
                className="w-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium py-2.5 rounded-xl transition-colors"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
