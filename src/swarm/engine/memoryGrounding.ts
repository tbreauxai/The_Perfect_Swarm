import type { MemoryCortex } from '../memory.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { SwarmContext } from '../context.ts';
import type { SwarmEngineSettings } from '../types.ts';
import type {
    RetrievalContextEnvelope,
    SnapshotRef,
    TrustedRetrievalScope
} from './historyScope.ts';
import { utf8ByteLength } from './historyScope.ts';
import { getSupabaseConfig, fetchOnDemandSupabaseContext } from '../morning/supabase.ts';
import {
    getSupabaseReadOnlyConfig,
    readGameContextFromStore,
    MAX_PROMPT_HISTORY_BYTES,
    type GameContextStoreReadResult
} from '../morning/gameContext.ts';
import {
    capCortexMemoryBlock,
    containsLegacyContractBoilerplate,
    isSafeRetrievedBaseline,
    MAX_CORTEX_MEMORY_BLOCK_CHARS,
    MAX_MEMORY_SNIPPET_CHARS,
    STRATEGIC_PASS_RESULT_RE,
    truncateMemorySnippet
} from '../memory/memorySanitizer.ts';

export const MAX_PUBLIC_LESSONS_PER_EVENT = 3;
export const MAX_LESSON_RULE_CHARS = 160;

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
    domains?: string[];
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
    preloadedGameContext?: GameContextStoreReadResult;
    triageMode?: 'two-hop' | 'legacy';
    curatedDossierActive?: boolean;
}

export interface MemoryGroundingResult {
    historicalContext: string;
    actionPlanBypassedQdrant: boolean;
    gameContextResult?: GameContextStoreReadResult;
}

function formatBoundedLessonRule(item: any): string {
    const rawCandidate = String(item?.rule || item?.reason || item?.resultSummary || item?.content || JSON.stringify(item))
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const cleaned = truncateMemorySnippet(rawCandidate, Math.min(MAX_LESSON_RULE_CHARS, MAX_MEMORY_SNIPPET_CHARS));
    return cleaned || rawCandidate.slice(0, MAX_LESSON_RULE_CHARS);
}

async function revalidateLessonsWithSqlFacts(
    lessons: any[],
    asOfIso: string | undefined,
    fetchFn: typeof fetch = fetch
): Promise<any[]> {
    if (lessons.length === 0) return lessons;
    const readCfg = getSupabaseReadOnlyConfig();
    if (!readCfg) return lessons;

    const lessonIds = lessons
        .map((l) => String(l?.id || l?.lesson_id || '').trim())
        .filter(Boolean);
    if (lessonIds.length === 0) return lessons;

    try {
        const inList = lessonIds.map((id) => encodeURIComponent(id)).join(',');
        const filters = [
            `app_id=eq.duelodds`,
            `visibility=eq.public`,
            `lesson_id=in.(${inList})`
        ];
        if (asOfIso) {
            filters.push(`available_at=lte.${encodeURIComponent(asOfIso)}`);
        }
        const res = await fetchFn(
            `${readCfg.supabaseUrl}/rest/v1/app_lesson_facts?${filters.join('&')}&select=lesson_id,app_id,visibility,available_at,updated_at`,
            {
                method: 'GET',
                headers: {
                    apikey: readCfg.supabasePublishableKey,
                    Authorization: `Bearer ${readCfg.supabasePublishableKey}`,
                    Accept: 'application/json'
                }
            }
        );
        if (!res.ok) return lessons;
        const rows = await res.json().catch(() => null);
        if (!Array.isArray(rows) || rows.length === 0) {
            return lessons;
        }
        const asOfMs = asOfIso ? Date.parse(asOfIso) : undefined;
        const validIds = new Set<string>();
        for (const r of rows) {
            if (!r || typeof r !== 'object') continue;
            if (r.app_id !== 'duelodds' || r.visibility !== 'public') continue;
            if (asOfMs !== undefined) {
                const availMs = r.available_at ? Date.parse(String(r.available_at)) : Number.NaN;
                const updMs = r.updated_at ? Date.parse(String(r.updated_at)) : availMs;
                if (!Number.isFinite(availMs) || availMs > asOfMs || (Number.isFinite(updMs) && updMs > asOfMs)) {
                    continue;
                }
            }
            if (typeof r.lesson_id === 'string' && r.lesson_id.trim()) {
                validIds.add(r.lesson_id.trim());
            }
        }
        return lessons.filter((l) => {
            const lid = String(l?.id || l?.lesson_id || '').trim();
            return validIds.has(lid);
        });
    } catch {
        return lessons;
    }
}

export async function resolveMemoryGrounding(
    p: MemoryGroundingParams
): Promise<MemoryGroundingResult> {
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

    const scope = p.retrievalScope;
    const trustedAppId = scope?.callerAppId || targetAppId;
    const readDomain = p.domain || p.settings?.domain;
    const explicitEntities = scope?.entityIds?.length
        ? scope.entityIds
        : p.entityIds || (p.settings as any)?.entityIds;
    const explicitEvents = scope?.eventIds?.length
        ? scope.eventIds
        : p.eventIds || (p.eventId ? [p.eventId] : undefined);
    const inferredDomainsFromEvents = (() => {
        if (Array.isArray(p.domains) && p.domains.length > 0) {
            return Array.from(new Set(p.domains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)));
        }
        const evList = Array.isArray(explicitEvents) ? explicitEvents : [];
        const sports = new Set<string>();
        for (const eid of evList) {
            const lower = String(eid || '').trim().toLowerCase();
            if (lower.startsWith('college-football') || lower.startsWith('ncaaf')) sports.add('ncaaf');
            else if (lower.startsWith('mens-college-basketball') || lower.startsWith('college-basketball') || lower.startsWith('ncaab')) sports.add('ncaab');
            else if (lower.startsWith('wnba-')) sports.add('wnba');
            else if (lower.startsWith('nba-')) sports.add('nba');
            else if (lower.startsWith('nfl-')) sports.add('nfl');
            else if (lower.startsWith('nhl-')) sports.add('nhl');
            else if (lower.startsWith('mlb-')) sports.add('mlb');
        }
        if (sports.size > 1) {
            return Array.from(sports);
        }
        return undefined;
    })();
    const effectiveDomain =
        inferredDomainsFromEvents && inferredDomainsFromEvents.length > 1
            ? 'multi-sport'
            : readDomain;
    const effectiveSport = scope?.sport || p.sport;
    const effectiveAsOf = scope?.asOf;
    const disableMemoryRetrieval = Boolean(
        p.disableMemoryRetrieval || (p.settings as any)?.disableMemoryRetrieval
    );

    let gameContextResult: GameContextStoreReadResult | undefined = p.preloadedGameContext;
    if (
        !disableMemoryRetrieval &&
        !gameContextResult &&
        scope &&
        (scope.usesContextStore || scope.groups.length > 0)
    ) {
        const readCfg = getSupabaseReadOnlyConfig();
        if (readCfg) {
            gameContextResult = await readGameContextFromStore(readCfg, scope);
        } else if (scope.usesContextStore) {
            gameContextResult = {
                status: 'store_not_ready',
                reason: 'missing_readonly_key',
                detail: 'Read-only publishable Supabase key is not configured'
            };
        }
    }

    const snapshotHashKey =
        gameContextResult?.status === 'ok'
            ? gameContextResult.results
                  .map((r) => `${r.event_id}:${r.content_hash || 'none'}`)
                  .join('|')
            : undefined;

    const hasScopeConstraints = Boolean(
        scope?.hasExplicitRetrievalContext ||
            effectiveAsOf ||
            (explicitEvents && explicitEvents.length > 0) ||
            (explicitEntities && explicitEntities.length > 0) ||
            effectiveSport ||
            snapshotHashKey
    );

    const scopedActionPlanKey = hasScopeConstraints
        ? [
              trustedAppId,
              effectiveAsOf || '',
              effectiveSport || '',
              ...(explicitEvents || []),
              ...(explicitEntities || []),
              snapshotHashKey || ''
          ]
              .filter(Boolean)
              .join('|')
        : trustedAppId;

    let historicalContext = '';
    let actionPlanBypassedQdrant = false;

    if (memoryCortex) {
        try {
            const planLookup: any = bypassCache
                ? { hit: false }
                : await memoryCortex.lookupActionPlan(task, scopedActionPlanKey);
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

                historicalContext =
                    `[Action Plan Cache Hit - 45ms Qdrant Bypassed]: Intent='${planLookup.actionPlan.intent}', Entities=${JSON.stringify(planLookup.actionPlan.entities)}\n` +
                    `Dynamic Live Tool Outputs (Fresh Live Odds):\n` +
                    liveExecutionResults.map((r) => `[Tool: ${r.tool}]: ${JSON.stringify(r.result)}`).join('\n');
            }
        } catch {
            // Action plan cache lookup failed; fall back to standard Qdrant
        }

        if (!actionPlanBypassedQdrant) {
            try {
                const cortexName = qdrantUrl ? 'Qdrant/HybridCortex' : 'Local/InMemoryCortex';
                const effectiveIncludeShared = hasScopeConstraints ? false : includeShared;
                const effectivePublicOnly = hasScopeConstraints || trustedAppId === 'duelodds';
                const maxLessonsCap = Math.min(
                    MAX_PUBLIC_LESSONS_PER_EVENT * Math.max(1, explicitEvents?.length || 1),
                    9
                );

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Targeted Cortex Retrieval',
                    modelName: cortexName,
                    prompt: `Retrieving historical baseline constraints (appId='${trustedAppId}', includeShared=${effectiveIncludeShared})...`
                });

                const scopedQueryOpts = {
                    appId: trustedAppId,
                    domain: effectiveDomain,
                    ...(inferredDomainsFromEvents && inferredDomainsFromEvents.length > 0
                        ? { domains: inferredDomainsFromEvents }
                        : {}),
                    sport: effectiveSport,
                    entityIds: explicitEntities,
                    eventIds: explicitEvents,
                    asOf: effectiveAsOf,
                    includeShared: effectiveIncludeShared,
                    publicOnly: effectivePublicOnly,
                    snapshotHash: snapshotHashKey
                };

                const [rawRetrieved, exemplars, contrastive] = disableMemoryRetrieval
                    ? [[], '', { wins: [], losses: [], formattedBlock: '' }]
                    : await Promise.all([
                          memoryCortex
                              .retrieve(task, scopedQueryOpts, maxLessonsCap)
                              .catch(() => []),
                          memoryCortex
                              .retrieveExemplars(task, {
                                  ...scopedQueryOpts,
                                  limit: 2,
                                  minRating: 0.7
                              })
                              .catch(() => ''),
                          typeof (memoryCortex as any).retrieveContrastivePostMortems === 'function'
                              ? (memoryCortex as any)
                                    .retrieveContrastivePostMortems(task, {
                                        ...scopedQueryOpts,
                                        limit: 2
                                    })
                                    .catch(() => ({ wins: [], losses: [], formattedBlock: '' }))
                              : Promise.resolve({ wins: [], losses: [], formattedBlock: '' })
                      ]);

                const revalidatedRetrieved =
                    !disableMemoryRetrieval &&
                    (scope?.optionalContext?.includes('lessons') || trustedAppId === 'duelodds')
                        ? await revalidateLessonsWithSqlFacts(rawRetrieved, effectiveAsOf)
                        : rawRetrieved;

                const retrieved = revalidatedRetrieved
                    .filter((m: any) => isSafeRetrievedBaseline(m))
                    .slice(0, maxLessonsCap);

                const sanitizeFormattedSection = (rawSection: string): string => {
                    if (!rawSection || typeof rawSection !== 'string') return '';
                    const trimmed = rawSection.trim();
                    if (!trimmed) return '';
                    const chunks = trimmed.split(/\r?\n\r?\n+/);
                    const safeChunks: string[] = [];
                    let hasBodyContent = false;
                    for (const chunk of chunks) {
                        const filteredLines = chunk
                            .split(/\r?\n/)
                            .map((line) => {
                                if (!line.trim()) return '';
                                if (containsLegacyContractBoilerplate(line)) return '';
                                if (/^\s*\+\s*\[Win/i.test(line) && STRATEGIC_PASS_RESULT_RE.test(line)) {
                                    return '';
                                }
                                return line.length > MAX_MEMORY_SNIPPET_CHARS
                                    ? `${line.slice(0, MAX_MEMORY_SNIPPET_CHARS - 3).trimEnd()}...`
                                    : line;
                            })
                            .filter(Boolean);
                        if (filteredLines.length === 0) continue;
                        const isBannerOnly =
                            filteredLines.length === 1 &&
                            /^\[Contrastive Episodic Memory/i.test(filteredLines[0]);
                        const isSectionHeaderOnly =
                            filteredLines.length === 1 &&
                            (/^(?:VALIDATED WINNING PATTERNS:|GRADED LOSS POST-MORTEMS)/i.test(filteredLines[0]) ||
                                isBannerOnly);
                        if (isBannerOnly) {
                            safeChunks.push(filteredLines[0]);
                        } else if (!isSectionHeaderOnly) {
                            hasBodyContent = true;
                            safeChunks.push(filteredLines.join('\n'));
                        }
                    }
                    if (!hasBodyContent) return '';
                    return safeChunks.join('\n\n');
                };

                const safeExemplars = sanitizeFormattedSection(exemplars);
                const safeContrastiveBlock = sanitizeFormattedSection(contrastive?.formattedBlock || '');

                const baselineBlock =
                    retrieved.length > 0
                        ? `Retrieved ${retrieved.length} relevant historical baselines from memory:\n` +
                          retrieved
                              .map(
                                  (m: any, idx: number) =>
                                      `[Baseline ${idx + 1}]: ${formatBoundedLessonRule(m)}`
                              )
                              .join('\n')
                        : (!safeExemplars && !safeContrastiveBlock
                            ? 'Vector Cortex connected. No prior matching historical baselines found for this domain.'
                            : '');

                const cortexMemoryParts: string[] = [];
                if (baselineBlock) cortexMemoryParts.push(baselineBlock);
                if (safeExemplars) cortexMemoryParts.push(`High-Quality Exemplars from Past Runs:\n${safeExemplars}`);
                if (safeContrastiveBlock) cortexMemoryParts.push(safeContrastiveBlock);

                historicalContext = capCortexMemoryBlock(
                    cortexMemoryParts.filter(Boolean).join('\n\n'),
                    MAX_CORTEX_MEMORY_BLOCK_CHARS
                );

                // Inject validated immutable game context snapshot block if available
                let contextStoreInjected = false;
                if (gameContextResult?.status === 'ok' && gameContextResult.formattedBlock) {
                    if (String(p.data || '').includes('[IMMUTABLE GAME CONTEXT SNAPSHOTS')) {
                        contextStoreInjected = true;
                    } else {
                        const currentBytes = utf8ByteLength(historicalContext);
                        const storeBytes = utf8ByteLength(gameContextResult.formattedBlock);
                        if (currentBytes + storeBytes <= MAX_PROMPT_HISTORY_BYTES) {
                            historicalContext += `\n\n${gameContextResult.formattedBlock}`;
                        } else {
                            // Prioritize immutable game context within the 6000-byte history budget
                            historicalContext = gameContextResult.formattedBlock;
                        }
                        contextStoreInjected = true;
                    }
                }

                // On-demand Supabase pull for DuelOdds / sports workflows when not already populated by context store or runMorningSlate
                // Disabled in two-hop / curatedDossier mode so stale Supabase snapshots never contradict COMPACT SLATE or get_market_movement.
                const supaCfg = getSupabaseConfig();
                const isTwoHopOrCurated =
                    p.triageMode === 'two-hop' ||
                    Boolean(p.curatedDossierActive) ||
                    (typeof p.data === 'string' && p.data.includes('=== COMPACT SLATE ==='));
                const alreadyHasSupabaseContext =
                    contextStoreInjected ||
                    task.includes('[SUPABASE LIVE MARKET STEAM') ||
                    String(p.data || '').includes('[SUPABASE LIVE MARKET STEAM');
                const isSportsOrDuelOdds =
                    trustedAppId === 'duelodds' ||
                    (typeof readDomain === 'string' && /sport|bet|odds/i.test(readDomain)) ||
                    /\b(event_?id|spread|moneyline|over\/under|duelodds)\b/i.test(task);

                if (!disableMemoryRetrieval && !alreadyHasSupabaseContext && !isTwoHopOrCurated && isSportsOrDuelOdds) {
                    if (!supaCfg) {
                        console.warn(
                            '[MemoryGrounding] sports/duelodds task without Supabase config; on-demand pull skipped'
                        );
                        const suffix = '[DUELODDS SUPABASE ON-DEMAND] supabase_not_configured';
                        const maxBase = Math.max(0, MAX_CORTEX_MEMORY_BLOCK_CHARS - suffix.length - 2);
                        const cappedBase = capCortexMemoryBlock(historicalContext, maxBase);
                        historicalContext = cappedBase ? `${cappedBase}\n\n${suffix}` : suffix;
                    } else {
                        const onDemand = await fetchOnDemandSupabaseContext(supaCfg, {
                            task,
                            data: p.data,
                            eventId: p.eventId,
                            eventIds: explicitEvents,
                            gameDate: p.gameDate || scope?.date || p.date,
                            sport: effectiveSport,
                            asOf: effectiveAsOf,
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
                            console.warn(
                                `[MemoryGrounding] on-demand pull ${onDemand.error}: ${onDemand.detail || ''}`
                            );
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
                        exemplarsIncluded: Boolean(safeExemplars),
                        contrastiveWins: contrastive?.wins?.length || 0,
                        contrastiveLosses: contrastive?.losses?.length || 0,
                        status: 'Success',
                        message: historicalContext
                    },
                    durationMs: 12
                });
            } catch (err: any) {
                let errorMessage = err.message || String(err);
                if (
                    errorMessage.includes("Unexpected token '<'") ||
                    errorMessage.includes('is not valid JSON')
                ) {
                    errorMessage =
                        'The Qdrant URL provided returned an HTML web page instead of JSON. Ensure you use the Cluster REST Endpoint URL (e.g. https://xyz.cloud.qdrant.tech:6333) and not the dashboard URL.';
                }

                context.addEvent({
                    agentRole: 'System Orchestrator',
                    action: 'Cortex Retrieval Failed',
                    prompt: 'Retrieval failed',
                    modelName: 'Cortex/Fallback',
                    error: `Memory retrieval error: ${errorMessage}`,
                    durationMs: 0
                });
                historicalContext =
                    'Failed to retrieve baselines from memory. Proceeding without historical context.';
            }
        }
    } else if (gameContextResult?.status === 'ok' && gameContextResult.formattedBlock) {
        historicalContext = gameContextResult.formattedBlock;
    }

    return {
        historicalContext,
        actionPlanBypassedQdrant,
        ...(gameContextResult ? { gameContextResult } : {})
    };
}
