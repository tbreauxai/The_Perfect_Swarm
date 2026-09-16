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
    static evaluateFastPath(task: string, data: string = "", deepAnalysisRequested: boolean = false): FastPathDecision {
        const taskClean = (task || '').trim();
        const dataClean = (data || '').trim();
        const estimatedTokens = Math.ceil((taskClean.length + dataClean.length) / 4);

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
    static isFastPathEligible(task: string, dataLength: number = 0, deepAnalysisRequested: boolean = false): boolean {
        if (deepAnalysisRequested || dataLength >= 256) return false;
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
    static inferComplexity(task: string, dataLength: number = 0, chunkCount: number = 1): TaskComplexity {
        if (this.isFastPathEligible(task, dataLength)) {
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
     * Dynamically routes the task to the most efficient model based on complexity.
     */
    static createRoutedAgent(config: RouteConfig): Agent {
        const provider = config.provider || 'gemini';
        let modelName = config.modelName || '';

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
