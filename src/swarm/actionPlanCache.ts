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

import { SemanticVectorCache, type BaseCacheEntry, type SemanticVectorCacheConfig } from './cache/semanticVectorCache.ts';

export interface ActionExecutionStep {
    tool: string;
    parameters: Record<string, any>;
    dynamicFetchRequired?: boolean;
    description?: string;
}

export interface ActionPlan extends BaseCacheEntry {
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

export type ActionPlanCacheConfig = SemanticVectorCacheConfig;

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

export class ActionPlanCacheInterceptor extends SemanticVectorCache<ActionPlan> {
    private dynamicFetchesCount: number = 0;

    constructor(config?: ActionPlanCacheConfig) {
        super({
            similarityThreshold: config?.similarityThreshold ?? 0.96,
            maxEntries: config?.maxEntries ?? 500,
            defaultTtlMs: config?.defaultTtlMs ?? 30 * 60 * 1000,
            estimatedLatencySavingsMs: 43
        });
    }

    /**
     * Look up an Action Plan matching the query embedding vector within the high similarity threshold (> 0.96).
     */
    lookup(queryVector: number[], targetAppId?: string): ActionPlanCacheLookupResult {
        const start = performance.now();
        if (!queryVector || queryVector.length === 0 || this.entries.size === 0) {
            this.recordMiss();
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
                this.recordMiss();
                return { hit: false, latencyMs: Number((performance.now() - start).toFixed(2)) };
            }

            // Cache hit: update LRU position and latency
            this.recordHit(plan);

            return {
                hit: true,
                actionPlan: plan,
                similarity: best.similarity,
                latencyMs: Number((performance.now() - start).toFixed(2))
            };
        }

        this.recordMiss();
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
        const id = `plan-${crypto.randomUUID()}-${now}`;

        // Ensure LRU capacity bounds
        this.evictLruIfNeeded();

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
        const results = await Promise.all(
            plan.toolExecutionSteps.map(async (step) => {
                const execRes = await executor(step.tool, step.parameters);
                const unwrapped = (execRes && typeof execRes === 'object' && 'result' in execRes && 'success' in execRes)
                    ? (execRes as any).result
                    : execRes;
                this.dynamicFetchesCount++;
                return { tool: step.tool, result: unwrapped };
            })
        );
        return results;
    }

    /**
     * Clears all cache entries and resets metrics.
     */
    clear(): void {
        super.clear();
        this.dynamicFetchesCount = 0;
    }

    /**
     * Retrieves current cache hit/miss and latency statistics.
     */
    getStats(): ActionPlanCacheStats {
        const base = super.getStats();
        return {
            ...base,
            dynamicFetchesExecuted: this.dynamicFetchesCount
        };
    }
}

/**
 * Singleton ActionPlanCacheInterceptor instance for the swarm runtime.
 */
export const globalActionPlanCache = new ActionPlanCacheInterceptor();
