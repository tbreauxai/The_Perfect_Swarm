import React, { useState } from 'react';
import { fetchAvailableModels, ModelOption } from '../../services/providerService';
import { getApiKeyForProvider } from '../AgentConfigurator';
import { Loader2, Play, Trophy, Clock, CheckCircle, AlertCircle } from 'lucide-react';

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
    score: number | null;
    error?: string;
    isFullSwarm?: boolean;
}

export const OptimizationRunner: React.FC<OptimizationRunnerProps> = ({ task, data, settings }) => {
    const [results, setResults] = useState<OptimizationResult[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [progress, setProgress] = useState('');

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const autoGradeOutput = async (originalTask: string, output: any, managerAgent: any) => {
        try {
            const gradingTask = `You are grading the output of a subordinate AI analyst.
Original Task: "${originalTask}"
Analyst Output:
${typeof output === 'object' ? JSON.stringify(output) : output}

Score the Analyst's output from 1 to 10 based on how intelligently and accurately it answers the original task.
Respond ONLY with a single integer from 1 to 10.`;

            const res = await fetch('/api/swarm/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task: gradingTask,
                    data: '',
                    settings: {
                        ...settings,
                        agents: [managerAgent],
                        forceFullSwarm: false
                    }
                })
            });

            if (!res.ok) return null;
            const data = await res.json();
            const final = data.finalAnalysis;

            // Try to extract a number from 1-10
            let scoreStr = '';
            if (typeof final === 'object') {
                scoreStr = JSON.stringify(final);
            } else {
                scoreStr = String(final);
            }

            const match = scoreStr.match(/\b([1-9]|10)\b/);
            if (match) {
                return parseInt(match[1], 10);
            }
            return null;
        } catch (e) {
            console.error("Autograding failed", e);
            return null;
        }
    };

    const runOptimization = async () => {
        if (!task) {
            alert("Please provide a task first.");
            return;
        }

        setIsRunning(true);
        setResults([]);

        const allAgents = settings.agents || [];
        const managerAgent = allAgents.find((a: any) => a.id === 'manager' || a.role.toLowerCase().includes('manager'));
        const analysts = allAgents.filter((a: any) => a.id !== 'manager' && !a.role.toLowerCase().includes('manager') && a.provider !== 'none');

        if (!managerAgent) {
            alert("Could not find a manager agent in settings.");
            setIsRunning(false);
            return;
        }

        const newResults: OptimizationResult[] = [];

        for (const analyst of analysts) {
            setProgress(`Fetching models for ${analyst.provider}...`);
            let models: ModelOption[] = [];
            try {
                const apiKey = getApiKeyForProvider(settings, analyst.provider);
                models = await fetchAvailableModels(analyst.provider, apiKey);
            } catch (e) {
                console.error(`Failed to fetch models for ${analyst.provider}`, e);
                continue;
            }

            const modelsToTest = models.filter(m => {
                // If it's github/simulated, they don't have 'free' property guaranteed, just test first 5
                if (analyst.provider === 'simulated' || analyst.provider === 'github') return true;
                return m.free !== false; // Test free models or ones where free isn't strictly false
            }).slice(0, 5); // Limit to top 5 per provider to save time

            for (const model of modelsToTest) {
                setProgress(`Testing ${analyst.role} with ${model.name || model.id}...`);
                const testSettings = {
                    ...settings,
                    agents: [
                        managerAgent,
                        { ...analyst, model: model.id }
                    ],
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

                let autoScore = null;
                if (output && !errorMsg) {
                    setProgress(`Auto-grading ${model.name || model.id}...`);
                    autoScore = await autoGradeOutput(task, output, managerAgent);
                }

                newResults.push({
                    id: `${analyst.id}-${model.id}`,
                    role: analyst.role,
                    provider: analyst.provider,
                    model: model.id,
                    durationMs: duration,
                    output,
                    error: errorMsg,
                    score: autoScore,
                    isFullSwarm: false
                });

                setResults([...newResults]);
                await delay(1000); // Prevent rate limiting
            }
        }

        setProgress(`Testing Full Swarm Execution...`);
        const startFull = Date.now();
        let fullOutput = null;
        let fullError = undefined;
        try {
            const res = await fetch('/api/swarm/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task,
                    data,
                    settings
                })
            });
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            const resData = await res.json();
            if (resData.error) throw new Error(resData.error);
            fullOutput = resData.finalAnalysis;
        } catch (e: any) {
            fullError = e.message;
        }
        const fullDuration = Date.now() - startFull;

        let fullScore = null;
        if (fullOutput && !fullError) {
             setProgress(`Auto-grading Full Swarm...`);
             fullScore = await autoGradeOutput(task, fullOutput, managerAgent);
        }

        newResults.push({
            id: `full-swarm`,
            role: 'ALL AGENTS',
            provider: 'Mixed',
            model: 'Full Swarm',
            durationMs: fullDuration,
            output: fullOutput,
            error: fullError,
            score: fullScore,
            isFullSwarm: true
        });

        setResults([...newResults]);
        setProgress('Optimization Complete!');
        setIsRunning(false);
    };

    const updateScore = (id: string, newScore: string) => {
        const parsed = parseInt(newScore);
        const validScore = isNaN(parsed) ? null : Math.min(10, Math.max(1, parsed));

        setResults(prev => prev.map(r =>
            r.id === id ? { ...r, score: validScore } : r
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
                <button
                    onClick={runOptimization}
                    disabled={isRunning}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    {isRunning ? 'Running...' : 'Start Optimization'}
                </button>
            </div>

            {isRunning && (
                <div className="bg-indigo-50 border border-indigo-100 p-3 rounded-lg flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                    <span className="text-sm font-medium text-indigo-800">{progress}</span>
                </div>
            )}

            {results.length > 0 && (
                <div className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="uppercase tracking-wider border-b-2 border-neutral-200 bg-neutral-50 text-neutral-500 text-[10px] font-semibold">
                                <tr>
                                    <th className="px-4 py-3">Role</th>
                                    <th className="px-4 py-3">Provider</th>
                                    <th className="px-4 py-3">Model</th>
                                    <th className="px-4 py-3">Speed</th>
                                    <th className="px-4 py-3">Auto Score (1-10)</th>
                                    <th className="px-4 py-3">Output Snippet</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-200 text-neutral-800">
                                {results.map(r => (
                                    <tr key={r.id} className={r.isFullSwarm ? "bg-indigo-50/50" : "hover:bg-neutral-50"}>
                                        <td className="px-4 py-3 font-medium">
                                            {r.role}
                                            {r.isFullSwarm && <Trophy className="w-3 h-3 text-indigo-600 inline ml-1" />}
                                        </td>
                                        <td className="px-4 py-3 uppercase text-[10px] tracking-wide text-neutral-500">{r.provider}</td>
                                        <td className="px-4 py-3 font-mono text-xs">{r.model}</td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${r.durationMs < 3000 ? 'bg-green-100 text-green-700' : r.durationMs < 8000 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                                <Clock className="w-3 h-3" />
                                                {(r.durationMs / 1000).toFixed(1)}s
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            {r.error ? (
                                                 <span className="text-red-500 text-xs font-medium">ERROR</span>
                                            ) : (
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="10"
                                                    value={r.score || ''}
                                                    onChange={(e) => updateScore(r.id, e.target.value)}
                                                    className={`w-16 px-2 py-1 border rounded text-sm text-center ${!r.score ? 'border-neutral-200' : r.score >= 8 ? 'bg-green-50 border-green-200 text-green-800 font-bold' : r.score >= 5 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-red-50 border-red-200 text-red-800'}`}
                                                    placeholder="-"
                                                />
                                            )}
                                        </td>
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
            )}
        </div>
    );
};
