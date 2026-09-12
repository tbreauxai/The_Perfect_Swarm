/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { Loader2, BrainCircuit, FileText, Activity, AlertCircle, Settings } from 'lucide-react';
import { SettingsModal, AppSettings } from './components/SettingsModal';
import { SwarmEventTimeline, SwarmTimelineEvent } from './components/SwarmEventTimeline';
import { AnalysisViewer } from './components/AnalysisViewer';

export default function App() {
  const [task, setTask] = useState('');
  const [data, setData] = useState('');
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<SwarmTimelineEvent[]>([]);
  const [finalAnalysis, setFinalAnalysis] = useState<any>(null);
  const [error, setError] = useState('');

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
    agents: [
      { id: 'manager', role: 'Manager Node', provider: 'gemini', model: 'gemini-2.5-flash' },
      { id: 'a1', role: 'Analyst 1', provider: 'gemini', model: 'gemini-2.5-pro' },
      { id: 'a2', role: 'Analyst 2', provider: 'groq', model: 'openai/gpt-oss-120b' },
      { id: 'a3', role: 'Analyst 3', provider: 'openrouter', model: 'google/gemma-2-9b-it:free' },
      { id: 'a4', role: 'Analyst 4', provider: 'mistral', model: 'mistral-small-latest' }
    ]
  });

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

  const updateSetting = (key: keyof AppSettings, value: string) => {
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

    setLoading(true);
    setError('');
    setEvents([]);
    setFinalAnalysis(null);

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
        throw new Error("The server returned HTML instead of JSON. Check the browser console for details.");
      }
      setEvents(resData.events || []);
      setFinalAnalysis(resData.finalAnalysis || null);
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

          {/* Right Column: Execution Trace and Analysis Output */}
          <div className="lg:col-span-8 space-y-6">
            {(events.length > 0 || finalAnalysis) ? (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200">
                <h2 className="text-xl font-medium flex items-center gap-2 border-b border-neutral-100 pb-4 mb-6">
                  <Activity className="w-5 h-5 text-indigo-600" />
                  Execution Trace
                </h2>

                <SwarmEventTimeline
                  events={events}
                  expandedEvents={expandedEvents}
                  onToggleEvent={toggleEvent}
                />

                <AnalysisViewer finalAnalysis={finalAnalysis} />
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
