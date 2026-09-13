import type { GoogleGenAI } from '@google/genai';
import { Agent, type Provider } from '../swarm.ts';

export type TaskComplexity = 'simple' | 'formatting' | 'complex';

export interface RouteConfig {
    complexity: TaskComplexity;
    role: string;
    systemInstruction?: string;
    apiKey: string;
    provider?: Provider;
    modelName?: string;
    aiClient?: GoogleGenAI;
}

export class ModelRouter {
    /**
     * Infers task complexity based on task description, data payload size, and chunk count.
     */
    static inferComplexity(task: string, dataLength: number = 0, chunkCount: number = 1): TaskComplexity {
        const lower = (task || '').toLowerCase();
        const deepKeywords = ['audit', 'deep', 'verify', 'critique', 'root cause', 'red team', 'complex', 'investigate', 'cross-reference', 'security', 'benchmark'];
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
                return complexity === 'complex' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
            case 'groq':
                return 'llama-3.3-70b-versatile';
            case 'openrouter':
                return complexity === 'complex' ? 'deepseek/deepseek-r1' : 'google/gemini-2.5-flash';
            case 'mistral':
                return complexity === 'complex' ? 'mistral-large-latest' : 'mistral-small-latest';
            case 'github':
                return 'gpt-4o';
            default:
                return 'gemini-2.5-flash';
        }
    }

    /**
     * Dynamically routes the task to the most efficient model based on complexity.
     */
    static createRoutedAgent(config: RouteConfig): Agent {
        const provider = config.provider || 'gemini';
        const modelName = config.modelName || this.getRecommendedModel(provider, config.complexity);

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
