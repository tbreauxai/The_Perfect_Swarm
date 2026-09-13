import type { GoogleGenAI } from '@google/genai';

export const KNOWN_PROVIDERS = ['gemini', 'groq', 'openrouter', 'github', 'mistral'] as const;

export type Provider = typeof KNOWN_PROVIDERS[number] | string;

export interface SwarmEvent {
    id: string;
    timestamp: string;
    agentRole: string;
    action: string;
    modelName: string;
    prompt: string;
    output?: any;
    error?: string;
    durationMs?: number;
}

export interface AgentRunConfig {
    responseMimeType?: string;
    temperature?: number;
    maxTokens?: number;
    [key: string]: any;
}

export interface ProviderCallOptions {
    modelName: string;
    prompt: string;
    systemInstruction?: string;
    apiKey: string;
    aiClient?: GoogleGenAI;
    config?: AgentRunConfig;
}

export interface ProviderAdapter {
    readonly providerName: string;
    call(options: ProviderCallOptions): Promise<string>;
}
