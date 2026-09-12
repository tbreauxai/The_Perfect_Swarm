import { GoogleGenAI } from '@google/genai';
import { Agent, Provider, SwarmContext } from '../swarm.ts';

export type TaskComplexity = 'simple' | 'formatting' | 'complex';

export interface RouteConfig {
    complexity: TaskComplexity;
    role: string;
    systemInstruction: string;
    apiKey: string;
    modelName?: string;
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
                modelName = config.modelName || 'default-simple-model';
                break;
            case 'formatting':
                // Formatting, structuring, moderate data tasks
                modelName = config.modelName || 'default-formatting-model';
                break;
            case 'complex':
                // Complex reasoning, deep analysis
                modelName = config.modelName || 'default-complex-model';
                break;
            default:
                modelName = config.modelName || 'default-model';
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
