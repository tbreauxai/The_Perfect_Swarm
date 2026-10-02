import { globalDomainSubComputationCache } from '../optimization.ts';
import { globalTieredCache, type TieredLookupResult } from '../tieredCache.ts';
import { globalSemanticCache, globalPayloadCache, type SemanticMatchResult } from '../cache.ts';
import { SwarmContext } from '../context.ts';
import type { SwarmWorkflowResult, SwarmWorkflowParams, SwarmFeedbackReport } from './types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import { globalMetricsCollector, globalUnifiedProfiler } from '../profiler.ts';
import { globalFeedbackEngine } from '../feedback.ts';
import { globalKnowledgeGraph } from '../knowledgeGraph.ts';
import { globalHypothesisLayer, globalLearningRateManager } from '../coordination.ts';

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

export interface EarlyCacheResolutionParams {
    task: string;
    data?: string;
    cacheKey: string;
    cacheQuery: string;
    agentConfigVersion: string;
    tieredCacheEnabled: boolean;
    forceFullSwarm: boolean;
    bypassCache: boolean;
    workflowStartTime: number;
    targetAppId: string;
    settings?: SwarmEngineSettings;
    context: SwarmContext;
    params: SwarmWorkflowParams;
}

export async function resolveEarlyCacheHit(p: EarlyCacheResolutionParams): Promise<SwarmWorkflowResult | null> {
    const {
        task,
        data,
        cacheKey,
        cacheQuery,
        agentConfigVersion,
        tieredCacheEnabled,
        forceFullSwarm,
        bypassCache,
        workflowStartTime,
        targetAppId,
        settings,
        context,
        params
    } = p;

    // 0b. Tiered Cache
    if (tieredCacheEnabled && !forceFullSwarm && !bypassCache) {
        const lookup = checkTieredCacheLookup({
            query: cacheQuery,
            task,
            similarityThreshold: settings?.tieredCacheSettings?.l2SimilarityThreshold,
            context
        });
        if (lookup.found && lookup.value) {
            params.onStage?.({ stage: 'completed', task });
            const workflowDurationMs = Date.now() - workflowStartTime;
            globalMetricsCollector.recordTaskExecution({
                success: true,
                durationMs: workflowDurationMs,
                agentRole: 'Tiered Cache Engine'
            });
            const metrics = globalMetricsCollector.getBaselineReport();

            const profilingEnabled = settings?.profilingSettings?.enabled !== false;
            if (profilingEnabled) {
                globalUnifiedProfiler.recordWorkflowRun({
                    durationMs: workflowDurationMs,
                    cache: {
                        l1Hits: lookup.tier === 'L1' ? 1 : 0,
                        l2Hits: lookup.tier === 'L2' ? 1 : 0,
                        l3Hits: lookup.tier === 'L3' ? 1 : 0,
                        savedTokens: 250
                    }
                });
            }

            const feedbackEnabled = settings?.feedbackSettings?.enabled !== false;
            let cacheHitFeedbackReport: SwarmFeedbackReport | undefined;
            if (feedbackEnabled) {
                try {
                    const fbResult = await globalFeedbackEngine.processFeedback({
                        workflowId: (context as any).id || `wf-${Date.now()}`,
                        task,
                        appId: targetAppId,
                        agentRoles: (settings?.agents || []).map((a: any) => a.role).filter(Boolean),
                        durationMs: workflowDurationMs,
                        targetTier: 'instant',
                        tokenSavings: 250,
                        tokensConsumed: 0,
                        qualityScore: 0.95,
                        accuracyScore: 0.99,
                        errorCount: 0,
                        finalInsightSnippet: typeof lookup.value === 'string' ? lookup.value.slice(0, 150) : (lookup.value?.ui_title || 'Tiered Cache Hit'),
                        inputData: data
                    });
                    cacheHitFeedbackReport = {
                        reward: fbResult.reward,
                        tunedParameters: fbResult.tunedParameters,
                        driftAlerts: fbResult.driftAlerts,
                        outcomeId: fbResult.outcomeId,
                        policyUpdated: fbResult.policyUpdated
                    };
                } catch (fbErr: any) {
                    console.warn('[TieredCache] Feedback processing failed:', fbErr);
                }
            }

            return {
                workflowId: (context as any).id,
                events: context.events,
                finalAnalysis: lookup.value,
                metrics,
                tieredCache: {
                    hit: true,
                    tier: lookup.tier,
                    similarity: lookup.similarity,
                    latencyMs: lookup.latencyMs,
                    metrics: globalTieredCache.getMetrics()
                },
                unifiedBaselines: profilingEnabled ? globalUnifiedProfiler.getUnifiedBaselineReport() : undefined,
                feedback: cacheHitFeedbackReport,
                coordination: {
                    knowledgeGraphVersion: globalKnowledgeGraph.getVersion(),
                    totalNodes: globalKnowledgeGraph.getStats().totalNodes,
                    totalEdges: globalKnowledgeGraph.getStats().totalEdges,
                    hypothesesCount: globalHypothesisLayer.getHypotheses().length,
                    validatedHypothesesCount: globalHypothesisLayer.getHypotheses('validated').length,
                    agentLearningRates: Object.fromEntries(
                        globalLearningRateManager.getAllStates().map(s => [s.agentId, s.learningRate])
                    )
                }
            };
        }
    }

    // 0b. Payload Cache
    const cachedAnalysis = (forceFullSwarm || tieredCacheEnabled || bypassCache) ? null : globalPayloadCache.get(cacheKey);
    if (cachedAnalysis) {
        context.addEvent({
            agentRole: 'Payload Cache',
            action: 'Cache Hit (Zero-Drift Execution)',
            modelName: 'Local/LRU-Cache',
            prompt: `Deterministic cache hit for fingerprint: ${cacheKey.substring(0, 16)}...`,
            output: {
                fingerprint: cacheKey,
                cached: true,
                bypassed: '100% LLM token consumption & provider API calls'
            },
            durationMs: 0
        });

        const workflowDurationMs = Date.now() - workflowStartTime;
        globalMetricsCollector.recordTaskExecution({
            success: true,
            durationMs: workflowDurationMs,
            agentRole: 'Payload Cache'
        });
        const metrics = globalMetricsCollector.getBaselineReport();

        const profilingEnabled = settings?.profilingSettings?.enabled !== false;
        if (profilingEnabled) {
            globalUnifiedProfiler.recordWorkflowRun({
                durationMs: workflowDurationMs,
                cache: { l1Hits: 1, savedTokens: 250 }
            });
        }

        const feedbackEnabled = settings?.feedbackSettings?.enabled !== false;
        let payloadCacheFeedbackReport: SwarmFeedbackReport | undefined;
        if (feedbackEnabled) {
            try {
                const fbResult = await globalFeedbackEngine.processFeedback({
                    workflowId: (context as any).id || `wf-${Date.now()}`,
                    task,
                    appId: targetAppId,
                    agentRoles: (settings?.agents || []).map((a: any) => a.role).filter(Boolean),
                    durationMs: workflowDurationMs,
                    targetTier: 'instant',
                    tokenSavings: 250,
                    tokensConsumed: 0,
                    qualityScore: 0.95,
                    accuracyScore: 0.99,
                    errorCount: 0,
                    finalInsightSnippet: typeof cachedAnalysis === 'string' ? cachedAnalysis.slice(0, 150) : (cachedAnalysis?.ui_title || 'Payload Cache Hit'),
                    inputData: data
                });
                payloadCacheFeedbackReport = {
                    reward: fbResult.reward,
                    tunedParameters: fbResult.tunedParameters,
                    driftAlerts: fbResult.driftAlerts,
                    outcomeId: fbResult.outcomeId,
                    policyUpdated: fbResult.policyUpdated
                };
            } catch (fbErr: any) {
                console.warn('[PayloadCache] Feedback processing failed:', fbErr);
            }
        }

        return {
            workflowId: (context as any).id,
            events: context.events,
            finalAnalysis: cachedAnalysis,
            metrics,
            unifiedBaselines: profilingEnabled ? globalUnifiedProfiler.getUnifiedBaselineReport() : undefined,
            feedback: payloadCacheFeedbackReport,
            coordination: {
                knowledgeGraphVersion: globalKnowledgeGraph.getVersion(),
                totalNodes: globalKnowledgeGraph.getStats().totalNodes,
                totalEdges: globalKnowledgeGraph.getStats().totalEdges,
                hypothesesCount: globalHypothesisLayer.getHypotheses().length,
                validatedHypothesesCount: globalHypothesisLayer.getHypotheses('validated').length,
                agentLearningRates: Object.fromEntries(
                    globalLearningRateManager.getAllStates().map(s => [s.agentId, s.learningRate])
                )
            }
        };
    }

    // 0c. Semantic Match Cache
    const semanticMatch: SemanticMatchResult = (forceFullSwarm || tieredCacheEnabled || bypassCache)
        ? { hit: false, similarity: 0 }
        : checkSemanticCacheMatch({ task, data, configVersion: agentConfigVersion });

    if (semanticMatch.hit && semanticMatch.entry) {
        context.addEvent({
            agentRole: 'Semantic Baseline Cache',
            action: 'Cache Hit (Semantic Zero-Drift Baseline)',
            modelName: 'Local/SemanticCache',
            prompt: `Semantic baseline cache hit: ${semanticMatch.reason || `similarity ${semanticMatch.similarity}`}`,
            output: {
                matchedTask: semanticMatch.matchedTask,
                similarity: semanticMatch.similarity,
                cached: true,
                bypassed: '100% LLM token consumption & provider API calls'
            },
            durationMs: 0
        });

        const workflowDurationMs = Date.now() - workflowStartTime;
        globalMetricsCollector.recordTaskExecution({
            success: true,
            durationMs: workflowDurationMs,
            agentRole: 'Semantic Baseline Cache'
        });
        const metrics = globalMetricsCollector.getBaselineReport();

        const profilingEnabled = settings?.profilingSettings?.enabled !== false;
        if (profilingEnabled) {
            globalUnifiedProfiler.recordWorkflowRun({
                durationMs: workflowDurationMs,
                cache: { l2Hits: 1, savedTokens: 250 }
            });
        }

        const feedbackEnabled = settings?.feedbackSettings?.enabled !== false;
        let semanticCacheFeedbackReport: SwarmFeedbackReport | undefined;
        if (feedbackEnabled) {
            try {
                const fbResult = await globalFeedbackEngine.processFeedback({
                    workflowId: (context as any).id || `wf-${Date.now()}`,
                    task,
                    appId: targetAppId,
                    agentRoles: (settings?.agents || []).map((a: any) => a.role).filter(Boolean),
                    durationMs: workflowDurationMs,
                    targetTier: 'instant',
                    tokenSavings: 250,
                    tokensConsumed: 0,
                    qualityScore: 0.95,
                    accuracyScore: 0.98,
                    errorCount: 0,
                    finalInsightSnippet: typeof semanticMatch.entry.payload === 'string' ? semanticMatch.entry.payload.slice(0, 150) : (semanticMatch.entry.payload?.ui_title || 'Semantic Cache Hit'),
                    inputData: data
                });
                semanticCacheFeedbackReport = {
                    reward: fbResult.reward,
                    tunedParameters: fbResult.tunedParameters,
                    driftAlerts: fbResult.driftAlerts,
                    outcomeId: fbResult.outcomeId,
                    policyUpdated: fbResult.policyUpdated
                };
            } catch (fbErr: any) {
                console.warn('[SemanticCache] Feedback processing failed:', fbErr);
            }
        }

        return {
            workflowId: (context as any).id,
            events: context.events,
            finalAnalysis: semanticMatch.entry.payload,
            metrics,
            unifiedBaselines: profilingEnabled ? globalUnifiedProfiler.getUnifiedBaselineReport() : undefined,
            feedback: semanticCacheFeedbackReport,
            coordination: globalKnowledgeGraph.getVersion() > 0 ? {
                knowledgeGraphVersion: globalKnowledgeGraph.getVersion(),
                totalNodes: globalKnowledgeGraph.getStats().totalNodes,
                totalEdges: globalKnowledgeGraph.getStats().totalEdges,
                hypothesesCount: globalHypothesisLayer.getHypotheses().length,
                validatedHypothesesCount: globalHypothesisLayer.getHypotheses('validated').length,
                agentLearningRates: Object.fromEntries(
                    globalLearningRateManager.getAllStates().map(s => [s.agentId, s.learningRate])
                )
            } : undefined
        };
    }

    return null;
}
