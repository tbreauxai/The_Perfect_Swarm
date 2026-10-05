import type { GoogleGenAI } from '@google/genai';
import type { SemanticCacheInterceptorConfig } from '../semanticCacheInterceptor.ts';
import type { ActionPlanCacheInterceptor, ActionPlanCacheConfig } from '../actionPlanCache.ts';
import type { SwarmDomain, MemoryType } from './tags.ts';

export * from './tags.ts';

export interface MemoryMetadata {
    originApp?: string;
    appId?: string;
    domain?: SwarmDomain | string;
    memoryType?: MemoryType;
    entityIds?: string[];
    agentRole?: string;
    sessionId?: string;
    qualityRating?: number; // 0.0 to 1.0
    verified?: boolean;
    feedback?: string;
    frequency?: number;
    tags?: string[];
    timestamp?: string;
    lastSeen?: string;
    [key: string]: any;
}

export type RrfProfile = 'semantic' | 'lexical' | 'balanced' | 'hybrid' | 'quantitative';
export type RrfWeights = { denseWeight: number; sparseWeight: number };

export const RRF_PRESETS: Record<RrfProfile, RrfWeights> = {
    semantic: { denseWeight: 4.0, sparseWeight: 0.5 },
    lexical: { denseWeight: 0.5, sparseWeight: 4.0 },
    balanced: { denseWeight: 1.0, sparseWeight: 1.0 },
    hybrid: { denseWeight: 2.0, sparseWeight: 1.5 },
    quantitative: { denseWeight: 0.2, sparseWeight: 4.0 }
};

export interface RetrievalOptions {
    appId?: string;
    originApp?: string;
    targetApps?: string | string[];
    domain?: string;
    entityIds?: string[];
    entityId?: string;
    limit?: number;
    minRating?: number;
    verifiedOnly?: boolean;
    agentRole?: string;
    includeShared?: boolean;
    denseWeight?: number;
    sparseWeight?: number;
    profile?: RrfProfile | RrfWeights;
    rrfProfile?: RrfProfile | RrfWeights;
}

export interface ConsolidationOptions {
    appId?: string;
    minRating?: number;
    maxAgeDays?: number;
    pruneLowQuality?: boolean;
}

export interface ConsolidationResult {
    inspected: number;
    pruned: number;
    retained: number;
    prunedIds: string[];
}

export interface ExportMemoriesOptions {
    appId?: string;
    minRating?: number;
    verifiedOnly?: boolean;
    includeVectors?: boolean;
    format?: 'snapshot' | 'json' | 'jsonl';
}

export interface MemorySnapshotPoint {
    id: string;
    content: string;
    metadata: MemoryMetadata & {
        appId: string;
        qualityRating: number;
        verified: boolean;
        frequency: number;
        timestamp: string;
        lastSeen: string;
    };
    denseVector?: number[];
    sparseVector?: SparseVector;
}

export interface MemorySnapshot {
    version: string;
    exportedAt: string;
    collectionName: string;
    pointCount: number;
    memories: MemorySnapshotPoint[];
}

export interface ImportMemoriesOptions {
    targetAppId?: string;
    deduplicate?: boolean;
    recomputeVectors?: boolean;
    minRating?: number;
}

export interface ImportMemoriesResult {
    imported: number;
    skipped: number;
    deduplicated: number;
    importedIds: string[];
}

export interface StoredMemoryPoint {
    id: string;
    denseVector: number[];
    sparseVector: SparseVector;
    payload: MemoryMetadata & {
        content: string;
        appId: string;
        frequency: number;
        qualityRating: number;
        verified: boolean;
        timestamp: string;
        lastSeen: string;
    };
}

export interface SparseVector {
    indices: number[];
    values: number[];
}

export interface EmbeddingProvider {
    readonly dimension: number;
    embed(text: string): Promise<number[]>;
}

export interface MemoryCortexDiagnostics {
    qdrantAvailable: boolean;
    collectionName: string;
    pointCount: number;
    appCount: number;
    apps: string[];
    fallbackStoreSize: number;
    storageByDomain: Record<string, number>;
    storageByRole: Record<string, number>;
    latencyStats?: {
        mean: number;
        p95: number;
        p99: number;
    };
    cacheHitRatio?: number;
    modelSuggestions?: string;
    roleRecommendations?: Array<{ role: string; recommendedProvider: string; recommendedModel: string; reason: string }>;
}

export interface MemoryCortexConfig {
    url?: string;
    apiKey?: string;
    collectionName?: string;
    collectionNameTemplate?: string;
    defaultAppId?: string;
    embeddingProvider?: EmbeddingProvider;
    aiClient?: GoogleGenAI;
    embeddingModel?: string;
    isolatedStore?: boolean;
    autoConsolidateThreshold?: number;
    autoConsolidationOptions?: ConsolidationOptions;
    persistPath?: string;
    autoSave?: boolean;
    semanticCacheConfig?: SemanticCacheInterceptorConfig;
    actionPlanCache?: ActionPlanCacheInterceptor;
    actionPlanCacheConfig?: ActionPlanCacheConfig;
}
