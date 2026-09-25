import React, { useState, useEffect } from 'react';
import { fetchAvailableModels, checkProviderModelsHealth, ModelOption } from '../../services/providerService';
import { getApiKeyForProvider } from '../AgentConfigurator';
import { Loader2, Play, Trophy, Clock, CheckCircle, AlertCircle, Trash2 } from 'lucide-react';

export interface OptimizationRunnerProps {
    task: string;
    data: string;
    settings: any;
}

export interface OptimizationResult {
    id: string;
    role: string;
    model: string;
    provider: string;
    durationMs: number;
    output: any;
    scores: {
        intelligence: number | null;
        accuracy: number | null;
        speed: number | null;
    };
    error?: string;
    isFullSwarm?: boolean;
}

interface ModelErrorRecord {
    errorCount: number;
    lastError: string;
    provider: string;
}

export const OptimizationRunner: React.FC<OptimizationRunnerProps> = ({ task, data, settings }) => {
    const [results, setResults] = useState<OptimizationResult[]>([]);
    const [history, setHistory] = useState<OptimizationResult[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [progress, setProgress] = useState('');
    const [errorRecords, setErrorRecords] = useState<Record<string, ModelErrorRecord>>({});

    useEffect(() => {
        try {
            const saved = localStorage.getItem('swarm_model_errors');
            if (saved) {
                setErrorRecords(JSON.parse(saved));
            }
            const savedHistory = localStorage.getItem('swarm_optimization_history');
            if (savedHistory) {
                setHistory(JSON.parse(savedHistory));
            }
        } catch (e) {
            console.error("Failed to load local records", e);
        }
    }, []);

    const saveToHistory = (res: OptimizationResult) => {
        setHistory(prev => {
            const updated = [...prev.filter(r => r.id !== res.id), res].sort((a, b) => 
               ((b.scores.intelligence || 0) + (b.scores.accuracy || 0)) - ((a.scores.intelligence || 0) + (a.scores.accuracy || 0))
            );
            const top50 = updated.slice(0, 50);
            try {
                localStorage.setItem('swarm_optimization_history', JSON.stringify(top50));
            } catch (e) {}
            return top50;
        });
    };

    const recordError = (modelId: string, provider: string, errorMsg: string) => {
        setErrorRecords(prev => {
            const current = prev[modelId] || { errorCount: 0, lastError: '', provider };
            const updated = {
                ...prev,
                [modelId]: {
                    errorCount: current.errorCount + 1,
                    lastError: errorMsg,
                    provider
                }
            };
            try {
                localStorage.setItem('swarm_model_errors', JSON.stringify(updated));
            } catch (e) {
                console.error("Failed to save error records", e);
            }
            return updated;
        });
    };

    const clearErrorRecords = () => {
        setErrorRecords({});
        localStorage.removeItem('swarm_model_errors');
    };

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const generateTestPrompt = async (managerAgent: any, analystRole: string, baseTask: string): Promise<string> => {
        try {
            const promptTask = `As the Swarm Manager, generate a highly specific, complex test prompt designed to challenge a sub-agent with the role: "${analystRole}".
The overall system task is: "${baseTask}".
Create a realistic scenario or question that perfectly fits this analyst's domain to test their intelligence and accuracy.
Respond ONLY with the text of the prompt you want to give them.`;

            const res = await fetch('/api/swarm/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task: promptTask,
                    data: '',
                    settings: {
                        ...settings,
                        agents: [{ id: 'grader-agent', role: 'Prompt Generator Node', provider: 'gemini', model: 'gemini-3.5-flash-lite' }],
                        forceFullSwarm: false
                    }
                })
            });

            if (!res.ok) return baseTask;
            const data = await res.json();
            return typeof data.finalAnalysis === 'string' ? data.finalAnalysis : JSON.stringify(data.finalAnalysis);
        } catch (e) {
            console.error("Prompt generation failed", e);
            return baseTask;
        }
    };

    const autoGradeOutput = async (originalTask: string, output: any, durationMs: number, managerAgent: any) => {
        try {
            const gradingTask = `You are grading the output of a subordinate AI analyst.
Original Task: "${originalTask}"
Analyst Execution Time: ${durationMs}ms
Analyst Output:
${typeof output === 'object' ? JSON.stringify(output) : output}

Score the Analyst's output from 1 to 10 in three distinct categories:
1. "intelligence" (How smart, nuanced, and structurally sound the reasoning is)
2. "accuracy" (How factually correct and directly aligned it is with the prompt)
3. "speed" (Based on the ${durationMs}ms execution time. Under 2000ms is a 10, over 10000ms is a 1, scale linearly).

Respond ONLY with a valid JSON object matching this exact format, with no markdown formatting or other text:
{"intelligence": 8, "accuracy": 9, "speed": 5}`;

            const res = await fetch('/api/swarm/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task: gradingTask,
                    data: '',
                    settings: {
                        ...settings,
                        agents: [{ id: 'grader-agent', role: 'Grader Node', provider: 'gemini', model: 'gemini-3.5-flash-lite' }],
                        forceFullSwarm: false
                    }
                })
            });

            if (!res.ok) return null;
            const data = await res.json();

            // Try to parse the JSON output from the manager
            let parsed = null;
            try {
                if (typeof data.finalAnalysis === 'object') {
                    parsed = data.finalAnalysis;
                } else {
                     // strip markdown if they ignored instructions
                     const cleaned = String(data.finalAnalysis).replace(/```json\n?/g, '').replace(/```/g, '').trim();
                     parsed = JSON.parse(cleaned);
                }
            } catch (e) {
                console.warn("Failed to parse grading JSON", e, data.finalAnalysis);
            }

            if (parsed && typeof parsed === 'object') {
                return {
                    intelligence: typeof parsed.intelligence === 'number' ? Math.min(10, Math.max(1, parsed.intelligence)) : null,
                    accuracy: typeof parsed.accuracy === 'number' ? Math.min(10, Math.max(1, parsed.accuracy)) : null,
                    speed: typeof parsed.speed === 'number' ? Math.min(10, Math.max(1, parsed.speed)) : null,
                };
            }
            return null;
        } catch (e) {
            console.error("Autograding failed", e);
            return null;
        }
    };

    const runAgentOptimization = async (agentToTest: any) => {
        if (!task) {
            alert("Please provide a base task first.");
            return;
        }

        if (agentToTest.provider === 'none') {
            alert("This agent has no provider selected.");
            return;
        }

        setIsRunning(true);

        // Remove old results for this agent
        setResults(prev => prev.filter(r => r.role !== agentToTest.role));

        const allAgents = settings.agents || [];
        const managerAgent = allAgents.find((a: any) => a.id === 'manager' || a.role.toLowerCase().includes('manager'));

        if (!managerAgent) {
            alert("Could not find a manager agent in settings for auto-grading.");
            setIsRunning(false);
            return;
        }

        setProgress(`Generating specific test prompt for ${agentToTest.role}...`);
        const agentTestTask = agentToTest.id === managerAgent.id ? task : await generateTestPrompt(managerAgent, agentToTest.role, task);

        const newResults: OptimizationResult[] = [];

        setProgress(`Fetching models for ${agentToTest.provider}...`);
        let models: ModelOption[] = [];
        let apiKey = '';
        let healthMap: Record<string, any> = {};
        try {
            apiKey = getApiKeyForProvider(settings, agentToTest.provider);
            models = await fetchAvailableModels(agentToTest.provider, apiKey);

            setProgress(`Checking health for ${agentToTest.provider} models...`);
            healthMap = await checkProviderModelsHealth(agentToTest.provider, models, apiKey);
        } catch (e) {
            console.error(`Failed to fetch models or health for ${agentToTest.provider}`, e);
            alert(`Failed to fetch models for ${agentToTest.provider}. Check API keys.`);
            setIsRunning(false);
            return;
        }

        const modelsToTest = models.filter(m => {
            const key = `${agentToTest.provider.toLowerCase().trim()}:${m.id.trim()}`;
            const health = healthMap[key];
            if (health && (health.circuitState === 'OPEN' || !health.healthy)) {
                return false;
            }
            if (agentToTest.provider === 'simulated' || agentToTest.provider === 'github') return true;
            return m.free !== false;
        });

        for (const model of modelsToTest) {
            setProgress(`Testing ${agentToTest.role} with ${model.name || model.id}...`);
            const testSettings = {
                ...settings,
                agents: settings.agents.map((a: any) => 
                    a.id === agentToTest.id ? { ...a, model: model.id } : a
                ),
                forceFullSwarm: false
            };

            const start = Date.now();
            let output = null;
            let errorMsg = undefined;
            try {
                const res = await fetch('/api/swarm/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        task: agentTestTask,
                        data,
                        settings: testSettings
                    })
                });
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                const resData = await res.json();
                if (resData.error) throw new Error(resData.error);
                output = resData.finalAnalysis;
            } catch (e: any) {
                errorMsg = e.message;
                recordError(model.id, agentToTest.provider, errorMsg);
            }
            const duration = Date.now() - start;

            let autoScore = { intelligence: null, accuracy: null, speed: null };
            if (output && !errorMsg) {
                setProgress(`Auto-grading ${model.name || model.id}...`);
                const scoreRes = await autoGradeOutput(agentTestTask, output, duration, managerAgent);
                if (scoreRes) autoScore = scoreRes as any;
            }

            const result: OptimizationResult = {
                id: `${agentToTest.id}-${model.id}`,
                role: agentToTest.role,
                provider: agentToTest.provider,
                model: model.id,
                durationMs: duration,
                output,
                error: errorMsg,
                scores: autoScore,
                isFullSwarm: false
            };

            newResults.push(result);
            setResults(prev => [...prev.filter(r => r.id !== result.id), result]);
            saveToHistory(result);
            await delay(1000);
        }

        setProgress('Agent Optimization Complete!');
        setIsRunning(false);
    };

    const runFullSwarmCombinations = async () => {
        if (!task) {
            alert("Please provide a task first.");
            return;
        }

        const validModels = results.filter(r => !r.isFullSwarm && !r.error && (r.scores.accuracy || 0) >= 5);
        if (validModels.length < 2) {
            alert("Not enough successful individual models to form combinations. Please test agents first.");
            return;
        }

        setIsRunning(true);
        // Clear previous full swarm results
        setResults(prev => prev.filter(r => !r.isFullSwarm));

        const allAgents = settings.agents || [];
        const managerAgent = allAgents.find((a: any) => a.id === 'manager' || a.role.toLowerCase().includes('manager'));
        const analysts = allAgents.filter((a: any) => a.id !== 'manager' && !a.role.toLowerCase().includes('manager') && a.provider !== 'none');

        if (!managerAgent || analysts.length === 0) {
            alert("Need at least 1 manager and 1 analyst.");
            setIsRunning(false);
            return;
        }

        const managerModels = validModels.filter(r => r.role === managerAgent.role);

        // Pick best models for the manager and one of each analyst to form combinations
        // Limit to top 3 combinations to avoid infinite runtime
        const combinations = [];

        for (let i = 0; i < Math.min(3, managerModels.length || 1); i++) {
            const mModel = managerModels[i] ? managerModels[i].model : managerAgent.model;

            const comboAgents = [ { ...managerAgent, model: mModel } ];
            let comboDesc = `Manager: ${mModel}`;

            for (const analyst of analysts) {
                const aModels = validModels.filter(r => r.role === analyst.role).sort((a,b) => (b.scores.intelligence || 0) - (a.scores.intelligence || 0));
                // Try to get a model we haven't used much yet if possible, or just the best
                const aModel = aModels[i % aModels.length] ? aModels[i % aModels.length].model : analyst.model;
                comboAgents.push({ ...analyst, model: aModel });
                comboDesc += ` | ${analyst.role}: ${aModel}`;
            }
            combinations.push({ agents: comboAgents, desc: comboDesc });
        }

        if (combinations.length === 0) {
            alert("Could not generate valid combinations from current test results.");
            setIsRunning(false);
            return;
        }

        const newResults: OptimizationResult[] = [];

        for (const combo of combinations) {
            setProgress(`Testing Swarm Combo: ${combo.desc.substring(0, 50)}...`);

            const testSettings = {
                ...settings,
                agents: combo.agents,
                forceFullSwarm: true
            };

            const start = Date.now();
            let output = null;
            let errorMsg = undefined;
            try {
                const res = await fetch('/api/swarm/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        task,
                        data,
                        settings: testSettings
                    })
                });
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                const resData = await res.json();
                if (resData.error) throw new Error(resData.error);
                output = resData.finalAnalysis;
            } catch (e: any) {
                errorMsg = e.message;
            }
            const duration = Date.now() - start;

            let autoScore = { intelligence: null, accuracy: null, speed: null };
            if (output && !errorMsg) {
                setProgress(`Auto-grading Combo...`);
                const scoreRes = await autoGradeOutput(task, output, duration, managerAgent);
                if (scoreRes) autoScore = scoreRes as any;
            }

            const result: OptimizationResult = {
                id: `full-swarm-${Date.now()}-${Math.random()}`,
                role: 'ALL AGENTS',
                provider: 'Mixed',
                model: combo.desc,
                durationMs: duration,
                output,
                error: errorMsg,
                scores: autoScore,
                isFullSwarm: true
            };

            newResults.push(result);
            setResults(prev => [...prev, result]);
            saveToHistory(result);
            await delay(2000);
        }

        setProgress('Full Swarm Combinations Complete!');
        setIsRunning(false);
    };

    const updateScore = (id: string, axis: 'intelligence' | 'accuracy' | 'speed', newScore: string) => {
        const parsed = parseInt(newScore);
        const validScore = isNaN(parsed) ? null : Math.min(10, Math.max(1, parsed));

        setResults(prev => prev.map(r =>
            r.id === id ? { ...r, scores: { ...r.scores, [axis]: validScore } } : r
        ));
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-medium text-neutral-800 flex items-center gap-2">
                        <Trophy className="w-5 h-5 text-amber-500" />
                        Model Optimizer
                    </h3>
                    <p className="text-sm text-neutral-500 mt-1">
                        Tests available models in each analyst role to find the best balance of speed and intelligence.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {(settings.agents || []).map((agent: any) => {
                    const agentResults = results.filter(r => r.role === agent.role && !r.isFullSwarm);
                    return (
                        <div key={agent.id} className="bg-white border border-neutral-200 rounded-lg p-4 shadow-sm">
                            <div className="flex justify-between items-start mb-3">
                                <div>
                                    <h4 className="font-semibold text-neutral-800">{agent.role}</h4>
                                    <span className="text-xs text-neutral-500 uppercase tracking-wider">{agent.provider}</span>
                                </div>
                                <button
                                    onClick={() => runAgentOptimization(agent)}
                                    disabled={isRunning || agent.provider === 'none'}
                                    className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium py-1.5 px-3 rounded transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                    Test Agent
                                </button>
                            </div>

                            {agentResults.length > 0 ? (
                                <div className="space-y-2 mt-4 max-h-64 overflow-y-auto">
                                    {agentResults.map(r => (
                                        <div key={r.id} className={`p-2 rounded text-xs border ${r.error ? 'bg-red-50 border-red-100' : 'bg-neutral-50 border-neutral-100'}`}>
                                            <div className="flex justify-between font-mono font-medium mb-1">
                                                <span className="truncate max-w-[150px]">{r.model}</span>
                                                <span className={`${r.durationMs < 3000 ? 'text-green-600' : r.durationMs < 8000 ? 'text-amber-600' : 'text-red-600'}`}>
                                                    {(r.durationMs / 1000).toFixed(1)}s
                                                </span>
                                            </div>
                                            {r.error ? (
                                                <div className="text-red-600 truncate">{r.error}</div>
                                            ) : (
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex gap-2 text-[10px]">
                                                        <span title="Intelligence" className="px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">INT: {r.scores.intelligence || '-'}</span>
                                                        <span title="Accuracy" className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded">ACC: {r.scores.accuracy || '-'}</span>
                                                        <span title="Speed" className="px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded">SPD: {r.scores.speed || '-'}</span>
                                                    </div>
                                                    <div className="mt-1 text-[9px] text-neutral-500 max-h-16 overflow-y-auto whitespace-pre-wrap font-mono bg-white p-1 border border-neutral-100 rounded">
                                                        {typeof r.output === 'object' ? JSON.stringify(r.output, null, 2) : String(r.output || 'No output')}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-neutral-400 mt-4 italic">No results yet. Click test to run model sweep.</p>
                            )}
                        </div>
                    );
                })}
            </div>

            {Object.keys(errorRecords).length > 0 && (
                <div className="bg-white rounded-xl border border-red-200 shadow-sm overflow-hidden mb-6">
                    <div className="bg-red-50 px-4 py-3 border-b border-red-200 flex justify-between items-center">
                        <h4 className="text-sm font-medium text-red-800 flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" />
                            Model Error Log (Local History)
                        </h4>
                        <button onClick={clearErrorRecords} className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1">
                            <Trash2 className="w-3 h-3" /> Clear Log
                        </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        <table className="w-full text-left text-xs whitespace-nowrap">
                            <thead className="bg-white sticky top-0 border-b border-red-100 text-red-500 uppercase">
                                <tr>
                                    <th className="px-4 py-2 font-semibold">Model</th>
                                    <th className="px-4 py-2 font-semibold">Provider</th>
                                    <th className="px-4 py-2 font-semibold">Error Count</th>
                                    <th className="px-4 py-2 font-semibold w-full">Last Error Message</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-red-50">
                                {Object.entries(errorRecords).sort((a,b) => (b[1] as ModelErrorRecord).errorCount - (a[1] as ModelErrorRecord).errorCount).map(([modelId, record]) => (
                                    <tr key={modelId} className="hover:bg-red-50/50">
                                        <td className="px-4 py-2 font-mono text-red-700">{modelId}</td>
                                        <td className="px-4 py-2 uppercase tracking-wide text-red-400">{(record as ModelErrorRecord).provider}</td>
                                        <td className="px-4 py-2 font-semibold text-red-600">{(record as ModelErrorRecord).errorCount}</td>
                                        <td className="px-4 py-2 truncate max-w-md text-red-500 font-mono" title={(record as ModelErrorRecord).lastError}>{(record as ModelErrorRecord).lastError}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {isRunning && (
                <div className="bg-indigo-50 border border-indigo-100 p-3 rounded-lg flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                    <span className="text-sm font-medium text-indigo-800">{progress}</span>
                </div>
            )}

            <div className="mt-8 pt-8 border-t border-neutral-200">
                <div className="flex justify-between items-center mb-6">
                    <div>
                        <h4 className="text-lg font-semibold text-neutral-800 flex items-center gap-2">
                            <Trophy className="w-5 h-5 text-indigo-600" />
                            Full Swarm Combinations
                        </h4>
                        <p className="text-sm text-neutral-500 mt-1">Tests combinations of the highest scoring error-free models.</p>
                    </div>

                    <button
                        onClick={runFullSwarmCombinations}
                        disabled={isRunning}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        Test Combinations
                    </button>
                </div>

            {results.filter(r => r.isFullSwarm).length > 0 && (
                <div className="mt-4">
                    <div className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="uppercase tracking-wider border-b-2 border-neutral-200 bg-neutral-50 text-neutral-500 text-[10px] font-semibold">
                                    <tr>
                                        <th className="px-4 py-3">Combination</th>
                                        <th className="px-4 py-3">Speed</th>
                                        <th className="px-4 py-3">Intelligence</th>
                                        <th className="px-4 py-3">Accuracy</th>
                                        <th className="px-4 py-3">Output Snippet</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-neutral-200 text-neutral-800">
                                    {results.filter(r => r.isFullSwarm).map(r => (
                                        <tr key={r.id} className="hover:bg-neutral-50">
                                            <td className="px-4 py-3 font-mono text-xs max-w-[200px] truncate" title={r.model}>
                                                {r.model}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${r.durationMs < 3000 ? 'bg-green-100 text-green-700' : r.durationMs < 8000 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                                    <Clock className="w-3 h-3" />
                                                    {(r.durationMs / 1000).toFixed(1)}s
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 font-semibold text-blue-700">{r.scores.intelligence || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-emerald-700">{r.scores.accuracy || '-'}</td>
                                            <td className="px-4 py-3 max-w-xs truncate text-xs text-neutral-600 font-mono">
                                                {r.error ? (
                                                    <span className="text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {r.error}</span>
                                                ) : typeof r.output === 'object' ? (
                                                    JSON.stringify(r.output)
                                                ) : (
                                                    String(r.output || 'No output')
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
            </div>
            
            {history.length > 0 && (
                <div className="mt-8 pt-8 border-t border-neutral-200">
                    <div className="flex justify-between items-center mb-6">
                        <div>
                            <h4 className="text-lg font-semibold text-neutral-800 flex items-center gap-2">
                                <Trophy className="w-5 h-5 text-yellow-500" />
                                Local Historical Leaderboard
                            </h4>
                            <p className="text-sm text-neutral-500 mt-1">The highest scoring models from all your past benchmarking sessions.</p>
                        </div>
                        <button onClick={() => { localStorage.removeItem('swarm_optimization_history'); setHistory([]); }} className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1">
                            <Trash2 className="w-3 h-3" /> Clear History
                        </button>
                    </div>

                    <div className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                        <div className="overflow-x-auto max-h-96 overflow-y-auto">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="uppercase tracking-wider border-b-2 border-neutral-200 bg-neutral-50 text-neutral-500 text-[10px] font-semibold sticky top-0">
                                    <tr>
                                        <th className="px-4 py-3">Role</th>
                                        <th className="px-4 py-3">Model</th>
                                        <th className="px-4 py-3">Speed</th>
                                        <th className="px-4 py-3">Intelligence</th>
                                        <th className="px-4 py-3">Accuracy</th>
                                        <th className="px-4 py-3">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-neutral-200 text-neutral-800">
                                    {history.map(r => (
                                        <tr key={`hist-${r.id}-${r.durationMs}`} className="hover:bg-neutral-50">
                                            <td className="px-4 py-3 font-semibold text-xs text-neutral-600">{r.role}</td>
                                            <td className="px-4 py-3 font-mono text-xs max-w-[200px] truncate" title={r.model}>
                                                {r.model}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${r.durationMs < 3000 ? 'bg-green-100 text-green-700' : r.durationMs < 8000 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                                    <Clock className="w-3 h-3" />
                                                    {(r.durationMs / 1000).toFixed(1)}s
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 font-semibold text-blue-700">{r.scores.intelligence || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-emerald-700">{r.scores.accuracy || '-'}</td>
                                            <td className="px-4 py-3 text-xs">
                                                {r.error ? <span className="text-red-500">Error</span> : <span className="text-green-600 font-medium">Valid</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
