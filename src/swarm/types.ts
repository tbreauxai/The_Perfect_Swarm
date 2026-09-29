import type { GoogleGenAI } from '@google/genai';

export const KNOWN_PROVIDERS = ['gemini', 'groq', 'openrouter', 'github', 'mistral', 'simulated'] as const;

export type Provider = typeof KNOWN_PROVIDERS[number] | string;

export interface AgentConfig {
    id?: string;
    role: string;
    provider: string;
    model: string;
    apiKey?: string;
    maxTokens?: number;
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
    feedbackSettings?: SwarmFeedbackSettings;
    coordinationSettings?: SwarmCoordinationSettings;
    optimizationSettings?: SwarmOptimizationSettings;
    [key: string]: any;
}

export interface SwarmOptimizationSettings {
    enabled?: boolean;
    workerPoolConcurrency?: number;
    enableEarlyExit?: boolean;
    confidenceThreshold?: number;
    marginThreshold?: number;
    enableSubComputationCache?: boolean;
    enablePreFiltering?: boolean;
    emitEarlyPartialResults?: boolean;
}

export interface SwarmCoordinationSettings {
    enabled?: boolean;
    adaptiveLearningRates?: boolean;
    hierarchicalDecomposition?: boolean;
    hypothesisValidation?: boolean;
    rewardShaping?: boolean;
    channelCapacity?: number;
    initialLearningRate?: number;
}

export interface SwarmFeedbackSettings {
    enabled?: boolean;
    autoTune?: boolean;
    detectDrift?: boolean;
    validateData?: boolean;
    rewardWeights?: {
        quality?: number;
        accuracy?: number;
        latency?: number;
        cost?: number;
        tokenSavings?: number;
    };
    initialParameters?: Record<string, any>;
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

/**
 * Maps raw backend/network errors to clean actionable user-facing messages,
 * stripping stack-traces and internal server paths.
 */
export function formatActionableError(rawError: unknown): string {
    if (!rawError) return 'An unexpected error occurred during execution.';
    const errStr = typeof rawError === 'string' ? rawError : (rawError as any).message || String(rawError);

    if (/\b401\b|unauthorized|invalid[_\s]api[_\s]key|api[_\s]key[_\s]not[_\s]configured/i.test(errStr)) {
        return 'API key invalid — check Settings → API keys';
    }
    if (/\b429\b|rate[_\s]limit|quota[_\s]exceeded|too[_\s]many[_\s]requests/i.test(errStr)) {
        return 'Quota exhausted — cooling down, try again shortly';
    }
    if (/\b5\d{2}\b|internal[_\s]server[_\s]error|bad[_\s]gateway|service[_\s]unavailable/i.test(errStr)) {
        return 'Provider error — failover engaged';
    }

    const lines = errStr.split('\n');
    const cleaned = lines
        .filter(l => !/^\s*at\s+/i.test(l))
        .join('\n')
        .replace(/\/app\/[^\s:]+/g, '')
        .trim();

    return cleaned || 'An unexpected error occurred during execution.';
}

