import { globalDomainSubComputationCache } from '../optimization.ts';
import { globalTieredCache, type TieredLookupResult } from '../tieredCache.ts';
import { globalSemanticCache, type SemanticMatchResult } from '../cache.ts';
import { SwarmContext } from '../context.ts';
import type { SwarmWorkflowResult } from './types.ts';

export interface SubComputationCheckParams {
    task: string;
    context: SwarmContext;
    onPartialResult?: (result: any) => void;
    onStage?: (stage: any) => void;
    getMetrics: () => any;
}

export function checkSubComputationCache(params: SubComputationCheckParams): SwarmWorkflowResult | null {
    const { task, context, onPartialResult, onStage, getMetrics } = params;
    const cachedSub = globalDomainSubComputationCache.get('market_odds', task) ||
                      globalDomainSubComputationCache.get('team_form', task) ||
                      globalDomainSubComputationCache.get('custom', task);

    if (!cachedSub) return null;

    context.addEvent({
        agentRole: 'Domain Sub-Computation Cache',
        action: 'Cache Hit (Sub-Computation Bypassed)',
        modelName: 'Local/DomainSubComputationCache',
        prompt: `Sub-computation cache hit for '${task.slice(0, 80)}'`,
        output: cachedSub,
        durationMs: 0
    });

    onPartialResult?.(cachedSub);
    onStage?.({
        stage: 'completed',
        task
    });

    return {
        events: context.events,
        finalAnalysis: cachedSub,
        metrics: getMetrics(),
        optimization: {
            earlyExit: true,
            tier: 'tier1_approx',
            latencySavedMs: 75000,
            partialResultEmitted: true,
            subcomputationsCached: globalDomainSubComputationCache.getMetrics().subcomputationsSaved,
            tokensSaved: 500
        }
    };
}

export interface TieredCacheCheckParams {
    query: string;
    task: string;
    similarityThreshold?: number;
    context: SwarmContext;
}

export function checkTieredCacheLookup(params: TieredCacheCheckParams): TieredLookupResult {
    const { query, task, similarityThreshold, context } = params;
    const lookup = globalTieredCache.lookup(query, { similarityThreshold });
    if (lookup.found && lookup.value) {
        context.addEvent({
            agentRole: 'Tiered Cache Engine',
            action: `Tiered Cache Hit (${lookup.tier})`,
            modelName: 'Local/TieredCache',
            prompt: `Cache hit on tier '${lookup.tier}' for query: "${task.slice(0, 80)}" (Similarity: ${Math.round((lookup.similarity ?? 1.0) * 100)}%, Latency: ${lookup.latencyMs}ms)`,
            output: {
                tier: lookup.tier,
                similarity: lookup.similarity,
                key: lookup.key,
                latencyMs: lookup.latencyMs,
                cacheMetrics: globalTieredCache.getMetrics()
            },
            durationMs: lookup.latencyMs
        });
    }
    return lookup;
}

export interface SemanticCacheCheckParams {
    task: string;
    data?: string;
    configVersion?: string;
}

export function checkSemanticCacheMatch(params: SemanticCacheCheckParams): SemanticMatchResult {
    const { task, data, configVersion } = params;
    return globalSemanticCache.findMatch(task, {
        data,
        threshold: 0.80,
        configVersion
    });
}
