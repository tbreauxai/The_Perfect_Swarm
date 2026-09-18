import type { GoogleGenAI } from '@google/genai';

export const KNOWN_PROVIDERS = ['gemini', 'groq', 'openrouter', 'github', 'mistral', 'simulated'] as const;

export type Provider = typeof KNOWN_PROVIDERS[number] | string;

export interface AgentConfig {
    id?: string;
    role: string;
    provider: string;
    model: string;
    apiKey?: string;
}

export interface SwarmExperimentSettings {
    experimentId?: string;
    experimentManager?: any;
    disableABTesting?: boolean;
    routingKey?: string;
    autoRecordMetrics?: boolean;
}

export interface SwarmCompressionSettings {
    enabled?: boolean;
    targetReductionRatio?: number;
    similarityThreshold?: number;
    maxTokens?: number;
    preserveAnomalies?: boolean;
    stripBoilerplate?: boolean;
}

export interface SwarmSchedulingSettings {
    enabled?: boolean;
    strategy?: 'priority' | 'shortest-job-first' | 'least-loaded' | 'fair-share' | 'work-stealing';
    maxConcurrency?: number;
    enableRateLimiting?: boolean;
    agingThresholdMs?: number;
    rateLimits?: Record<string, { maxRpm?: number; maxTpm?: number }>;
}

export interface SwarmHierarchySettings {
    enabled?: boolean;
    autoDiscoverTree?: boolean;
    delegationEnabled?: boolean;
    escalationEnabled?: boolean;
}

export interface SwarmTieredCacheSettings {
    enabled?: boolean;
    l1MaxEntries?: number;
    l2MaxEntries?: number;
    l2SimilarityThreshold?: number;
    l3MaxEntries?: number;
    quantizationMode?: 'sq8' | 'binary';
    enableStateSnapshots?: boolean;
}

export interface SwarmEngineSettings {
    geminiApiKey?: string;
    openRouterApiKey?: string;
    groqApiKey?: string;
    mistralApiKey?: string;
    githubToken?: string;
    disableFallback?: boolean;
    forceFullSwarm?: boolean;
    disableFastPath?: boolean;
    speculativeParallel?: boolean;
    maxSpeculativeConcurrency?: number;
    conflictResolutionStrategy?: 'confidence_weighted' | 'conservative_pessimistic' | 'majority_consensus' | 'deduplicate_union';
    critic?: AgentConfig;
    agents?: AgentConfig[];
    experimentSettings?: SwarmExperimentSettings;
    compressionSettings?: SwarmCompressionSettings;
    schedulingSettings?: SwarmSchedulingSettings;
    hierarchySettings?: SwarmHierarchySettings;
    tieredCacheSettings?: SwarmTieredCacheSettings;
    profilingSettings?: SwarmProfilingSettings;
    [key: string]: any;
}

export interface SwarmProfilingSettings {
    enabled?: boolean;
    sampleSubsystems?: boolean;
    detectAnomalies?: boolean;
    recordTrace?: boolean;
}


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
    zodSchema?: any;
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
