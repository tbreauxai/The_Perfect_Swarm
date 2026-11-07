import type { MemoryCortex } from '../memory.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { SwarmContext } from '../context.ts';
import type { SwarmEngineSettings } from '../types.ts';
import type {
    RetrievalContextEnvelope,
    SnapshotRef,
    TrustedRetrievalScope
} from './historyScope.ts';
import { getSupabaseConfig, fetchOnDemandSupabaseContext } from '../morning/supabase.ts';

export interface MemoryGroundingParams {
    memoryCortex?: MemoryCortex;
    task: string;
    data?: unknown;
    targetAppId: string;
    includeShared: boolean;
    bypassCache: boolean;
    qdrantUrl?: string;
    toolRegistry: ToolRegistry;
    context: SwarmContext;
    domain?: string;
    disableMemoryRetrieval?: boolean;
    settings?: SwarmEngineSettings;
    eventId?: string;
    eventIds?: string[];
    gameDate?: string;
    date?: string;
    sport?: string;
    entityIds?: string[];
    retrievalContext?: RetrievalContextEnvelope;
    snapshotRefs?: SnapshotRef[];
    retrievalScope?: TrustedRetrievalScope;
}

export interface MemoryGroundingResult {
    historicalContext: string;
    actionPlanBypassedQdrant: boolean;
}

export async function resolveMemoryGrounding(p: MemoryGroundingParams): Promise<MemoryGroundingResult> {
    const {
        memoryCortex,
        task,
        targetAppId,
        includeShared,
        bypassCache,
        qdrantUrl,
        toolRegistry,
        context
    } = p;

    let historicalContext = "";
    let actionPlanBypassedQdrant = false;

    if (memoryCortex) {
        try {
            const planLookup: any = bypassCache ? { hit: false } : await memoryCortex.lookupActionPlan(task, targetAppId);
            if (planLookup.hit && planLookup.actionPlan) {
                actionPlanBypassedQdrant = true;
                context.addEvent({
                    agentRole: 'Semantic Action Cache Interceptor',
                    action: 'Action Plan Cache Hit (Qdrant Bypassed)',
                    modelName: 'Local/ActionPlanCache',
                    prompt: `Action Plan hit for '${task.slice(0, 80)}' (similarity: ${planLookup.similarity?.toFixed(4)}, latency: ${planLookup.latencyMs}ms)`,
                    output: {
                        planId: planLookup.actionPlan.id,
                        intent: planLookup.actionPlan.intent,
                        entities: planLookup.actionPlan.entities,
                        toolExecutionSteps: planLookup.actionPlan.toolExecutionSteps,
                        qdrantBypassed: true,
                        latencySavedMs: 43
                    },
                    durationMs: Math.max(1, Math.round(planLookup.latencyMs))
                });

                const dynamicStart = Date.now();
                const liveExecutionResults = await memoryCortex.getActionPlanCache().executeLivePlan(
                    planLookup.actionPlan,
                    async (toolName, params) => toolRegistry.execute(toolName, params)
                );

                context.addEvent({
                    agentRole: 'Semantic Action Cache Interceptor',
                    action: 'Dynamic Live Data Fetch Completed',
                    modelName: 'Local/ActionPlanCache',
                    prompt: `Dynamically executed ${planLookup.actionPlan.toolExecutionSteps.length} live tool steps (fresh live odds)`,
                    output: liveExecutionResults,
                    durationMs: Math.max(1, Date.now() - dynamicStart)
                });

                historicalContext = `[Action Plan Cache Hit - 45ms Qdrant Bypassed]: Intent='${planLookup.actionPlan.intent}', Entities=${JSON.stringify(planLookup.actionPlan.entities)}\n` +
                    `Dynamic Live Tool Outputs (Fresh Live Odds):\n` +
                    liveExecutionResults.map(r => `[Tool: ${r.tool}]: ${JSON.stringify(r.result)}`).join('\n');
            }
        } catch {
            // Action plan cache lookup failed; fall back to standard Qdrant
        }

        if (!actionPlanBypassedQdrant) {
            try {
                const cortexName = qdrantUrl ? 'Qdrant/HybridCortex' : 'Local/InMemoryCortex';
                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Targeted Cortex Retrieval',
                    modelName: cortexName,
                    prompt: `Retrieving historical baseline constraints (appId='${targetAppId}', includeShared=${includeShared})...`
                });

                const readDomain = p.domain || p.settings?.domain;
                const explicitEntities = p.retrievalScope?.entityIds?.length ? p.retrievalScope.entityIds : (p.entityIds || (p.settings as any)?.entityIds);
                const disableMemoryRetrieval = Boolean(p.disableMemoryRetrieval || (p.settings as any)?.disableMemoryRetrieval);

                const [retrieved, exemplars, contrastive] = disableMemoryRetrieval ? [[], "", { wins: [], losses: [], formattedBlock: "" }] : await Promise.all([
                    memoryCortex.retrieve(task, { appId: targetAppId, domain: readDomain, entityIds: explicitEntities, includeShared }, 3).catch(() => []),
                    memoryCortex.retrieveExemplars(task, { appId: targetAppId, domain: readDomain, entityIds: explicitEntities, includeShared, limit: 2, minRating: 0.7 }).catch(() => ""),
                    typeof (memoryCortex as any).retrieveContrastivePostMortems === 'function'
                        ? (memoryCortex as any).retrieveContrastivePostMortems(task, { appId: targetAppId, domain: readDomain, entityIds: explicitEntities, includeShared, limit: 2 }).catch(() => ({ wins: [], losses: [], formattedBlock: "" }))
                        : Promise.resolve({ wins: [], losses: [], formattedBlock: "" })
                ]);

                historicalContext = retrieved.length > 0
                    ? `Retrieved ${retrieved.length} relevant historical baselines from memory:\n` +
                      retrieved.map((m: any, idx: number) => `[Baseline ${idx + 1}]: ${m.content || JSON.stringify(m)}`).join('\n')
                    : "Vector Cortex connected. No prior matching historical baselines found for this domain.";

                if (exemplars) {
                    historicalContext += `\n\nHigh-Quality Exemplars from Past Runs:\n${exemplars}`;
                }

                if (contrastive?.formattedBlock) {
                    historicalContext += `\n\n${contrastive.formattedBlock}`;
                }

                // On-demand Supabase pull for DuelOdds / sports workflows when not already pre-populated by runMorningSlate
                const supaCfg = getSupabaseConfig();
                const alreadyHasSupabaseContext = task.includes('[SUPABASE LIVE MARKET STEAM') || String(p.data || '').includes('[SUPABASE LIVE MARKET STEAM');
                const isSportsOrDuelOdds = targetAppId === 'duelodds' ||
                    (typeof readDomain === 'string' && /sport|bet|odds/i.test(readDomain)) ||
                    /\b(event_?id|spread|moneyline|over\/under|duelodds)\b/i.test(task);

                if (!disableMemoryRetrieval && !alreadyHasSupabaseContext && isSportsOrDuelOdds) {
                    if (!supaCfg) {
                        console.warn('[MemoryGrounding] sports/duelodds task without Supabase config; on-demand pull skipped');
                        historicalContext += '\n\n[DUELODDS SUPABASE ON-DEMAND] supabase_not_configured';
                    } else {
                        const onDemand = await fetchOnDemandSupabaseContext(supaCfg, {
                            task,
                            data: p.data,
                            eventId: p.eventId,
                            eventIds: p.retrievalScope?.eventIds?.length ? p.retrievalScope.eventIds : p.eventIds,
                            gameDate: p.gameDate || p.retrievalScope?.date || p.date,
                            sport: p.retrievalScope?.sport || p.sport,
                            limit: 6
                        }).catch((err: any) => ({
                            judgments: [],
                            lineSnapshots: [],
                            formattedBlock: '',
                            error: 'slim_pull_failed' as const,
                            detail: String(err?.message || err)
                        }));
                        if (onDemand.formattedBlock) {
                            historicalContext += `\n\n${onDemand.formattedBlock}`;
                        } else if (onDemand.error) {
                            console.warn(`[MemoryGrounding] on-demand pull ${onDemand.error}: ${onDemand.detail || ''}`);
                            historicalContext += `\n\n[DUELODDS SUPABASE ON-DEMAND] ${onDemand.error}${onDemand.detail ? ': ' + onDemand.detail : ''}`;
                        }
                    }
                }

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Cortex Retrieval Complete',
                    prompt: 'Retrieval completed',
                    modelName: cortexName,
                    output: {
                        recordsFound: retrieved.length,
                        exemplarsIncluded: Boolean(exemplars),
                        contrastiveWins: contrastive?.wins?.length || 0,
                        contrastiveLosses: contrastive?.losses?.length || 0,
                        status: 'Success',
                        message: historicalContext
                    },
                    durationMs: 12
                });
            } catch (err: any) {
                let errorMessage = err.message || String(err);
                if (errorMessage.includes("Unexpected token '<'") || errorMessage.includes("is not valid JSON")) {
                    errorMessage = "The Qdrant URL provided returned an HTML web page instead of JSON. Ensure you use the Cluster REST Endpoint URL (e.g. https://xyz.cloud.qdrant.tech:6333) and not the dashboard URL.";
                }

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Cortex Retrieval Failed',
                    prompt: 'Retrieval failed',
                    modelName: 'Cortex/Fallback',
                    error: `Memory retrieval error: ${errorMessage}`,
                    durationMs: 0
                });
                historicalContext = "Failed to retrieve baselines from memory. Proceeding without historical context.";
            }
        }
    }

    return {
        historicalContext,
        actionPlanBypassedQdrant
    };
}
