/**
 * Semantic Action/Plan Cache Interceptor for agent-retriever.
 * 
 * Intercepts queries prior to expensive Qdrant dense/sparse hybrid vector search (45ms),
 * caching only the structured "Action Plan" (intent, entities, tool execution parameters)
 * keyed on high-threshold query embedding similarity (> 0.96).
 * 
 * CRITICAL INVARIANT:
 * Never caches final text responses or volatile live odds. On cache hit, the Action Plan
 * is retrieved in ~2ms and dynamic live data fetches/tools are executed on-the-fly.
 */

import { createVectorIndex, type VectorIndex } from './vectorIndex.ts';

export interface ActionExecutionStep {
    tool: string;
    parameters: Record<string, any>;
    dynamicFetchRequired?: boolean;
    description?: string;
}

export interface ActionPlan {
    id: string;
    intent: string;                                 // e.g. "market_odds_calculation", "odds_conversion"
    entities: Record<string, any>;                  // extracted query entities (teams, fixture, market, format)
    toolExecutionSteps: ActionExecutionStep[];      // concrete deterministic tool calls
    targetAppId?: string;
    createdAt: number;
    expiresAt: number;
    hits: number;
    lastAccessedAt: number;
    metadata?: Record<string, any>;
}

export interface ActionPlanInput {
    intent: string;
    entities: Record<string, any>;
    toolExecutionSteps: ActionExecutionStep[];
    targetAppId?: string;
    metadata?: Record<string, any>;
}

export interface ActionPlanCacheConfig {
    similarityThreshold?: number; // default: 0.96
    maxEntries?: number;          // default: 500
    defaultTtlMs?: number;        // default: 30 minutes (1,800,000 ms)
}

export interface ActionPlanCacheLookupResult {
    hit: boolean;
    actionPlan?: ActionPlan;
    similarity?: number;
    latencyMs: number;
}

export interface ActionPlanCacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRatio: number;
    estimatedLatencySavedMs: number;
    dynamicFetchesExecuted: number;
}

export class ActionPlanCacheInterceptor {
    private threshold: number;
    private maxEntries: number;
    private defaultTtlMs: number;
    private entries: Map<string, ActionPlan> = new Map();
    private vectorIndex: VectorIndex<ActionPlan>;
    private hitsCount: number = 0;
    private missesCount: number = 0;
    private evictionsCount: number = 0;
    private totalLatencySavedMs: number = 0;
    private dynamicFetchesCount: number = 0;

    constructor(config?: ActionPlanCacheConfig) {
        this.threshold = config?.similarityThreshold ?? 0.96;
        this.maxEntries = config?.maxEntries ?? 500;
        this.defaultTtlMs = config?.defaultTtlMs ?? 30 * 60 * 1000;
        this.vectorIndex = createVectorIndex<ActionPlan>('vptree', { metric: 'cosine' });
    }

    /**
     * Look up an Action Plan matching the query embedding vector within the high similarity threshold (> 0.96).
     */
    lookup(queryVector: number[], targetAppId?: string): ActionPlanCacheLookupResult {
        const start = performance.now();
        if (!queryVector || queryVector.length === 0 || this.entries.size === 0) {
            this.missesCount++;
            return { hit: false, latencyMs: Number((performance.now() - start).toFixed(2)) };
        }

        const now = Date.now();
        const hits = this.vectorIndex.search(queryVector, {
            k: 3,
            minSimilarity: this.threshold,
            filter: (item) => !targetAppId || item.data.targetAppId === targetAppId || !item.data.targetAppId
        });

        if (hits.length > 0) {
            const best = hits[0];
            const plan = best.data;

            if (now > plan.expiresAt) {
                // Expired
                this.entries.delete(plan.id);
                this.vectorIndex.delete(plan.id);
                this.missesCount++;
                return { hit: false, latencyMs: Number((performance.now() - start).toFixed(2)) };
            }

            // Cache hit: update LRU position
            plan.hits++;
            plan.lastAccessedAt = now;
            this.entries.delete(plan.id);
            this.entries.set(plan.id, plan);

            this.hitsCount++;
            this.totalLatencySavedMs += 43; // 45ms Qdrant search bypassed - 2ms cache retrieval = 43ms net saved

            return {
                hit: true,
                actionPlan: plan,
                similarity: best.similarity,
                latencyMs: Number((performance.now() - start).toFixed(2))
            };
        }

        this.missesCount++;
        return { hit: false, latencyMs: Number((performance.now() - start).toFixed(2)) };
    }

    /**
     * Stores an Action Plan in the semantic cache keyed by the query embedding vector.
     * Enforces the zero-stale-odds invariant by stripping volatile odds or raw responses.
     */
    set(queryVector: number[], planInput: ActionPlanInput, ttlMs?: number): ActionPlan {
        if (!queryVector || queryVector.length === 0) {
            throw new Error('Query vector must be non-empty to cache action plan');
        }

        const now = Date.now();
        const duration = ttlMs ?? this.defaultTtlMs;
        const id = `plan-${Math.random().toString(36).substring(2, 10)}-${now}`;

        // Evict LRU (oldest accessed entry) if at capacity
        if (this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey) {
                this.entries.delete(oldestKey);
                this.vectorIndex.delete(oldestKey);
                this.evictionsCount++;
            }
        }

        // Sanitize entities and steps: NEVER store volatile live odds responses or raw analysis text
        const sanitizedEntities: Record<string, any> = {};
        for (const [key, value] of Object.entries(planInput.entities || {})) {
            if (['liveOdds', 'staleOdds', 'rawOdds', 'finalAnalysis', 'rawResponse', 'ui_title'].includes(key)) {
                continue;
            }
            sanitizedEntities[key] = value;
        }

        const sanitizedSteps: ActionExecutionStep[] = (planInput.toolExecutionSteps || []).map(step => ({
            tool: step.tool,
            parameters: { ...(step.parameters || {}) },
            dynamicFetchRequired: step.dynamicFetchRequired ?? true,
            description: step.description
        }));

        const plan: ActionPlan = {
            id,
            intent: planInput.intent,
            entities: sanitizedEntities,
            toolExecutionSteps: sanitizedSteps,
            targetAppId: planInput.targetAppId,
            createdAt: now,
            expiresAt: now + duration,
            hits: 0,
            lastAccessedAt: now,
            metadata: planInput.metadata
        };

        this.entries.set(id, plan);
        this.vectorIndex.insert(id, queryVector, plan);

        return plan;
    }

    /**
     * Executes the cached action plan dynamically using the provided live tool executor.
     * Guarantees fresh live data execution without serving stale odds.
     */
    async executeLivePlan<TResult = any>(
        plan: ActionPlan,
        executor: (toolName: string, parameters: Record<string, any>) => Promise<TResult>
    ): Promise<Array<{ tool: string; result: any }>> {
        const results: Array<{ tool: string; result: any }> = [];
        for (const step of plan.toolExecutionSteps) {
            const execRes = await executor(step.tool, step.parameters);
            const unwrapped = (execRes && typeof execRes === 'object' && 'result' in execRes && 'success' in execRes)
                ? (execRes as any).result
                : execRes;
            results.push({ tool: step.tool, result: unwrapped });
            this.dynamicFetchesCount++;
        }
        return results;
    }

    /**
     * Clears all cache entries and resets metrics.
     */
    clear(): void {
        this.entries.clear();
        this.vectorIndex.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
        this.evictionsCount = 0;
        this.totalLatencySavedMs = 0;
        this.dynamicFetchesCount = 0;
    }

    /**
     * Retrieves current cache hit/miss and latency statistics.
     */
    getStats(): ActionPlanCacheStats {
        const total = this.hitsCount + this.missesCount;
        return {
            size: this.entries.size,
            maxEntries: this.maxEntries,
            hits: this.hitsCount,
            misses: this.missesCount,
            evictions: this.evictionsCount,
            hitRatio: total === 0 ? 0 : Number((this.hitsCount / total).toFixed(4)),
            estimatedLatencySavedMs: this.totalLatencySavedMs,
            dynamicFetchesExecuted: this.dynamicFetchesCount
        };
    }
}

/**
 * Singleton ActionPlanCacheInterceptor instance for the swarm runtime.
 */
export const globalActionPlanCache = new ActionPlanCacheInterceptor();
