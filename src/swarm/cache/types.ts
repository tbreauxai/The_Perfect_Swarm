export interface CacheEntry<T = any> {
    fingerprint: string;
    payload: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    metadata?: Record<string, any>;
}

export interface PayloadCacheConfig {
    maxEntries?: number;       // default: 250
    defaultTtlMs?: number;     // default: 15 minutes (900,000 ms)
}

export interface CacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
}

export interface FingerprintOptions {
    appId?: string;
    deepAnalysis?: boolean;
    forceFullSwarm?: boolean;
    complexity?: string;
    model?: string;
    agentConfigVersion?: string;
    maxTokens?: number;
}

export interface SemanticCacheEntry<T = any> {
    id: string;
    task: string;
    dataSample: string;
    normalizedTask: string;
    taskTokens: string[];
    taskTrigrams: Set<string>;
    payload: T;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    configVersion?: string;
    metadata?: Record<string, any>;
}

export interface SemanticCacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
    estimatedTokensSaved: number;
}

export interface SemanticCacheConfig {
    maxEntries?: number;          // default: 200
    defaultTtlMs?: number;        // default: 30 minutes (1,800,000 ms)
    similarityThreshold?: number; // default: 0.80 (80% similarity required for hit)
}

export interface SemanticMatchResult<T = any> {
    hit: boolean;
    entry?: SemanticCacheEntry<T>;
    similarity: number;
    matchedTask?: string;
    reason?: string;
}
