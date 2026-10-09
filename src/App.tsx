/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Loader2, BrainCircuit, FileText, Activity, AlertCircle, Settings, Square } from 'lucide-react';
import { SettingsModal } from './components/SettingsModal';
import { SwarmEventTimeline } from './components/SwarmEventTimeline';
import { AnalysisViewer } from './components/AnalysisViewer';
import { useSwarmSettings } from './hooks/useSwarmSettings';
import { useSwarmExecution } from './hooks/useSwarmExecution';

const CortexDiagnosticsViewer = React.lazy(() => import('./components/CortexDiagnosticsViewer').then(module => ({ default: module.CortexDiagnosticsViewer })));
const OptimizationRunner = React.lazy(() => import('./components/optimization/OptimizationRunner').then(module => ({ default: module.OptimizationRunner })));

export default function App() {
  const [activeTab, setActiveTab] = useState<'trace' | 'optimization'>('trace');
  const [task, setTask] = useState('');
  const [data, setData] = useState('');

  const {
    settings,
    updateSetting,
    updateAgent,
    applyModelToSettings,
    showSettings,
    setShowSettings,
    envStatus
  } = useSwarmSettings();

  const {
    loading,
    events,
    finalAnalysis,
    progressiveStage,
    error,
    expandedEvents,
    toggleEvent,
    runSwarm,
    cancelSwarm
  } = useSwarmExecution();

  const MAX_DATA_CHARS = 500000;
  const MAX_TASK_CHARS = 20000;

  const isDataOverLimit = data.length > MAX_DATA_CHARS;
  const isTaskOverLimit = task.length > MAX_TASK_CHARS;
  const isOverLimit = isDataOverLimit || isTaskOverLimit;

  const overLimitMessage = isDataOverLimit && isTaskOverLimit
    ? `Raw Data exceeds ${MAX_DATA_CHARS.toLocaleString()} characters and Objective exceeds ${MAX_TASK_CHARS.toLocaleString()} characters.`
    : isDataOverLimit
    ? `Raw Data exceeds maximum allowed size (${MAX_DATA_CHARS.toLocaleString()} characters).`
    : isTaskOverLimit
    ? `Objective exceeds maximum allowed size (${MAX_TASK_CHARS.toLocaleString()} characters).`
    : '';

  const handleRunSwarm = () => {
    if (isOverLimit) return;
    runSwarm(task, data, settings);
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
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-sm font-medium text-neutral-700">
                      Raw Data
                    </label>
                    <span className={`text-xs ${isDataOverLimit ? 'text-red-600 font-semibold' : 'text-neutral-500'}`}>
                      {`${data.length.toLocaleString()} / ${MAX_DATA_CHARS.toLocaleString()}`}
                    </span>
                  </div>
                  <textarea
                    className={`w-full h-48 px-4 py-3 rounded-xl border transition-colors outline-none resize-none font-mono text-sm ${
                      isDataOverLimit
                        ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-200'
                        : 'border-neutral-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200'
                    }`}
                    placeholder="Paste your raw data here (logs, text, CSV, etc.)..."
                    value={data}
                    onChange={(e) => setData(e.target.value)}
                  />
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-sm font-medium text-neutral-700">
                      Objective / Task
                    </label>
                    <span className={`text-xs ${isTaskOverLimit ? 'text-red-600 font-semibold' : 'text-neutral-500'}`}>
                      {`${task.length.toLocaleString()} / ${MAX_TASK_CHARS.toLocaleString()}`}
                    </span>
                  </div>
                  <input
                    type="text"
                    className={`w-full px-4 py-3 rounded-xl border transition-colors outline-none ${
                      isTaskOverLimit
                        ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-200'
                        : 'border-neutral-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200'
                    }`}
                    placeholder="e.g., Extract sentiments."
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                  />
                </div>

                {isOverLimit && (
                  <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 text-sm flex gap-2">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <span>{overLimitMessage}</span>
                  </div>
                )}

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
                    onClick={handleRunSwarm}
                    disabled={loading || isOverLimit}
                    type="button"
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
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
            {/* Real-time Diagnostics Widget */}
            <React.Suspense fallback={<div className="p-8 text-center text-neutral-500">Loading diagnostics...</div>}>
              <CortexDiagnosticsViewer />
            </React.Suspense>
          </div>

          {/* Right Column: Execution Trace and Analysis Output */}
          <div className="lg:col-span-8 space-y-6">
            <div className="flex gap-4 mb-4 border-b border-neutral-200">
              <button
                className={`pb-2 ${activeTab === 'trace' ? 'border-b-2 border-indigo-600 font-semibold text-neutral-900' : 'text-neutral-500 hover:text-neutral-700'}`}
                onClick={() => setActiveTab('trace')}
              >
                Execution Trace
              </button>
              <button
                className={`pb-2 ${activeTab === 'optimization' ? 'border-b-2 border-indigo-600 font-semibold text-neutral-900' : 'text-neutral-500 hover:text-neutral-700'}`}
                onClick={() => setActiveTab('optimization')}
              >
                Optimizer
              </button>
            </div>

            <div className={activeTab === 'trace' ? 'block' : 'hidden'}>
              {(() => {
                const routerEvent = events.find(e => e.agentRole === 'Model Router');
                const routerDecision = routerEvent ? {
                  complexity: routerEvent.output?.complexity || (routerEvent.action.includes('Fast-Path') ? 'instant' : 'complex'),
                  isFastPath: routerEvent.action.includes('Fast-Path') || routerEvent.output?.fastPath?.eligible === true,
                  reason: routerEvent.output?.reason || (routerEvent.action.includes('Fast-Path') ? 'Single analyst fast-path short-circuit' : 'Full multi-agent swarm synthesis')
                } : null;

                return (events.length > 0 || finalAnalysis || progressiveStage?.digests) ? (
                  <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-200">
                    <h2 className="text-xl font-medium flex items-center justify-between border-b border-neutral-100 pb-4 mb-6">
                      <span className="flex items-center gap-2">
                        <Activity className="w-5 h-5 text-indigo-600" />
                        Execution Trace
                      </span>
                      <div className="flex items-center gap-2">
                        {routerDecision && (
                          <span
                            className={`text-xs font-medium px-2.5 py-1 rounded-full border flex items-center gap-1.5 ${
                              routerDecision.isFastPath
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-purple-50 text-purple-700 border-purple-200'
                            }`}
                            title={`Model Router: ${routerDecision.reason}`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-current" />
                            <span>Route: {routerDecision.isFastPath ? '⚡ Fast Path' : '🌐 Full Swarm'}</span>
                            <span className="opacity-70">({routerDecision.complexity})</span>
                          </span>
                        )}
                        {loading && (
                          <span className="text-xs font-normal text-indigo-600 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-full flex items-center gap-1.5 animate-pulse">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Live Swarm Streaming
                          </span>
                        )}
                      </div>
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
                );
              })()}
            </div>

            <div className={activeTab === 'optimization' ? 'block bg-white p-6 rounded-2xl shadow-sm border border-neutral-200' : 'hidden'}>
               <React.Suspense fallback={<div className="p-8 text-center text-neutral-500">Loading optimizer...</div>}>
               <OptimizationRunner
                 task={task}
                 data={data}
                 settings={settings}
                 onApplyModelToSettings={applyModelToSettings}
               />
             </React.Suspense>
            </div>
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
