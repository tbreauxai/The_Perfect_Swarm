import type { GoogleGenAI } from '@google/genai';

export const KNOWN_PROVIDERS = ['gemini', 'groq', 'openrouter', 'github', 'mistral'] as const;

export type Provider = typeof KNOWN_PROVIDERS[number] | string;

export interface ProviderCredential {
    provider: Provider;
    apiKey: string;
    modelName?: string;
    aiClient?: GoogleGenAI;
}

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
    failover?: {
        fromProvider: string;
        toProvider: string;
        reason: string;
    };
}

export interface AgentRunConfig {
    responseMimeType?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    fallbackProviders?: ProviderCredential[];
    [key: string]: any;
}

export interface ProviderCallOptions {
    modelName: string;
    prompt: string;
    systemInstruction?: string;
    apiKey: string;
    aiClient?: GoogleGenAI;
    config?: AgentRunConfig;
    timeoutMs?: number;
}

export interface ProviderAdapter {
    readonly providerName: string;
    call(options: ProviderCallOptions): Promise<string>;
}

export interface VerificationResult {
    pass: boolean;
    feedback?: string;
}

export interface LearnedMemoryEvent {
    appId: string;
    content: string;
    id?: string;
    metadata: {
        domain?: string;
        agentRole?: string;
        qualityRating?: number;
        verified?: boolean;
        feedback?: string;
        task?: string;
        fastPath?: boolean;
        [key: string]: any;
    };
}
