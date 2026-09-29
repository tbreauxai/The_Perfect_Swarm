import { AgentConfig, Provider, ProviderCredential } from "../types.ts";

export interface ProviderTelemetry {
    provider: Provider;
    status: ProviderHealthStatus;
    inFlightRequests: number;
    latencyEmaMs: number;
    lastLatencyMs: number;
    totalRequests: number;
    successCount: number;
    failureCount: number;
    rateLimitCount: number;
    lastError?: string;
    lastErrorTimestamp?: number;
    cooldownUntil?: number;
}

export interface LoadBalancerConfig {
    emaAlpha?: number;
    inFlightPenaltyMs?: number;
    rateLimitCooldownMs?: number;
    degradedThresholdErrors?: number;
}

export interface TokenBudgetConfig {
    defaultTpmLimit?: number;
    providerTpmLimits?: Record<string, number>;
    windowMs?: number;
}

export interface TokenUsageRecord {
    timestamp: number;
    tokens: number;
    agentId?: string;
}

export interface TokenBudgetMetrics {
    provider: string;
    tpmLimit: number;
    tokensUsedInWindow: number;
    tokensRemainingInWindow: number;
    utilizationPercent: number;
    totalCumulativeTokens: number;
}

export interface NodeCapacityConfig {
    defaultMaxConcurrency?: number;
    nodeConcurrencyLimits?: Record<string, number>;
    saturationThreshold?: number;
}

export interface CapacitySlot {
    slotId: string;
    nodeKey: string;
    acquiredAt: number;
    weight: number;
    metadata?: Record<string, any>;
    release: () => void;
}

export interface NodeCapacityMetrics {
    nodeKey: string;
    maxConcurrency: number;
    activeInFlight: number;
    availableHeadroom: number;
    utilizationRatio: number;
    utilizationPercent: number;
    isSaturated: boolean;
    totalSlotsAcquired: number;
    totalSlotsReleased: number;
}

export interface SpecialistOutcomeFeedback {
    success: boolean;
    qualityRating?: number;
    durationMs?: number;
    domain?: string;
    tokensUsed?: number;
    error?: string;
}

export interface DomainCapabilityStats {
    trials: number;
    successes: number;
    totalReward: number;
    averageReward: number;
    lastUpdated: number;
}

export interface SpecialistCapabilityProfile {
    agentRole: string;
    trials: number;
    successes: number;
    failures: number;
    completionRate: number;
    totalReward: number;
    averageReward: number;
    latencyEmaMs: number;
    domainStats: Record<string, DomainCapabilityStats>;
    lastUpdated: number;
}

export interface CapabilityProfilerConfig {
    explorationConstant?: number;
    emaAlpha?: number;
    defaultLatencyBaselineMs?: number;
}

export interface SpecialistDomainRule {
    domain: string;
    roleKeywords: string[];
    taskKeywords: string[];
}

export interface ChunkAssignment {
    chunkIndex: number;
    estimatedTokens: number;
    agentId: string;
    agentRole: string;
    provider: string;
    affinityScore: number;
    rlScore?: number;
    nodeHeadroom?: number;
    isSpillover?: boolean;
    allocatedTokens: number;
    reason: string;
}

export interface SpecialistRoutingPlan {
    totalChunks: number;
    totalEstimatedTokens: number;
    assignments: ChunkAssignment[];
    specialistSummary: Record<string, {
            role: string;
            chunksAssigned: number;
            tokensAllocated: number;
            nodeHeadroom?: number;
            isSaturated?: boolean;
        }>;
}

export interface SpecialistCandidate {
    id?: string;
    role: string;
    provider: string;
}

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'cooldown';
