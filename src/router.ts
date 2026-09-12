import { GoogleGenAI } from '@google/genai';
import { Agent, Provider, SwarmContext } from '../swarm.ts';

export type TaskComplexity = 'simple' | 'formatting' | 'complex';

export interface RouteConfig {
    complexity: TaskComplexity;
    role: string;
    systemInstruction: string;
    apiKey: string;
    aiClient?: GoogleGenAI;
}

export class ModelRouter {
    /**
     * Dynamically routes the task to the most efficient model based on complexity.
     */
    static createRoutedAgent(config: RouteConfig): Agent {
        let modelName = '';
        let provider: Provider = 'gemini';

        switch (config.complexity) {
            case 'simple':
                // Simple edits, data extraction
                modelName = 'gemini-2.5-flash-8b';
                break;
            case 'formatting':
                // Formatting, structuring, moderate data tasks
                modelName = 'gemini-2.5-flash';
                break;
            case 'complex':
                // Complex reasoning, deep analysis
                modelName = 'gemini-2.5-pro';
                break;
            default:
                modelName = 'gemini-2.5-flash';
        }

        const agent = new Agent(
            config.role,
            modelName,
            provider,
            config.apiKey,
            config.aiClient
        );
        
        // We inject the system instruction into the agent state so it can be 
        // statically prefixed for caching purposes.
        agent.setSystemInstruction(config.systemInstruction);

        return agent;
    }
}
