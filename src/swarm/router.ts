import type { GoogleGenAI } from '@google/genai';
import { Agent } from './agent.ts';
import type { Provider } from './types.ts';

export type TaskComplexity = 'instant' | 'simple' | 'formatting' | 'complex';

export interface RouteConfig {
    complexity: TaskComplexity;
    role: string;
    systemInstruction?: string;
    apiKey: string;
    provider?: Provider;
    modelName?: string;
    aiClient?: GoogleGenAI;
}

export interface FastPathDecision {
    eligible: boolean;
    reason: string;
    targetTier: TaskComplexity;
    estimatedTokens: number;
}

export class ModelRouter {
    /**
     * Evaluates whether an incoming task and payload should be short-circuited via the fast-path.
     * Prevents low-complexity intents (< 35 tokens, e.g. quick summaries, greetings, direct questions)
     * from triggering heavy multi-agent profiling, chunk partitioning, Qdrant vector retrieval, and critic loops.
     */
    static evaluateFastPath(
        task: string,
        data: string = "",
        deepAnalysisRequested: boolean = false,
        forceFullSwarm: boolean = false
    ): FastPathDecision {
        const taskClean = (task || '').trim();
        const dataClean = (data || '').trim();
        const estimatedTokens = Math.ceil((taskClean.length + dataClean.length) / 4);

        if (forceFullSwarm) {
            return {
                eligible: false,
                reason: 'Full swarm execution explicitly requested via settings override; fast-path short-circuit bypassed.',
                targetTier: 'simple',
                estimatedTokens
            };
        }

        if (deepAnalysisRequested) {
            return {
                eligible: false,
                reason: 'Deep analysis explicitly requested; full swarm verification required.',
                targetTier: 'complex',
                estimatedTokens
            };
        }

        const lower = taskClean.toLowerCase();
        const deepKeywords = [
            'audit', 'deep', 'verify', 'critique', 'root cause', 'red team',
            'investigate', 'cross-reference', 'security', 'benchmark', 'correlate', 'vulnerability', 'synthesize'
        ];

        if (deepKeywords.some(k => lower.includes(k))) {
            return {
                eligible: false,
                reason: 'Task contains deep analysis or verification keywords.',
                targetTier: 'complex',
                estimatedTokens
            };
        }

        // Fast-path condition: task + data under 35 tokens AND data payload under 256 characters
        if (estimatedTokens < 35 && dataClean.length < 256) {
            return {
                eligible: true,
                reason: `Low-complexity intent (${estimatedTokens} est. tokens) qualifies for fast-path short-circuiting.`,
                targetTier: 'instant',
                estimatedTokens
            };
        }

        const formatKeywords = ['format', 'table', 'csv', 'clean', 'structure', 'json', 'reformat'];
        if (formatKeywords.some(k => lower.includes(k))) {
            return {
                eligible: false,
                reason: 'Formatting task requires standard schema processing.',
                targetTier: 'formatting',
                estimatedTokens
            };
        }

        return {
            eligible: false,
            reason: `Task complexity (${estimatedTokens} est. tokens, ${dataClean.length} bytes data) requires standard swarm orchestration.`,
            targetTier: estimatedTokens > 3000 ? 'complex' : 'simple',
            estimatedTokens
        };
    }

    /**
     * Quick boolean check for fast-path short-circuiting.
     */
    static isFastPathEligible(
        task: string,
        dataLength: number = 0,
        deepAnalysisRequested: boolean = false,
        forceFullSwarm: boolean = false
    ): boolean {
        if (forceFullSwarm || deepAnalysisRequested || dataLength >= 256) return false;
        const taskClean = (task || '').trim();
        const estTokens = Math.ceil((taskClean.length + dataLength) / 4);
        if (estTokens >= 35) return false;

        const lower = taskClean.toLowerCase();
        const deepKeywords = ['audit', 'deep', 'verify', 'critique', 'root cause', 'red team', 'investigate', 'security', 'benchmark', 'synthesize'];
        return !deepKeywords.some(k => lower.includes(k));
    }

    /**
     * Infers task complexity based on task description, data payload size, and chunk count.
     */
    static inferComplexity(
        task: string,
        dataLength: number = 0,
        chunkCount: number = 1,
        forceFullSwarm: boolean = false
    ): TaskComplexity {
        if (!forceFullSwarm && this.isFastPathEligible(task, dataLength, false, forceFullSwarm)) {
            return 'instant';
        }
        const lower = (task || '').toLowerCase();
        const deepKeywords = ['audit', 'deep', 'verify', 'critique', 'root cause', 'red team', 'complex', 'investigate', 'cross-reference', 'security', 'benchmark', 'synthesize'];
        if (deepKeywords.some(k => lower.includes(k)) || chunkCount > 2 || dataLength > 15000) {
            return 'complex';
        }
        const formatKeywords = ['format', 'table', 'csv', 'clean', 'structure', 'json', 'reformat'];
        if (formatKeywords.some(k => lower.includes(k))) {
            return 'formatting';
        }
        return 'simple';
    }

    /**
     * Resolves the default recommended model for a given provider and complexity tier.
     */
    static getRecommendedModel(provider: Provider, complexity: TaskComplexity): string {
        const p = (provider || 'gemini').toLowerCase();
        switch (p) {
            case 'gemini':
                // gemini-2.5-flash offers 15 RPM / 1M token window on free tier
                return 'gemini-2.5-flash';
            case 'groq':
                return complexity === 'instant' ? 'llama-3.1-8b-instant' : 'llama3-70b-8192';
            case 'openrouter':
                return complexity === 'complex'
                    ? 'deepseek/deepseek-r1:free'
                    : complexity === 'instant'
                    ? 'meta-llama/llama-3.1-8b-instruct:free'
                    : 'google/gemini-2.0-flash-exp:free';
            case 'mistral':
                // mistral-small-latest is available on Mistral free API tier
                return 'mistral-small-latest';
            case 'github':
                // gpt-4o-mini has higher RPM allowance on GitHub Models free tier
                return 'gpt-4o-mini';
            default:
                return 'gemini-2.5-flash';
        }
    }

    static isValidModel(model: string): boolean {
        return typeof model === 'string' && model.length > 0;
    }

    /**
     * Dynamically routes the task to the most efficient model based on complexity.
     */
    static createRoutedAgent(config: RouteConfig): Agent {
        const provider = config.provider || 'gemini';
        let modelName = config.modelName;

        if (!modelName || !this.isValidModel(modelName)) {
            modelName = this.getRecommendedModel(provider, config.complexity);
        }

        const agent = new Agent(
            config.role,
            modelName,
            provider,
            config.apiKey,
            config.aiClient
        );
        
        if (config.systemInstruction) {
            agent.setSystemInstruction(config.systemInstruction);
        }

        return agent;
    }
}
