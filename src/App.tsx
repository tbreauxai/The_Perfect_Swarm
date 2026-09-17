/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { Loader2, BrainCircuit, FileText, Activity, AlertCircle, Settings, Square } from 'lucide-react';
import { SettingsModal, AppSettings } from './components/SettingsModal';
import { SwarmEventTimeline, SwarmTimelineEvent } from './components/SwarmEventTimeline';
import { AnalysisViewer } from './components/AnalysisViewer';

export default function App() {
  const [task, setTask] = useState('');
  const [data, setData] = useState('');
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<SwarmTimelineEvent[]>([]);
  const [finalAnalysis, setFinalAnalysis] = useState<any>(null);
  const [progressiveStage, setProgressiveStage] = useState<{
    stage: string;
    digests?: Record<string, any>;
    metrics?: any;
  } | null>(null);
  const [error, setError] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelSwarm = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  // Settings & Env State
  const [showSettings, setShowSettings] = useState(false);
  const [envStatus, setEnvStatus] = useState<any>({});

  useEffect(() => {
    fetch('/api/config/status')
      .then(res => res.text())
      .then(text => {
        try {
          setEnvStatus(JSON.parse(text));
        } catch (e) {
          console.error('Config status parse error:', text);
        }
      })
      .catch(console.error);
  }, []);

  const [settings, setSettings] = useState<AppSettings>({
    geminiApiKey: '',
    openRouterApiKey: '',
    groqApiKey: '',
    mistralApiKey: '',
    qdrantUrl: '',
    qdrantApiKey: '',
    githubToken: '',
    appId: 'perfect-swarm',
    disableFallback: false,
    forceFullSwarm: false,
    agents: [
      { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-3.5-flash' },
      { id: 'a1', role: 'Analyst 1', provider: 'gemini', model: 'gemini-3.5-flash' },
      { id: 'a2', role: 'Analyst 2', provider: 'groq', model: 'llama3-70b-8192' },
      { id: 'a3', role: 'Analyst 3', provider: 'openrouter', model: 'google/gemma-2-9b-it:free' },
      { id: 'a4', role: 'Analyst 4', provider: 'mistral', model: 'mistral-small-latest' }
    ]
  });

  // Load settings on mount with automatic migration for fallback settings
  useEffect(() => {
    const saved = localStorage.getItem('swarm_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        let modified = false;

        // Auto-enable fallback if previously defaulted to disabled
        if (parsed.disableFallback === true && !localStorage.getItem('swarm_disable_fallback_explicit')) {
          parsed.disableFallback = false;
          modified = true;
        }

        if (modified) {
          localStorage.setItem('swarm_settings', JSON.stringify(parsed));
        }

        setSettings(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    }
  }, []);

  const updateSetting = (key: keyof AppSettings, value: any) => {
    if (key === 'disableFallback') {
      localStorage.setItem('swarm_disable_fallback_explicit', 'true');
    }
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    localStorage.setItem('swarm_settings', JSON.stringify(newSettings));
  };

  const updateAgent = (id: string, field: string, value: string) => {
    setSettings(prev => {
      const newSettings = {
        ...prev,
        agents: prev.agents.map(a => a.id === id ? { ...a, [field]: value } : a)
      };
      localStorage.setItem('swarm_settings', JSON.stringify(newSettings));
      return newSettings;
    });
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

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError('');
    setEvents([]);
    setFinalAnalysis(null);
    setProgressiveStage(null);

    let safeData = data;
    if (safeData.length > 500000) {
      safeData = safeData.substring(0, 500000) + "\n...[TRUNCATED TO 500KB FOR NETWORK/MEMORY SAFETY]...";
    }

    try {
      const response = await fetch('/api/swarm/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, data: safeData, settings }),
        signal: controller.signal
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

      if (!response.body) {
        throw new Error('No response stream returned by server.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const block of lines) {
          if (!block.trim() || block.startsWith(':')) continue;

          let eventType = 'message';
          let dataStr = '';

          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
              eventType = line.replace('event:', '').trim();
            } else if (line.startsWith('data:')) {
              dataStr = line.replace('data:', '').trim();
            }
          }

          if (!dataStr) continue;

          try {
            const parsedData = JSON.parse(dataStr);
            if (eventType === 'swarm_event') {
              setEvents(prev => [...prev, parsedData]);
            } else if (eventType === 'swarm_stage') {
              setProgressiveStage(parsedData);
            } else if (eventType === 'swarm_complete') {
              setProgressiveStage(null);
              if (parsedData.finalAnalysis) {
                setFinalAnalysis(parsedData.finalAnalysis);
              }
              if (parsedData.events && Array.isArray(parsedData.events)) {
                setEvents(parsedData.events);
              }
            } else if (eventType === 'swarm_error') {
              setError(parsedData.error || 'Swarm execution error');
            }
          } catch (err) {
            console.warn('Error parsing SSE block:', err, block);
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setError('Analysis cancelled by user.');
      } else {
        setError(err.message || 'An unexpected error occurred during execution.');
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
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

          {/* Left Column: Input Form */}
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

                {loading ? (
                  <div className="flex gap-2">
                    <button
                      disabled
                      className="flex-1 bg-indigo-600/85 text-white font-medium py-3 rounded-xl flex items-center justify-center gap-2 cursor-wait"
                    >
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Analyzing ({events.length} {events.length === 1 ? 'event' : 'events'})...
                    </button>
                    <button
                      onClick={cancelSwarm}
                      type="button"
                      className="px-4 bg-red-50 hover:bg-red-100 text-red-700 font-medium py-3 rounded-xl transition-colors border border-red-200 flex items-center justify-center gap-1.5"
                      title="Cancel analysis"
                    >
                      <Square className="w-4 h-4 fill-current" />
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={runSwarm}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    Run Swarm
                  </button>
                )}

                {error && (
                  <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 text-sm flex gap-2">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Execution Trace and Analysis Output */}
          <div className="lg:col-span-8 space-y-6">
            {(events.length > 0 || finalAnalysis || progressiveStage?.digests) ? (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200">
                <h2 className="text-xl font-medium flex items-center justify-between border-b border-neutral-100 pb-4 mb-6">
                  <span className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-indigo-600" />
                    Execution Trace
                  </span>
                  {loading && (
                    <span className="text-xs font-normal text-indigo-600 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-full flex items-center gap-1.5 animate-pulse">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Live Swarm Streaming
                    </span>
                  )}
                </h2>

                <SwarmEventTimeline
                  events={events}
                  expandedEvents={expandedEvents}
                  onToggleEvent={toggleEvent}
                />

                <AnalysisViewer
                  finalAnalysis={finalAnalysis}
                  interimDigests={progressiveStage?.digests}
                  isSynthesizing={loading && progressiveStage?.stage === 'manager_synthesis'}
                />
              </div>
            ) : loading ? (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200 h-full flex flex-col items-center justify-center text-center space-y-3 min-h-[400px]">
                <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center mb-2 border border-indigo-100 animate-pulse">
                  <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                </div>
                <h3 className="text-lg font-medium text-neutral-800">
                  Initializing Swarm Execution...
                </h3>
                <p className="text-sm text-neutral-500 max-w-sm">
                  Connecting to streaming endpoint, profiling payload, and dispatching analysts in real time.
                </p>
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
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onUpdateSetting={updateSetting}
        onUpdateAgent={updateAgent}
        envStatus={envStatus}
      />
    </div>
  );
}
