import React, { useState, useEffect } from 'react';
import { fetchAvailableModels, checkProviderModelsHealth, ModelOption } from '../../services/providerService';
import { getApiKeyForProvider } from '../AgentConfigurator';
import { Loader2, Play, Trophy, Clock, CheckCircle, AlertCircle, Trash2 } from 'lucide-react';

let nextFailoverIndex = 0;

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

/**
 * Calculates a deterministic speed score from execution duration.
 * <= 2000ms is 10, >= 10000ms is 1, scaling linearly in between.
 */
export const calculateSpeedScore = (durationMs: number): number => {
    if (durationMs <= 2000) return 10;
    if (durationMs >= 10000) return 1;
    return Math.max(1, Math.min(10, Math.round(10 - ((durationMs - 2000) / 8000) * 9)));
};

/**
 * Evaluates whether a benchmarked model response represents a full, substantive,
 * uncorrupted analysis rather than merely the absence of a network error.
 */
export function isModelResponseValid(result?: { output?: any; error?: string } | null): boolean {
    if (!result) return false;
    if (result.error && typeof result.error === 'string' && result.error.trim().length > 0) {
        return false;
    }
    if (result.output === null || result.output === undefined) return false;

    // String output
    if (typeof result.output === 'string') {
        const trimmed = result.output.trim();
        if (trimmed.length < 20) return false;
        const lower = trimmed.toLowerCase();
        if (
            lower.startsWith('error:') ||
            lower.includes('schema_validation_failed') ||
            lower.includes('execution error') ||
            lower.includes('api key not configured')
        ) {
            return false;
        }
        return true;
    }

    // Object output
    if (typeof result.output === 'object') {
        if (result.output.error) return false;
        const titleLower = typeof result.output.ui_title === 'string' ? result.output.ui_title.toLowerCase() : '';
        if (titleLower.includes('execution error') || titleLower === 'error') {
            return false;
        }

        // Generative UI format (ManagerResponse) with components
        if (Array.isArray(result.output.components) && result.output.components.length > 0) {
            return result.output.components.some((c: any) => {
                if (!c || typeof c !== 'object') return false;
                if (c.type === 'InsightList' && Array.isArray(c.props?.insights) && c.props.insights.length > 0) {
                    return c.props.insights.some((ins: any) => {
                        const msg = typeof ins === 'string' ? ins : ins?.message;
                        if (typeof msg !== 'string') return false;
                        const msgTrimmed = msg.trim();
                        return msgTrimmed.length > 10 && !msgTrimmed.toLowerCase().startsWith('error:');
                    });
                }
                if (c.type === 'MetricCard' && c.props?.title && c.props?.value) return true;
                if (c.type === 'DataTable' && Array.isArray(c.props?.rows) && c.props.rows.length > 0) return true;
                return false;
            });
        }

        // AnalystResponse format with insights / summary
        if (Array.isArray(result.output.insights) && result.output.insights.length > 0) {
            return result.output.insights.some((i: any) => typeof i === 'string' && i.trim().length > 10);
        }
        if (typeof result.output.summary === 'string' && result.output.summary.trim().length > 20) {
            return true;
        }

        // Generic object with message/content
        if (typeof result.output.message === 'string' && result.output.message.trim().length > 20) {
            return true;
        }
    }

    return false;
}

export type ModelExecutionStatus = 'valid' | 'incomplete' | 'error';

export function getModelExecutionStatus(result?: { output?: any; error?: string } | null): ModelExecutionStatus {
    if (!result || (result.error && typeof result.error === 'string' && result.error.trim().length > 0)) {
        return 'error';
    }
    if (isModelResponseValid(result)) {
        return 'valid';
    }
    return 'incomplete';
}

/**
 * Multi-layer robust score extractor that safely extracts intelligence, accuracy,
 * and speed scores from any response structure (flat JSON, Generative UI components, or events).
 */
export function extractGradingScores(
    data: any,
    durationMs: number
): { intelligence: number | null; accuracy: number | null; speed: number } {
    console.log('EXTRACT GRADING SCORES INPUT:', data);
    const fallbackSpeed = calculateSpeedScore(durationMs);
    let intVal: number | null = null;
    let accVal: number | null = null;
    let spdVal: number | null = null;

    const parseNum = (v: any): number | null => {
        if (typeof v === 'number' && !isNaN(v)) {
            return Math.min(10, Math.max(1, Math.round(v)));
        }
        if (typeof v === 'string') {
            const m = v.match(/\b([1-9]|10)\b/);
            if (m) return parseInt(m[1], 10);
            const mFloat = v.match(/([0-9]+(?:\.[0-9]+)?)/);
            if (mFloat) return Math.min(10, Math.max(1, Math.round(parseFloat(mFloat[1]))));
        }
        return null;
    };

    const tryInspectObject = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (intVal === null && (obj.intelligence !== undefined || obj.intellect !== undefined || obj.int !== undefined)) {
            intVal = parseNum(obj.intelligence ?? obj.intellect ?? obj.int);
        }
        if (accVal === null && (obj.accuracy !== undefined || obj.acc !== undefined)) {
            accVal = parseNum(obj.accuracy ?? obj.acc);
        }
        if (spdVal === null && (obj.speed !== undefined || obj.spd !== undefined)) {
            spdVal = parseNum(obj.speed ?? obj.spd);
        }
    };

    const tryScanString = (str: any) => {
        if (typeof str !== 'string' || !str.trim()) return;
        const cleaned = str.replace(/```(?:json)?\n?/gi, '').replace(/```/g, '').trim();

        // 1. Try finding JSON block
        try {
            const matches = cleaned.match(/\{[\s\S]*?\}/g);
            if (matches) {
                for (const m of matches) {
                    try {
                        const parsed = JSON.parse(m);
                        tryInspectObject(parsed);
                        if (intVal !== null && accVal !== null) return;
                    } catch {}
                }
            }
        } catch {}

        // 2. Regex matching for "intelligence: X" etc.
        if (intVal === null) {
            const m = cleaned.match(/\b(?:intelligence|intellect|int)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
            if (m) intVal = parseNum(m[1]);
        }
        if (accVal === null) {
            const m = cleaned.match(/\b(?:accuracy|acc)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
            if (m) accVal = parseNum(m[1]);
        }
        if (spdVal === null) {
            const m = cleaned.match(/\b(?:speed|spd)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
            if (m) spdVal = parseNum(m[1]);
        }
    };

    // Layer 1: Check raw data object
    tryInspectObject(data);
    tryInspectObject(data?.finalAnalysis);

    // Layer 2: Check events if present (events contain direct model outputs before guardManagerResponse)
    if (Array.isArray(data?.events)) {
        for (const ev of data.events) {
            tryInspectObject(ev.output);
            if (typeof ev.output === 'string') tryScanString(ev.output);
            if (intVal !== null && accVal !== null) break;
        }
    }

    // Layer 3: Scan components in Generative UI ManagerResponse
    if (data?.finalAnalysis && typeof data.finalAnalysis === 'object') {
        const fa = data.finalAnalysis;
        if (Array.isArray(fa.components)) {
            for (const comp of fa.components) {
                if (comp.props?.insights && Array.isArray(comp.props.insights)) {
                    for (const ins of comp.props.insights) {
                        tryScanString(typeof ins === 'string' ? ins : ins?.message);
                    }
                }
                if (comp.props?.title && comp.props?.value) {
                    const title = String(comp.props.title).toLowerCase();
                    if (title.includes('intel') && intVal === null) intVal = parseNum(comp.props.value);
                    if (title.includes('accur') && accVal === null) accVal = parseNum(comp.props.value);
                    if (title.includes('speed') && spdVal === null) spdVal = parseNum(comp.props.value);
                }
            }
        }
        if (fa.summary) tryScanString(fa.summary);
    }

    // Layer 4: Scan finalAnalysis as string
    if (typeof data?.finalAnalysis === 'string') {
        tryScanString(data.finalAnalysis);
    }

    console.log('EXTRACT GRADING SCORES OUTPUT:', { intelligence: intVal, accuracy: accVal, speed: spdVal });
    
    return {
        intelligence: intVal,
        accuracy: accVal,
        speed: spdVal !== null ? spdVal : fallbackSpeed
    };
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

    const resolveGraderAgent = (mgr: any) => {
        const provider = mgr?.provider && mgr.provider !== 'none' ? mgr.provider : 'gemini';
        let model = mgr?.model;
        if (!model || model.trim().length === 0) {
            if (provider === 'gemini') model = 'gemini-2.5-flash';
            else if (provider === 'groq') model = 'openai/gpt-oss-120b';
            else if (provider === 'openrouter') model = 'deepseek/deepseek-r1';
            else if (provider === 'mistral') model = 'mistral-small-latest';
            else if (provider === 'github') model = 'gpt-4o-mini';
            else model = 'simulated-swarm-v1';
        }
        return {
            id: 'manager',
            role: 'Manager Node',
            provider,
            model
        };
    };

    const generateTestPrompt = async (managerAgent: any, analystRole: string, baseTask: string): Promise<string> => {
        const failoverModels = [
            { provider: 'gemini', model: 'gemini-3.5-flash' },
            { provider: 'gemini', model: 'gemini-3.8-flash' },
            { provider: 'mistral', model: 'open-mistral-nemo' },
            { provider: 'openrouter', model: 'meta-llama/llama-3.2-3b-instruct:free' },
            { provider: 'openrouter', model: 'microsoft/phi-3-mini-128k-instruct:free' },
            { provider: 'gemini', model: 'gemini-1.5-flash' }
        ];

        try {
            const promptTask = `As the Swarm Manager, generate a highly specific, complex test prompt designed to challenge a sub-agent with the role: "${analystRole}".
The overall system task is: "${baseTask}".
Create a realistic scenario or question that perfectly fits this analyst's domain to test their intelligence and accuracy.
Respond ONLY with the text of the prompt you want to give them.`;

            const cleanSettings = { ...settings };
            delete cleanSettings.activeVariant;

            const errors: string[] = [];
            for (let i = 0; i < failoverModels.length; i++) {
                const currentIndex = (nextFailoverIndex + i) % failoverModels.length;
                const failover = failoverModels[currentIndex];
                try {
                    const res = await fetch('/api/swarm/analyze', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            task: promptTask,
                            data: '',
                            bypassCache: true,
                            settings: {
                                ...cleanSettings,
                                agents: [{ id: 'grader-agent', role: 'Prompt Generator Node', provider: failover.provider, model: failover.model }],
                                forceFullSwarm: false,
                                disableFallback: true
                            }
                        })
                    });

                    if (!res.ok) {
                        if (res.status === 429) await new Promise(r => setTimeout(r, 2500));
                        continue;
                    }
                    const data = await res.json();

                    if (data.finalAnalysis && typeof data.finalAnalysis === 'object' && !data.finalAnalysis.ui_title?.toLowerCase().includes('error')) {
                        if (data.finalAnalysis.components?.[0]?.props?.insights?.[0]?.message) {
                            nextFailoverIndex = (currentIndex + 1) % failoverModels.length;
                            return data.finalAnalysis.components[0].props.insights[0].message;
                        } else if (data.finalAnalysis.summary) {
                            nextFailoverIndex = (currentIndex + 1) % failoverModels.length;
                            return data.finalAnalysis.summary;
                        }
                    }

                    if (typeof data.finalAnalysis === 'string' && !data.finalAnalysis.includes('Error')) {
                        nextFailoverIndex = (currentIndex + 1) % failoverModels.length;
                        return data.finalAnalysis;
                    }
                } catch (e) {
                    console.warn(`Test prompt generation failed for ${failover.model}`, e);
                }
            }

            return baseTask;
        } catch (e) {
            console.error("Prompt generation failed completely", e);
            return baseTask;
        }
    };

    const autoGradeOutput = async (originalTask: string, output: any, durationMs: number, managerAgent: any) => {
        const failoverModels = [
            { provider: 'gemini', model: 'gemini-3.5-flash' },
            { provider: 'gemini', model: 'gemini-3.8-flash' },
            { provider: 'mistral', model: 'open-mistral-nemo' },
            { provider: 'openrouter', model: 'meta-llama/llama-3.2-3b-instruct:free' },
            { provider: 'openrouter', model: 'microsoft/phi-3-mini-128k-instruct:free' },
            { provider: 'gemini', model: 'gemini-1.5-flash' }
        ];

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

Respond ONLY with a valid JSON object matching this exact format, substituting the <X> placeholders with your actual 1-10 integer scores:
{"intelligence": <X>, "accuracy": <Y>, "speed": <Z>}
Do not return the literal string <X>. You MUST actually grade the output and provide real numbers.`;

            const cleanSettings = { ...settings };
            delete cleanSettings.activeVariant;

            const errors: string[] = [];
            for (let i = 0; i < failoverModels.length; i++) {
                const currentIndex = (nextFailoverIndex + i) % failoverModels.length;
                const failover = failoverModels[currentIndex];
                try {
                    const res = await fetch('/api/swarm/analyze', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            task: gradingTask,
                            data: '',
                            bypassCache: true,
                            settings: {
                                ...cleanSettings,
                                agents: [{ id: 'grader-agent', role: 'Grader Node', provider: failover.provider, model: failover.model }],
                                forceFullSwarm: false,
                                disableFallback: true
                            }
                        })
                    });

                    if (!res.ok) {
                        if (res.status === 429) await new Promise(r => setTimeout(r, 2500));
                        const errText = await res.text();
                        errors.push(`${failover.model}: ${res.status} ${errText}`);
                        continue;
                    }
                    const data = await res.json();
                    
                    const scores = extractGradingScores(data, durationMs);
                    if (scores.intelligence !== null && scores.accuracy !== null) {
                        nextFailoverIndex = (currentIndex + 1) % failoverModels.length;
                        return scores;
                    } else {
                        errors.push(`${failover.model}: Failed to extract. Raw: ${JSON.stringify(data?.finalAnalysis || data).substring(0, 500)}`);
                    }
                } catch (e: any) {
                    errors.push(`${failover.model}: ${e.message}`);
                }
            }
            
            throw new Error(`All grading failovers failed:\n${errors.join('\n')}`);
        } catch (e: any) {
            console.error("Autograding failed completely", e);
            throw e; // RETHROW SO THE UI CAN SEE IT
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
            const filteredAgents = settings.agents
                .filter((a: any) => a.id === agentToTest.id || a.id === managerAgent.id)
                .map((a: any) => 
                    a.id === agentToTest.id ? { ...a, provider: agentToTest.provider, model: model.id } : a
                );
            
            const hasSubAgents = filteredAgents.some((a: any) => a.id !== managerAgent.id && a.role !== 'Manager Node');
            if (!hasSubAgents) {
                filteredAgents.push({
                    id: 'mock-analyst-test',
                    role: 'Mock Analyst',
                    provider: 'simulated',
                    model: 'simulated-model'
                });
            }

            const cleanSettings = { ...settings };
            delete cleanSettings.activeVariant;

            const testSettings = {
                ...cleanSettings,
                agents: filteredAgents,
                forceFullSwarm: false,
                disableFallback: true
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
                        bypassCache: true,
                        settings: testSettings
                    })
                });
                const resData = await res.json().catch(() => null);
                if (!res.ok) {
                    throw new Error(resData?.error ? String(resData.error) : `HTTP error ${res.status}`);
                }
                if (resData.error) throw new Error(resData.error);

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
            } catch (e: any) {
                errorMsg = e.message;
                recordError(model.id, agentToTest.provider, errorMsg);
            }
            const duration = Date.now() - start;

            let autoScore = { intelligence: null, accuracy: null, speed: calculateSpeedScore(duration) };
            if (isModelResponseValid({ output, error: errorMsg })) {
                setProgress(`Auto-grading ${model.name || model.id}...`);
                try {
                    const scoreRes = await autoGradeOutput(agentTestTask, output, duration, managerAgent);
                    if (scoreRes) {
                        autoScore = {
                            ...scoreRes,
                            speed: scoreRes.speed !== null ? scoreRes.speed : calculateSpeedScore(duration)
                        };
                    }
                } catch (e: any) {
                    errorMsg = `Autograding failed: ${e.message}`;
                    recordError(model.id, agentToTest.provider, errorMsg);
                }
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
            await delay(6000);
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
                        bypassCache: true,
                        settings: testSettings
                    })
                });
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
            if (isModelResponseValid({ output, error: errorMsg })) {
                setProgress(`Auto-grading Combo...`);
                try {
                    const scoreRes = await autoGradeOutput(task, output, duration, managerAgent);
                    if (scoreRes) {
                        autoScore = {
                            ...scoreRes,
                            speed: scoreRes.speed !== null ? scoreRes.speed : calculateSpeedScore(duration)
                        };
                    }
                } catch (e: any) {
                    errorMsg = `Combo Autograding failed: ${e.message}`;
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
                                            ) : !isModelResponseValid(r) ? (
                                                <div className="text-amber-600 text-[10px] italic">Incomplete or empty response</div>
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
                                        <th className="px-4 py-3">Time</th>
                                        <th className="px-4 py-3">Speed Score</th>
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
                                            <td className="px-4 py-3 font-semibold text-purple-700">{r.scores.speed || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-blue-700">{r.scores.intelligence || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-emerald-700">{r.scores.accuracy || '-'}</td>
                                            <td className="px-4 py-3 max-w-xs truncate text-xs text-neutral-600 font-mono">
                                                {r.error ? (
                                                    <span className="text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {r.error}</span>
                                                ) : !isModelResponseValid(r) ? (
                                                    <span className="text-amber-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Incomplete output</span>
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
                                        <th className="px-4 py-3">Time</th>
                                        <th className="px-4 py-3">Speed Score</th>
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
                                            <td className="px-4 py-3 font-semibold text-purple-700">{r.scores.speed || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-blue-700">{r.scores.intelligence || '-'}</td>
                                            <td className="px-4 py-3 font-semibold text-emerald-700">{r.scores.accuracy || '-'}</td>
                                            <td className="px-4 py-3 text-xs">
                                                {r.error ? (
                                                    <span className="text-red-500 font-medium">Error</span>
                                                ) : isModelResponseValid(r) ? (
                                                    <span className="text-green-600 font-medium">Valid</span>
                                                ) : (
                                                    <span className="text-amber-500 font-medium" title="Model returned empty or incomplete response">Incomplete</span>
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
    );
};
