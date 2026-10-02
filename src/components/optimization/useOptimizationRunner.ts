import { useState, useEffect } from 'react';
import type { OptimizationResult, OptimizationRunnerProps } from './types';
import type { ModelErrorRecord } from './OptimizationErrorLog';
import {
    fetchAvailableModels,
    checkProviderModelsHealth,
    ModelOption,
    globalModelHealthChecker,
    getQuarantinedModels,
    isModelQuarantined,
    recordModel404,
    clearModel404Strikes
} from '../../services/providerService';
import { getApiKeyForProvider } from '../AgentConfigurator';
import {
    getProviderBackoff,
    recordProvider429,
    recordProviderSuccess,
    ensureTier2Health,
    fetchAnalyze
} from './optimizationCaches';
import {
    scoreOf,
    calculateConsensusScore,
    calculateSpeedScore,
    isModelResponseValid
} from './optimizationScoring';
import {
    generateTestPrompt,
    autoGradeOutput
} from './optimizationGrading';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function useOptimizationRunner({ task, data, settings, onApplyModelToSettings }: OptimizationRunnerProps) {
    const [results, setResults] = useState<OptimizationResult[]>([]);
    const [history, setHistory] = useState<OptimizationResult[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [progress, setProgress] = useState('');
    const [errorRecords, setErrorRecords] = useState<Record<string, ModelErrorRecord>>({});
    const [promptGenStatus, setPromptGenStatus] = useState<{ ok: boolean; error?: string; at?: string } | null>(null);
    const [consensusMode, setConsensusMode] = useState<boolean>(true);
    const [quarantinedCount, setQuarantinedCount] = useState<number>(() => getQuarantinedModels().length);

    useEffect(() => {
        try {
            setQuarantinedCount(getQuarantinedModels().length);
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
        const entry: OptimizationResult = {
            ...res,
            testedAt: res.testedAt || new Date().toISOString()
        };
        setHistory(prev => {
            const updated = [...prev.filter(r => r.id !== entry.id), entry].sort((a, b) => 
               scoreOf(b) - scoreOf(a)
            );
            const top100 = updated.slice(0, 100).map(r => {
                if (r.output) {
                    const raw = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
                    if (raw.length > 2000) {
                        return { ...r, output: raw.slice(0, 2000) + '... [truncated]' };
                    }
                }
                return r;
            });
            try {
                try {
                    const stringified = JSON.stringify(top100);
                    localStorage.setItem('swarm_optimization_history', stringified);
                } catch (e: any) {
                    if (e.name === 'QuotaExceededError') alert('LocalStorage Quota Exceeded');
                }
            } catch (e) {}

            return top100;
        });
    };

    const applyBestToSettings = (result: OptimizationResult) => {
        if (result.isFullSwarm) {
            try {
                const saved = localStorage.getItem('swarm_settings');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed.agents)) {
                        const updates: Record<string, string> = {};
                        const parts = result.model.split('|').map(s => s.trim());
                        parts.forEach(p => {
                            const [roleStr, modelStr] = p.split(':').map(s => s.trim());
                            if (roleStr && modelStr) {
                                updates[roleStr] = modelStr;
                            }
                        });

                        parsed.agents = parsed.agents.map((a: any) => {
                            let matchRole = a.role;
                            if (a.role.toLowerCase().includes('manager')) matchRole = 'Manager Node';
                            const matchingKey = Object.keys(updates).find(k => k === a.role || k === matchRole || a.role.includes(k) || k.includes(a.role));
                            if (matchingKey && updates[matchingKey]) {
                                const m = updates[matchingKey];
                                let prov = a.provider;
                                if (m.startsWith('gemini')) prov = 'gemini';
                                else if (m.startsWith('mistral') || m.startsWith('open-mistral')) prov = 'mistral';
                                else if (m.includes('llama') || m.includes('mixtral')) prov = 'groq';
                                return { ...a, provider: prov, model: m, temperature: a.role.toLowerCase().includes('manager') ? 0.3 : (a.role.toLowerCase().includes('grader') ? 0.15 : 0.7) };
                            }
                            return a;
                        });
                        localStorage.setItem('swarm_settings', JSON.stringify(parsed));
                        window.dispatchEvent(new Event('storage'));
                    }
                }
            } catch (e) {
                console.error("Failed to apply combo settings", e);
            }
        } else if (onApplyModelToSettings) {
            onApplyModelToSettings(result.role, result.provider, result.model);
        } else {
            try {
                const saved = localStorage.getItem('swarm_settings');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed.agents)) {
                        parsed.agents = parsed.agents.map((a: any) =>
                            a.role === result.role ? { ...a, provider: result.provider, model: result.model } : a
                        );
                        localStorage.setItem('swarm_settings', JSON.stringify(parsed));
                    }
                }
            } catch (e) {
                console.error("Failed to update settings in localStorage", e);
            }
        }

        const toast = document.createElement('div');
        toast.className = 'fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded shadow-lg z-50 transition-opacity duration-300';
        toast.innerText = `Active config updated: ${result.isFullSwarm ? 'Swarm Combination' : result.model}`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 2000);
    };

    const recordError = (modelId: string, provider: string, errorMsg: string) => {
        const safeError = String(errorMsg || '').slice(0, 500);
        setErrorRecords(prev => {
            const current = prev[modelId] || { errorCount: 0, lastError: '', provider };
            const updated = {
                ...prev,
                [modelId]: {
                    errorCount: current.errorCount + 1,
                    lastError: safeError,
                    provider
                }
            };

            try {
                const stringified = JSON.stringify(updated);
                localStorage.setItem('swarm_model_errors', stringified);
            } catch (e: any) {
                console.error("Failed to save error records", e);
            }
            return updated;
        });
    };

    const clearErrorRecords = () => {
        setErrorRecords({});
        localStorage.removeItem('swarm_model_errors');
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
        let hasClearedOldRoleResults = false;

        const allAgents = settings.agents || [];
        const managerAgent = allAgents.find((a: any) => a.id === 'manager' || a.role.toLowerCase().includes('manager'));

        if (!managerAgent) {
            alert("Could not find a manager agent in settings for auto-grading.");
            setIsRunning(false);
            return;
        }

        setProgress(`Generating specific test prompt for ${agentToTest.role}...`);
        const agentTestTask = agentToTest.id === managerAgent.id 
            ? task 
            : await generateTestPrompt(managerAgent, agentToTest.role, task, settings, setPromptGenStatus, recordError);

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
            if (isModelQuarantined(agentToTest.provider, m.id)) {
                return false;
            }
            const key = `${agentToTest.provider.toLowerCase().trim()}:${m.id.trim()}`;
            const health = healthMap[key];
            if (health && (health.circuitState === 'OPEN' || !health.healthy)) {
                return false;
            }
            if (agentToTest.provider === 'simulated' || agentToTest.provider === 'github') return true;
            return m.free !== false;
        });

        if (modelsToTest.length === 0) {
            alert(`No healthy or configured models available for ${agentToTest.provider}. Please verify API key in Settings.`);
            setIsRunning(false);
            return;
        }

        const isAnalyst = agentToTest.id !== managerAgent.id && !agentToTest.role.toLowerCase().includes('manager');
        const sampleCount = (consensusMode && isAnalyst) ? 3 : 1;

        const testSingleModel = async (model: ModelOption): Promise<OptimizationResult> => {
            const filteredAgents = settings.agents
                .filter((a: any) => a.id === agentToTest.id || a.id === managerAgent.id)
                .map((a: any) => {
                    const isMgr = a.id === managerAgent.id || a.role === 'Manager Node';
                    const defaultCap = isMgr ? 2000 : 1500;
                    return a.id === agentToTest.id 
                        ? { ...a, provider: agentToTest.provider, model: model.id, maxTokens: a.maxTokens || defaultCap } 
                        : { ...a, maxTokens: a.maxTokens || defaultCap };
                });
            
            const hasSubAgents = filteredAgents.some((a: any) => a.id !== managerAgent.id && a.role !== 'Manager Node');
            if (!hasSubAgents) {
                filteredAgents.push({
                    id: 'mock-analyst-test',
                    role: 'Mock Analyst',
                    provider: 'simulated',
                    model: 'simulated-model',
                    maxTokens: 1500
                });
            }
            const isHealthy = await ensureTier2Health(agentToTest.provider, model.id, settings);
            if (!isHealthy) {
                recordError(model.id, agentToTest.provider, "Tier-2 health check failed lazily before test.");
                const failRes: OptimizationResult = {
                    id: `${agentToTest.id}-${model.id}`,
                    role: agentToTest.role,
                    provider: agentToTest.provider,
                    model: model.id,
                    durationMs: 0,
                    output: null,
                    error: "Tier-2 health check failed lazily before test.",
                    scores: { intelligence: null, accuracy: null, speed: 1 },
                    isFullSwarm: false
                };
                saveToHistory(failRes);
                return failRes;
            }

            const cleanSettings = { ...settings };
            delete cleanSettings.activeVariant;

            const testSettings = {
                ...cleanSettings,
                agents: filteredAgents,
                forceFullSwarm: false,
                disableFallback: true
            };

            const sampleOutputs: any[] = [];
            const sampleScores: { intelligence: number | null; accuracy: number | null; speed: number | null }[] = [];
            let sampleDurationsTotal = 0;
            let lastErrorMsg: string | undefined = undefined;
            let lastGradingError: string | undefined = undefined;
            let anyFromCache = false;

            for (let sIdx = 0; sIdx < sampleCount; sIdx++) {
                const sampleLabel = sampleCount > 1 ? ` (sample ${sIdx + 1}/${sampleCount})` : '';
                setProgress(`Testing ${agentToTest.role} with ${model.name || model.id}${sampleLabel}...`);

                const start = Date.now();
                let output = null;
                let errorMsg = undefined;
                try {
                    const requestBody = {
                        task: agentTestTask,
                        data,
                        bypassCache: true,
                        settings: testSettings
                    };
                    const res = await fetchAnalyze(requestBody, requestBody.settings?.forceFullSwarm ? 180000 : 120000);
                    const resData = await res.json().catch(() => null);
                    if (!res.ok) {
                        if (res.status === 404) {
                            recordModel404(agentToTest.provider, model.id);
                            setQuarantinedCount(getQuarantinedModels().length);
                        }
                        if (res.status === 429) {
                            recordProvider429(agentToTest.provider, res.headers.get('retry-after'));
                            globalModelHealthChecker.circuitBreaker.recordFailure(agentToTest.provider, model.id, '429 Rate Limit');
                        } else {
                            globalModelHealthChecker.circuitBreaker.recordFailure(agentToTest.provider, model.id, `HTTP ${res.status}`);
                        }
                        throw new Error(resData?.error ? String(resData.error) : `HTTP error ${res.status}`);
                    }
                    if (resData.error) {
                        const errStr = String(resData.error);
                        if (errStr.includes('404') || errStr.toLowerCase().includes('not found')) {
                            recordModel404(agentToTest.provider, model.id);
                            setQuarantinedCount(getQuarantinedModels().length);
                        }
                        globalModelHealthChecker.circuitBreaker.recordFailure(agentToTest.provider, model.id, errStr);
                        throw new Error(resData.error);
                    }

                    output = resData.finalAnalysis;
                    if (!output) {
                        throw new Error("No output returned from model.");
                    }

                    if (typeof output === 'object') {
                        if (output.error) throw new Error(String(output.error));
                        if (typeof output.ui_title === 'string' && (output.ui_title.toLowerCase().includes('error') || output.ui_title.toLowerCase().includes('execution error'))) {
                            const errMsg = output.components?.[0]?.props?.insights?.[0]?.message || output.error || output.ui_title || 'Execution Error in model output';
                            throw new Error(errMsg);
                        }
                    }

                    if (typeof output === 'string' && output.trim().length < 5) {
                        throw new Error("Output too short to be valid.");
                    }

                    recordProviderSuccess(agentToTest.provider);
                    clearModel404Strikes(agentToTest.provider, model.id);
                    globalModelHealthChecker.circuitBreaker.recordSuccess(agentToTest.provider, model.id);
                } catch (e: any) {
                    globalModelHealthChecker.circuitBreaker.recordFailure(agentToTest.provider, model.id, e.message);
                    errorMsg = e.message;
                    lastErrorMsg = errorMsg;
                    recordError(model.id, agentToTest.provider, errorMsg);
                    if (e.message?.includes('404') || e.message?.toLowerCase().includes('not found')) {
                        recordModel404(agentToTest.provider, model.id);
                        setQuarantinedCount(getQuarantinedModels().length);
                    }
                }
                const sampleDuration = Date.now() - start;
                sampleDurationsTotal += sampleDuration;

                if (isModelResponseValid({ output, error: errorMsg })) {
                    sampleOutputs.push(output);
                    setProgress(`Auto-grading ${model.name || model.id}${sampleLabel}...`);
                    try {
                        const scoreRes = await autoGradeOutput(agentTestTask, output, sampleDuration, managerAgent, settings, recordError);
                        if (scoreRes) {
                            sampleScores.push({
                                intelligence: scoreRes.intelligence,
                                accuracy: scoreRes.accuracy,
                                speed: scoreRes.speed !== null ? scoreRes.speed : calculateSpeedScore(sampleDuration)
                            });
                            if (scoreRes.fromCache) anyFromCache = true;
                        }
                    } catch (e: any) {
                        lastGradingError = `Grading failed: ${e.message}`;
                    }
                }

                if (sIdx < sampleCount - 1) {
                    await delay(1000);
                }
            }

            const effectiveDuration = Math.round(sampleDurationsTotal / Math.max(1, sampleCount));
            let autoScore = { 
                intelligence: null as number | null, 
                accuracy: null as number | null, 
                speed: calculateSpeedScore(effectiveDuration) as number | null 
            };

            if (sampleScores.length > 0) {
                autoScore = {
                    intelligence: calculateConsensusScore(sampleScores.map(s => s.intelligence)),
                    accuracy: calculateConsensusScore(sampleScores.map(s => s.accuracy)),
                    speed: calculateConsensusScore(sampleScores.map(s => s.speed)) ?? calculateSpeedScore(effectiveDuration)
                };
            }

            const chosenOutput = sampleOutputs.length > 0 ? sampleOutputs[sampleOutputs.length - 1] : null;

            const result: OptimizationResult = {
                id: `${agentToTest.id}-${model.id}`,
                role: agentToTest.role,
                provider: agentToTest.provider,
                model: model.id,
                durationMs: effectiveDuration,
                output: chosenOutput,
                error: sampleOutputs.length > 0 ? undefined : lastErrorMsg,
                gradingError: lastGradingError,
                scores: autoScore,
                fromCache: anyFromCache,
                isFullSwarm: false,
                consensusSamples: sampleCount > 1 ? sampleScores.length : undefined
            };

            saveToHistory(result);
            return result;
        };

        const BATCH_SIZE = 3;
        for (let i = 0; i < modelsToTest.length; i += BATCH_SIZE) {
            const batch = modelsToTest.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(m => testSingleModel(m)));
            for (const result of batchResults) {
                setResults(prev => {
                    const base = hasClearedOldRoleResults 
                        ? prev 
                        : prev.filter(r => r.role !== agentToTest.role);
                    hasClearedOldRoleResults = true;
                    return [...base.filter(r => r.id !== result.id), result];
                });
            }

            if (i + BATCH_SIZE < modelsToTest.length) {
                const backoff = getProviderBackoff(agentToTest.provider);
                if (backoff && backoff.backoffUntil > Date.now()) {
                    const waitTime = Math.max(4000, backoff.backoffUntil - Date.now());
                    await delay(waitTime);
                } else {
                    await delay(2000);
                }
            }
        }

        setProgress('Agent Optimization Complete!');
        setIsRunning(false);
    };

    const runFullSwarmCombinations = async () => {
        if (!task) {
            alert("Please provide a task first.");
            return;
        }

        const validModels = results.filter(r => !r.isFullSwarm && isModelResponseValid(r) && (r.scores.accuracy === null || r.scores.accuracy >= 5));
        if (validModels.length < 2) {
            alert("Not enough successful individual models to form combinations. Please test agents first.");
            return;
        }

        setIsRunning(true);
        setResults(prev => prev.filter(r => !r.isFullSwarm));

        const allAgents = settings.agents || [];
        const managerAgent = allAgents.find((a: any) => a.id === 'manager' || a.role.toLowerCase().includes('manager'));
        const analysts = allAgents.filter((a: any) => a.id !== 'manager' && !a.role.toLowerCase().includes('manager') && a.provider !== 'none');

        if (!managerAgent || analysts.length === 0) {
            alert("Need at least 1 manager and 1 analyst.");
            setIsRunning(false);
            return;
        }

        const managerModels = validModels
            .filter(r => r.role === managerAgent.role)
            .sort((a, b) => scoreOf(b) - scoreOf(a));

        const combinations = [];
        for (let i = 0; i < Math.min(3, managerModels.length || 1); i++) {
            const mModel = managerModels[i] ? managerModels[i].model : managerAgent.model;
            const comboAgents = [ { ...managerAgent, model: mModel } ];
            let comboDesc = `Manager: ${mModel}`;

            for (const analyst of analysts) {
                const aModels = validModels.filter(r => r.role === analyst.role).sort((a,b) => (b.scores.intelligence || 0) - (a.scores.intelligence || 0));
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

        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        for (const combo of combinations) {
            const priorCombo = history.find(h =>
                h.isFullSwarm &&
                h.model === combo.desc &&
                h.testedAt &&
                (Date.now() - new Date(h.testedAt).getTime() < SEVEN_DAYS_MS) &&
                isModelResponseValid(h) &&
                h.scores.accuracy !== null
            );

            if (priorCombo) {
                setProgress(`Reusing prior combo benchmark (${new Date(priorCombo.testedAt!).toLocaleDateString()}): ${combo.desc.substring(0, 45)}...`);
                const reused: OptimizationResult = {
                    ...priorCombo,
                    id: `full-swarm-${Date.now()}-${crypto.randomUUID()}`,
                    fromCache: true
                };
                setResults(prev => [...prev, reused]);
                await delay(600);
                continue;
            }

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
                const requestBody = {
                    task,
                    data,
                    bypassCache: true,
                    settings: testSettings
                };
                const res = await fetchAnalyze(requestBody, requestBody.settings?.forceFullSwarm ? 180000 : 120000);
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                const resData = await res.json();
                if (resData.error) throw new Error(resData.error);
                output = resData.finalAnalysis;
                if (!output) {
                    throw new Error("No output returned from combination.");
                }

                if (output && typeof output === "object") {
                    if (output.error) throw new Error(String(output.error));
                    if (typeof output.ui_title === "string" && (output.ui_title.toLowerCase().includes("error") || output.ui_title.toLowerCase().includes("execution error"))) {
                        const errMsg = output.components?.[0]?.props?.insights?.[0]?.message || output.error || output.ui_title || "Execution Error in swarm output";
                        throw new Error(errMsg);
                    }
                }

                if (typeof output === "string" && output.trim().length < 5) {
                     throw new Error("Output too short to be valid.");
                }
            } catch (e: any) {
                errorMsg = e.message;
            }
            const duration = Date.now() - start;

            let autoScore = { intelligence: null, accuracy: null, speed: calculateSpeedScore(duration) };
            let comboGradingError: string | undefined = undefined;
            let comboFromCache: boolean | undefined = undefined;
            if (isModelResponseValid({ output, error: errorMsg })) {
                setProgress(`Auto-grading Combo...`);
                try {
                    const scoreRes = await autoGradeOutput(task, output, duration, managerAgent, settings, recordError);
                    if (scoreRes) {
                        autoScore = {
                            ...scoreRes,
                            speed: scoreRes.speed !== null ? scoreRes.speed : calculateSpeedScore(duration)
                        };
                        comboFromCache = scoreRes.fromCache;
                    }
                } catch (e: any) {
                    comboGradingError = `Combo grading failed: ${e.message}`;
                }
            }

            const result: OptimizationResult = {
                id: `full-swarm-${Date.now()}-${crypto.randomUUID()}`,
                role: 'ALL AGENTS',
                provider: 'Mixed',
                model: combo.desc,
                durationMs: duration,
                output,
                error: errorMsg,
                gradingError: comboGradingError,
                scores: autoScore,
                fromCache: comboFromCache,
                isFullSwarm: true
            };

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

    const winningCombo = [...results, ...history]
        .filter(r => r.isFullSwarm && isModelResponseValid(r))
        .sort((a, b) => scoreOf(b) - scoreOf(a))[0];

    return {
        results,
        history,
        setHistory,
        isRunning,
        progress,
        errorRecords,
        promptGenStatus,
        consensusMode,
        setConsensusMode,
        quarantinedCount,
        setQuarantinedCount,
        winningCombo,
        runAgentOptimization,
        runFullSwarmCombinations,
        applyBestToSettings,
        clearErrorRecords,
        updateScore
    };
}
