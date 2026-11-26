import { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { guardManagerResponse, sanitizeCompilerProposalOddsAndSummary, splitSentencesSafe } from '../parser.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { globalTokenBudgetManager } from '../loadBalancer/tokenBudgetManager.ts';
import { globalProviderLimiter, FAILOVER_MAX_TPM_WAIT_MS } from '../providers/limiter.ts';
import { isModelDead } from '../server/modelsProvider.ts';
import { resolveProvider } from './utils.ts';
import { getManagerContextTokenCeiling } from './synthesisPipeline.ts';
import { formatRunDebugOutputDigest, recordRunDebugSeat } from './runDebugRecord.ts';
import { parseGameHeaders, renderHeaders, filterPicksByCoverage, type GameHeader } from '../context/gameHeaders.ts';
import { INJURY_ATTRIBUTION_RULE, auditInjuryAttribution, matchTeamByLabel, sanitizeMisattributedPicksAndText } from '../tools/injuryAttribution.ts';
import { MARKET_AND_ROW_RULES, SPREAD_SIDE_RULE, auditMarketCoverageAndRowBinding, extractRowOptions, sanitizeRowMismatchedPicks, type MarketToolRecord } from '../tools/marketRowBinding.ts';
import {
    GROUNDING_RULE,
    FORM_GROUNDING_BULLETS,
    VETO_STICKS_RULE,
    auditClaimGrounding,
    auditCriticPremiseContradictions,
    dedupeVetoMessages,
    ensureRiskCriticVetoScorecard,
    mergeVetoedClaims,
    mergeVetoedLegTargets,
    normalizePassIfAllLegsVetoed,
    sanitizeUngroundedClaims,
    type VetoedLegTarget
} from '../tools/claimGrounding.ts';
import {
    PULL_BEFORE_PASS_RULE,
    mergeToolCallTraceEntries,
    sanitizePullBeforePassClaims,
    type ToolCallTraceEntry
} from '../tools/pullBeforePass.ts';
import { CRITIC_EVIDENCE_RULE } from '../tools/criticEvidence.ts';
import { CRITIC_AUDIT_RULE, enforceCriticAuditOnFinalAnalysis, reconcileFinalVerdictAndPicks, resolveFinalCriticApproved } from '../tools/criticAudit.ts';
import { syncCompilerProseWithFinalPicks } from '../tools/compilerProseSync.ts';
import type { ToolEvidenceItem } from './seatToolLoop.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { GameQueryCache } from '../cache/gameQueryCache.ts';

import type { Provider, ProviderCredential, SwarmEngineSettings } from '../types.ts';

function parseProviderModelPair(modelName?: string): { provider: string; model: string } | null {
    const raw = String(modelName || '').trim();
    if (!raw) return null;
    const arrowIdx = raw.lastIndexOf('->');
    const segment = arrowIdx >= 0 ? raw.slice(arrowIdx + 2).trim() : raw;
    const slashSpaced = segment.match(/^([a-z0-9_-]+)\s*\/\s*(.+)$/i);
    if (slashSpaced) {
        return {
            provider: slashSpaced[1].trim().toLowerCase(),
            model: slashSpaced[2].trim()
        };
    }
    return null;
}

function detectPass1CriticTarget(
    context: SwarmContext,
    analysts: Agent[]
): { provider: string; model: string } | null {
    const events = Array.isArray(context?.events) ? context.events : [];
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        const role = String(ev?.agentRole || '');
        if (!/(?:critic|risk)/i.test(role)) continue;
        const action = String(ev?.action || '');
        if (
            action.startsWith('Completed execution') ||
            action === 'Started execution'
        ) {
            const parsed = parseProviderModelPair(ev?.modelName);
            if (parsed) return parsed;
        }
    }
    const criticAnalyst = analysts.find(a => /(?:critic|risk)/i.test(String(a?.role || '')));
    if (criticAnalyst) {
        return {
            provider: String(criticAnalyst.provider).toLowerCase(),
            model: String(criticAnalyst.modelName || '')
        };
    }
    return null;
}

/**
 * Decouples Critic Verification from Risk Critic Pass 1's Groq TPM bucket.
 * When the base critic would collide with Pass 1's Groq model bucket or face a >5s TPM wait,
 * routes Verification to a fast 0ms-wait provider/model that did NOT just run Pass 1:
 * Gemini (`gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`), Cloudflare (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`),
 * or a separate Groq model (`openai/gpt-oss-20b` / `llama-3.3-70b-versatile`).
 */
export function selectDecoupledVerifierAgent(params: {
    baseCriticAgent: Agent;
    managerAgent: Agent;
    analysts: Agent[];
    context: SwarmContext;
    settings?: SwarmEngineSettings;
    estimatedTokens?: number;
}): Agent {
    const { baseCriticAgent, managerAgent, analysts, context, settings } = params;
    const estTokens = Math.max(500, params.estimatedTokens ?? 1_500);
    const baseProvider = String(baseCriticAgent.provider || '').toLowerCase();
    const baseModel = String(baseCriticAgent.modelName || '').trim();
    const baseModelLower = baseModel.toLowerCase();

    const pass1Target = detectPass1CriticTarget(context, analysts);
    const pass1Provider = pass1Target?.provider?.toLowerCase() || '';
    const pass1ModelLower = pass1Target?.model?.toLowerCase() || '';

    const limiterWait = globalProviderLimiter.budgetWaitMs(baseProvider, estTokens, baseModel);
    const managerUsed = globalTokenBudgetManager.getTokensUsedInWindow(baseProvider as Provider, baseModel);
    const managerWait = globalTokenBudgetManager.canAllocate(baseProvider as Provider, estTokens, baseModel)
        ? 0
        : globalTokenBudgetManager.estimateWaitMs(baseProvider as Provider, estTokens, baseModel);
    const baseWaitMs = Math.max(limiterWait, managerWait);

    const managerSawGemini503 = (Array.isArray(context?.events) ? context.events : []).some((ev) => {
        const role = String(ev?.agentRole || '');
        const model = String(ev?.modelName || '');
        const err = String(ev?.error || ev?.failover?.errorSnippet || '');
        const fromProv = String(ev?.failover?.fromProvider || '').toLowerCase();
        const status = ev?.failover?.status;
        const isGeminiEv = fromProv === 'gemini' || /\bgemini\b/i.test(model);
        const is503Err = status === 503 || /\b503\b|SERVER_ERROR_503|overloaded|high demand/i.test(err);
        return isGeminiEv && is503Err && /manager|compiler|synthesis/i.test(role);
    });

    const baseIs31FlashLite = baseProvider === 'gemini' && baseModelLower === 'gemini-3.1-flash-lite';
    const baseGeminiBlockedByManager503 = baseProvider === 'gemini' && managerSawGemini503;
    const baseFallbacksHave31BeforeCf = (() => {
        const fbs = typeof baseCriticAgent.getFallbacks === 'function' ? baseCriticAgent.getFallbacks() : [];
        const idx31 = fbs.findIndex(
            (fb) => String(fb.provider).toLowerCase() === 'gemini' && String(fb.modelName || '').toLowerCase() === 'gemini-3.1-flash-lite'
        );
        const idxCf = fbs.findIndex((fb) => String(fb.provider).toLowerCase() === 'cloudflare');
        return idx31 !== -1 && (idxCf === -1 || idx31 < idxCf);
    })();

    const collidesWithPass1Groq =
        baseProvider === 'groq' &&
        (
            (pass1Provider === 'groq' && (!pass1ModelLower || pass1ModelLower === baseModelLower)) ||
            baseWaitMs > 0 ||
            managerUsed > 0
        );
    const isThrottled = baseWaitMs > FAILOVER_MAX_TPM_WAIT_MS;

    if (
        !collidesWithPass1Groq &&
        !isThrottled &&
        !baseIs31FlashLite &&
        !baseGeminiBlockedByManager503 &&
        !baseFallbacksHave31BeforeCf
    ) {
        return baseCriticAgent;
    }

    // S2.2 (wf-1795638625511): Route Verifier directly to gemini-3.5-flash-lite -> cloudflare -> groq/openai/gpt-oss-20b.
    // Never try gemini-3.1-flash-lite ahead of gemini-3.5-flash-lite or cloudflare (and skip Gemini first-try when
    // Manager already saw a 503 on Gemini so Verification goes straight to Cloudflare).
    const orderedCandidates: Array<{ provider: Provider; model: string }> = [
        ...(!managerSawGemini503
            ? [{ provider: 'gemini' as Provider, model: 'gemini-3.5-flash-lite' }]
            : []),
        { provider: 'cloudflare' as Provider, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
        { provider: 'groq' as Provider, model: 'openai/gpt-oss-20b' },
        { provider: 'groq' as Provider, model: 'llama-3.3-70b-versatile' }
    ];

    const readyZeroWait: Array<{ cred: ProviderCredential; waitMs: number }> = [];
    const readyFastWait: Array<{ cred: ProviderCredential; waitMs: number }> = [];
    const baseApiKey = String((baseCriticAgent as any).apiKey || '').trim();

    for (const cand of orderedCandidates) {
        const candProv = String(cand.provider).toLowerCase();
        const candModelLower = cand.model.toLowerCase();
        if (candProv === pass1Provider && candModelLower === pass1ModelLower) continue;
        if (baseProvider === 'groq' && candProv === 'groq' && candModelLower === baseModelLower) continue;
        if (isModelDead(candProv, cand.model)) continue;
        if (!globalProviderLimiter.isAvailable(candProv, cand.model)) continue;

        const resolved = resolveProvider(cand.provider, (settings || {}) as SwarmEngineSettings);
        const key = resolved.key || (candProv === baseProvider ? baseApiKey : '');
        if (!key) continue;

        const cLimiterWait = globalProviderLimiter.budgetWaitMs(candProv, estTokens, cand.model);
        const cManagerWait = globalTokenBudgetManager.canAllocate(cand.provider, estTokens, cand.model)
            ? 0
            : globalTokenBudgetManager.estimateWaitMs(cand.provider, estTokens, cand.model);
        const cWait = Math.max(cLimiterWait, cManagerWait);
        if (!Number.isFinite(cWait) || cWait > FAILOVER_MAX_TPM_WAIT_MS) continue;

        const cred: ProviderCredential = {
            provider: cand.provider,
            modelName: cand.model,
            apiKey: key,
            ...(resolved.client ? { aiClient: resolved.client } : {})
        };
        if (cWait === 0) {
            readyZeroWait.push({ cred, waitMs: cWait });
        } else {
            readyFastWait.push({ cred, waitMs: cWait });
        }
    }

    const readyPool = [...readyZeroWait, ...readyFastWait].map(r => r.cred);
    if (readyPool.length === 0) {
        return baseCriticAgent;
    }

    const [primary, ...rest] = readyPool;
    const seen = new Set<string>([`${primary.provider}::${primary.modelName}`]);
    const fallbacks: ProviderCredential[] = [];
    const deferred31Fallbacks: ProviderCredential[] = [];
    const baseFallbacks = typeof baseCriticAgent.getFallbacks === 'function' ? baseCriticAgent.getFallbacks() : [];
    for (const fb of [...rest, ...baseFallbacks]) {
        const fbProv = String(fb.provider).toLowerCase();
        const fbModelLower = String(fb.modelName || '').toLowerCase();
        const k = `${fb.provider}::${fb.modelName || ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (fbProv === 'gemini' && fbModelLower === 'gemini-3.1-flash-lite') {
            if (!managerSawGemini503) deferred31Fallbacks.push(fb);
            continue;
        }
        fallbacks.push(fb);
    }
    fallbacks.push(...deferred31Fallbacks);

    const decoupled = new Agent(
        baseCriticAgent.role,
        primary.modelName || baseModel,
        primary.provider,
        primary.apiKey,
        primary.aiClient,
        fallbacks,
        undefined,
        baseCriticAgent.id,
        baseCriticAgent.maxTokens
    );
    decoupled.preserveFallbackOrder = true;
    const existingSys = typeof baseCriticAgent.getSystemInstruction === 'function'
        ? baseCriticAgent.getSystemInstruction()
        : undefined;
    if (existingSys) decoupled.setSystemInstruction(existingSys);

    context.addEvent({
        agentRole: 'Analysis Lifecycle',
        action: 'Verifier Bucket Decoupled',
        modelName: `${primary.provider} / ${primary.modelName}`,
        prompt: `Decoupled Critic Verification from ${baseProvider}/${baseModel} (wait=${Math.ceil(baseWaitMs)}ms) to ${primary.provider}/${primary.modelName}`
    });

    return decoupled;
}

export interface VerificationPipelineParams {
    task: string;
    rawInput: string;
    effectiveDynamicPrompt: string;
    effectiveCompiledReports: string;
    effectiveHistoricalContext: string;
    managerAgent: Agent;
    analysts: Agent[];
    dedicatedCriticAgent: Agent | null;
    context: SwarmContext;
    settings?: SwarmEngineSettings;
    coveredEventIds?: string[];
    toolResults?: string;
    toolEvidenceItems?: ToolEvidenceItem[];
    marketToolRecords?: MarketToolRecord[];
    toolCallTrace?: ToolCallTraceEntry[];
    criticVetoes?: string[];
    vetoedLegs?: VetoedLegTarget[];
    vetoedClaims?: string[];
    hadProposedPicks?: boolean;
    criticVerdictApproved?: boolean;
    appComputedCounts?: string;
    toolRegistry?: ToolRegistry;
    queryCache?: GameQueryCache;
    toolOptions?: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch; qdrantClient?: any };
    activeEventIds?: string[];
    seatScorecards?: any[];
}

export interface VerificationPipelineResult {
    finalAnalysis: any;
    lifecycleResult: any;
}

const CONTRADICTORY_RECOMMENDATION_PROSE_REGEX =
    /\b(?:proceed\s+with\s+(?:a\s+)?(?:\d+|two|three|four|five)\s*-?\s*leg|recommend(?:ed|ing|s)?\s+(?:a\s+)?(?:\d+|two|three|four|five)\s*-?\s*leg|risk\s+critic\s+approved\s+(?:all|every|both|the))\b/i;

const FEEDBACK_REJECTION_CUE_REGEX =
    /\b(?:reject(?:ed|s|ing)?|veto(?:ed|s|ing)?|fail(?:ed|s|ing)?|invalid|disqualif(?:y|ied|ies)|contradict(?:s|ed|ing)?|ungrounded|misread|disadvantaged|away_advantage|home_advantage|symmetric|uncertain_questionable|remove|drop|strip|exclude|cannot\s+recommend|do\s+not\s+recommend|out\b)\b/i;

const FEEDBACK_APPROVAL_ONLY_CUE_REGEX =
    /\b(?:approved?|valid|clean|pass(?:ed|es)?|keep|sound|grounded|fine|solid|good)\b/i;

function escapeRx(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPickIdentifierInfo(
    pk: any,
    rowMap: Map<string, { rowId: string; eventId?: string; text: string }>
): { rowId?: string; label: string; aliases: string[]; eventId?: string } {
    const rawSide = typeof pk === 'string'
        ? pk.trim()
        : String(pk?.side || pk?.pick || pk?.selection || pk?.team || '').trim();
    const rowField = typeof pk === 'object' && pk
        ? String(pk.row || pk.id || '').trim()
        : '';
    const rowMatch = rowField.match(/\b(R\d+)\b/i) || rawSide.match(/\b(R\d+)\b/i);
    const rowId = rowMatch ? rowMatch[1].toUpperCase() : undefined;
    const rowEntry = rowId ? rowMap.get(rowId) : undefined;
    const label = rawSide || rowEntry?.text || rowId || '';
    const aliases = new Set<string>();
    for (const src of [rawSide, rowEntry?.text].filter((x): x is string => Boolean(x))) {
        const entry = matchTeamByLabel(src);
        if (entry) {
            aliases.add(entry.name.toLowerCase());
            if (entry.abbr && entry.abbr.length >= 2) aliases.add(entry.abbr.toLowerCase());
            if (entry.city && entry.city.length >= 3) aliases.add(entry.city.toLowerCase());
            const words = entry.name.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
            if (words.length > 0) aliases.add(words[words.length - 1]);
        }
        const stripped = src
            .replace(/\b(?:R\d+|SPR|ML|TOT|moneyline|spread|over|under|home|away)\b/gi, ' ')
            .replace(/[+-]\d+(?:\.\d+)?/g, ' ')
            .replace(/[()[\]:|]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (stripped.length >= 4) {
            aliases.add(stripped.toLowerCase());
        }
    }
    return {
        ...(rowId ? { rowId } : {}),
        label,
        aliases: Array.from(aliases),
        ...(typeof pk === 'object' && pk?.event_id ? { eventId: String(pk.event_id) } : (rowEntry?.eventId ? { eventId: rowEntry.eventId } : {}))
    };
}

function spanMatchesPickInfo(
    span: string,
    info: { rowId?: string; aliases: string[] }
): boolean {
    if (!span || !span.trim()) return false;
    if (info.rowId && new RegExp(`\\b${escapeRx(info.rowId)}\\b`, 'i').test(span)) {
        return true;
    }
    const lower = span.toLowerCase();
    for (const alias of info.aliases) {
        if (!alias || alias.length < 2) continue;
        if (alias.length <= 4) {
            if (new RegExp(`\\b${escapeRx(alias.toUpperCase())}\\b`).test(span)) return true;
        } else if (new RegExp(`\\b${escapeRx(alias)}\\b`, 'i').test(lower)) {
            return true;
        }
    }
    return false;
}

function pickMatchesVetoedTarget(
    pk: any,
    target: VetoedLegTarget,
    rowMap: Map<string, { rowId: string; eventId?: string; text: string }>
): boolean {
    const info = buildPickIdentifierInfo(pk, rowMap);
    if (target.rowId && info.rowId && target.rowId.toUpperCase() === info.rowId.toUpperCase()) {
        return true;
    }
    if (target.eventId && info.eventId && target.eventId === info.eventId) {
        return true;
    }
    const pickText = [info.rowId, info.label].filter(Boolean).join(' ');
    if (target.rowId && new RegExp(`\\b${escapeRx(target.rowId)}\\b`, 'i').test(pickText)) {
        return true;
    }
    const lowerPick = pickText.toLowerCase();
    for (const alias of target.teamAliases || []) {
        const cleanAlias = String(alias || '').trim().toLowerCase();
        if (!cleanAlias || cleanAlias.length < 2) continue;
        if (info.aliases.includes(cleanAlias)) return true;
        if (cleanAlias.length <= 4) {
            if (new RegExp(`\\b${escapeRx(cleanAlias.toUpperCase())}\\b`).test(pickText)) return true;
        } else if (new RegExp(`\\b${escapeRx(cleanAlias)}\\b`, 'i').test(lowerPick)) {
            return true;
        }
    }
    return false;
}

/**
 * Extracts specific leg(s) named in rejection clauses of Verifier feedback when other
 * proposed legs are NOT rejected in that feedback.
 */
export function extractRejectedLegTargetsFromFeedback(
    feedbackText: string,
    picks: any[],
    headers: GameHeader[],
    slateText: string
): VetoedLegTarget[] {
    if (!feedbackText || !feedbackText.trim() || !Array.isArray(picks) || picks.length === 0) {
        return [];
    }
    const rowMap = extractRowOptions([slateText], headers);
    const pickInfos = picks.map(pk => ({ pk, info: buildPickIdentifierInfo(pk, rowMap) }));

    // Split feedback into clauses (sentence boundaries, semicolons, and contrasting conjunctions)
    const rawClauses = splitSentencesSafe(feedbackText).flatMap(s =>
        s.split(/;\s+|,\s+(?:but|however|while|whereas|except)\s+|\s+\b(?:but|however)\b\s+/i)
    );

    const rejected: VetoedLegTarget[] = [];
    for (const rawClause of rawClauses) {
        const clause = rawClause.trim();
        if (!clause) continue;
        if (!FEEDBACK_REJECTION_CUE_REGEX.test(clause)) continue;
        // Skip pure approval clauses that mention no rejection cue
        const matched = pickInfos.filter(({ info }) => spanMatchesPickInfo(clause, info));
        if (matched.length === 0) continue;
        // If clause approves one leg and rejects another without punctuation split, skip ambiguous all-leg approval clauses
        if (matched.length === pickInfos.length && FEEDBACK_APPROVAL_ONLY_CUE_REGEX.test(clause)) {
            continue;
        }
        for (const { info } of matched) {
            rejected.push({
                ...(info.rowId ? { rowId: info.rowId } : {}),
                ...(info.eventId ? { eventId: info.eventId } : {}),
                ...(info.label ? { teamLabel: info.label } : {}),
                teamAliases: info.aliases,
                reason: clause.slice(0, 180)
            });
        }
    }
    return mergeVetoedLegTargets(rejected);
}

/**
 * Normalizes a zero-pick `_repaired: true` or exhausted-retry verification fallback into
 * an internally consistent pass payload with explicit `criticApproved: false`, `wageringPass: true`,
 * preserved Risk Critic veto scorecards, `verification.reasons`, and clean pass prose.
 */
export function normalizeRepairedFallbackOutput<T extends Record<string, any>>(
    report: T,
    options?: {
        reasons?: string[];
        vetoedLegs?: VetoedLegTarget[];
        seatScorecards?: any[];
        initialPicks?: any[];
        headers?: GameHeader[];
        slateText?: string;
        markUnverified?: boolean;
    }
): T {
    if (!report || typeof report !== 'object') return report;
    const rep = report as Record<string, any>;
    const rowMap = extractRowOptions(
        options?.slateText ? [options.slateText] : [],
        options?.headers || []
    );

    const reasons = dedupeVetoMessages([
        ...(Array.isArray(options?.reasons) ? options!.reasons : []),
        ...(Array.isArray(rep.verification?.reasons) ? rep.verification.reasons : [])
    ]);

    let vetoTargets = mergeVetoedLegTargets(options?.vetoedLegs);
    if (vetoTargets.length === 0 && Array.isArray(options?.initialPicks) && options!.initialPicks.length > 0) {
        vetoTargets = mergeVetoedLegTargets(
            options!.initialPicks.map(pk => {
                const info = buildPickIdentifierInfo(pk, rowMap);
                return {
                    ...(info.rowId ? { rowId: info.rowId } : {}),
                    ...(info.eventId ? { eventId: info.eventId } : {}),
                    ...(info.label ? { teamLabel: info.label } : {}),
                    teamAliases: info.aliases,
                    reason: reasons[0] || 'Failed verification'
                };
            })
        );
    }

    rep.picks = [];
    rep.components = [];
    rep.pass = true;
    rep.status = 'no_play';
    rep.criticApproved = false;
    rep.wageringPass = true;
    if (options?.markUnverified !== false) {
        rep.verified = false;
    }

    if (Array.isArray(rep.scorecards)) {
        rep.scorecards = rep.scorecards.map((sc: any) => {
            if (
                sc &&
                typeof sc === 'object' &&
                /risk\s*critic|^critic$/i.test(String(sc.seat || sc.role || '').trim()) &&
                String(sc.verdict || '').trim().toLowerCase() !== 'veto'
            ) {
                const { notes: _dropNotes, summary: _dropSummary, reason: _dropReason, ...rest } = sc;
                return rest;
            }
            return sc;
        });
    }

    if (rep.verification && typeof rep.verification === 'object') {
        if (reasons.length > 0) {
            rep.verification = {
                ...rep.verification,
                reasons
            };
        }
    } else if (reasons.length > 0) {
        rep.verification = {
            success: false,
            reasons
        };
    }

    normalizePassIfAllLegsVetoed(
        rep,
        Math.max(options?.initialPicks?.length ?? 0, vetoTargets.length, 1),
        true,
        {
            vetoTexts: reasons.length > 0 ? reasons : ['Verification failed after exhausting retries'],
            vetoedLegs: vetoTargets,
            seatScorecards: options?.seatScorecards,
            criticApproved: false
        }
    );

    ensureRiskCriticVetoScorecard(rep, {
        vetoReason: reasons[0] || 'Verification failed after exhausting retries.',
        seatScorecards: options?.seatScorecards
    });

    if (options?.markUnverified && typeof rep.summary === 'string' && rep.summary.trim().length > 0) {
        if (!/^\[unverified\]/i.test(rep.summary.trim())) {
            rep.summary = `[UNVERIFIED] ${rep.summary.trim()}`;
        }
    }

    sanitizeCompilerProposalOddsAndSummary(rep);
    return report;
}

export async function runDeepAnalysisVerification(
    p: VerificationPipelineParams,
    settingsOverride?: SwarmEngineSettings
): Promise<VerificationPipelineResult> {
    const {
        task,
        rawInput,
        effectiveDynamicPrompt,
        effectiveCompiledReports,
        effectiveHistoricalContext,
        managerAgent,
        analysts,
        dedicatedCriticAgent,
        context,
        settings: paramSettings
    } = p;
    const settings = settingsOverride || paramSettings;

    // Select critic: Prefer dedicated critic, then cross-provider analyst (different from manager), then first analyst.
    // Decouple Critic Verification from Risk Critic Pass 1's Groq bucket when Pass 1 ran on the same Groq model or bucket is throttled.
    const crossProviderAnalyst = analysts.find(a => a.provider !== managerAgent.provider);
    const baseCriticAgent = dedicatedCriticAgent || crossProviderAnalyst || analysts[0];
    const criticAgent = selectDecoupledVerifierAgent({
        baseCriticAgent,
        managerAgent,
        analysts,
        context,
        settings
    });

    const isMorningJudge = (settings as any)?.responseSchema === 'morning_judge';
    if (isMorningJudge) {
        criticAgent.setSystemInstruction(`You are the Swarm Verification Critic for Sports Betting Pre-game Judgment. Audit the proposed prediction strictly against the raw data, odds, injuries, and specialist reports. Ensure winProbHome (0.01-0.99), fairSpread, and likelyWinner are logically sound and formatted properly. Team names in Game Slate are authoritative; never rename or flag them.\n\n${CRITIC_EVIDENCE_RULE}\n\n${CRITIC_AUDIT_RULE}\n\n${INJURY_ATTRIBUTION_RULE}\n\n${MARKET_AND_ROW_RULES}\n\n${SPREAD_SIDE_RULE}\n\n${GROUNDING_RULE}
${FORM_GROUNDING_BULLETS}\n\n${VETO_STICKS_RULE}\n\n${PULL_BEFORE_PASS_RULE}`);
    } else {
        criticAgent.setSystemInstruction(`You are the Swarm Verification Critic. Audit proposed analyses strictly against the raw data, historical baselines, and analyst reports. Systematically evaluate and attempt to refute hypotheses formulated by specialists. Flag discrepancies, missed anomalies, ungrounded assumptions, or schema violations. VETO POLICY: Only fail ("pass": false) a betting proposal when a recommended pick leg itself has a fatal injury, fabricated stat/odds, missing coverage on that leg, contra_steam_misread (claiming steam toward a Steam: AGAINST side), symmetric_injury_misread (claiming an injury edge when Health Balance is symmetric or opponent-favored), model_signal_misread (claiming model_signal / lean_home / lean_away when COMPACT SLATE has none, neutral, or leans opposite), or direct rule violation; do not veto valid proposed picks just because other unpicked games on the slate have heavy injuries or incomplete roster data. Team names in Game Slate are authoritative; never rename or flag them.\n\nCRITIC SCOPE:\n- You may call tools to verify evidence.\n- Only pull evidence for the games/legs the analyzers proposed.\n- Do not scan the full slate.\n- A leg fails only if no successful tool result from this run (including your own pulls) supports the cited market or injury.\n- Do not reject a leg solely because a prior evidence bundle was incomplete.\n- Never call shell, bash, python, or built-in code execution tools; when scoped evidence is already supplied below, output verdict JSON directly.\n\n${CRITIC_EVIDENCE_RULE}\n\n${CRITIC_AUDIT_RULE}\n\n${INJURY_ATTRIBUTION_RULE}\n\n${MARKET_AND_ROW_RULES}\n\n${SPREAD_SIDE_RULE}\n\n${GROUNDING_RULE}
${FORM_GROUNDING_BULLETS}\n\n${VETO_STICKS_RULE}\n\n${PULL_BEFORE_PASS_RULE}`);
    }

    const lifecycle = new AnalysisLifecycle(managerAgent, criticAgent, 2, {
        toolRegistry: p.toolRegistry,
        queryCache: p.queryCache,
        toolOptions: p.toolOptions,
        ...(Array.isArray(p.activeEventIds) ? { activeEventIds: p.activeEventIds } : {})
    });
    context.addEvent({
        agentRole: 'Analysis Lifecycle',
        action: 'Deep Analysis Verification Loop Started',
        modelName: `${managerAgent.modelName} (${managerAgent.provider}) vs ${criticAgent.modelName} (${criticAgent.provider})`,
        prompt: `Auditing synthesized proposal against raw findings with cross-provider verification (max 2 attempts)`
    });

    const parsedHeaders = parseGameHeaders(rawInput || task, (p as any)?.params?.eventIds);
    const headersText = renderHeaders(parsedHeaders, 1600);

    const lifecycleResult = await lifecycle.executeAndVerify(
        {
            task,
            dataSample: headersText,
            rawBoard: headersText,
            fullBoard: rawInput || task,
            allHeaders: parsedHeaders,
            analystReports: effectiveCompiledReports,
            historicalBaselines: effectiveHistoricalContext,
            coveredEventIds: p.coveredEventIds,
            ...(p.toolResults ? { toolResults: p.toolResults } : {}),
            ...(p.toolEvidenceItems && p.toolEvidenceItems.length > 0 ? { toolEvidenceItems: p.toolEvidenceItems } : {}),
            ...(p.marketToolRecords ? { marketToolRecords: p.marketToolRecords } : {}),
            ...(p.toolCallTrace && p.toolCallTrace.length > 0 ? { toolCallTrace: p.toolCallTrace } : {}),
            ...(p.criticVetoes && p.criticVetoes.length > 0 ? { criticVetoes: p.criticVetoes } : {}),
            ...(p.vetoedLegs && p.vetoedLegs.length > 0 ? { vetoedLegs: p.vetoedLegs } : {}),
            ...(p.vetoedClaims && p.vetoedClaims.length > 0 ? { vetoedClaims: p.vetoedClaims } : {}),
            ...((p as any).appComputedCounts ? { appComputedCounts: (p as any).appComputedCounts } : {})
        },
        context,
        effectiveDynamicPrompt,
        isMorningJudge
            ? "Verify whether this judgment accurately reflects matchup statistics and odds, calculates realistic win probabilities and fair spreads, and outputs valid judge JSON without hallucinations."
            : "Verify whether this analysis faithfully represents the analyst reports and data, strictly complies with all historical baselines and past lessons without hallucinations or omissions, and does the summary arbitrate analyst disagreements with deciding evidence rather than generic filler, and systematically test and refute ungrounded hypotheses.",
        p.coveredEventIds
    );

    const finalProposal = lifecycleResult.finalProposal;
    const finalAnalysis = isMorningJudge || (finalProposal && typeof finalProposal === 'object' && ('winProbHome' in finalProposal || 'win_prob_home' in finalProposal))
        ? finalProposal
        : guardManagerResponse(finalProposal, "Executive Swarm Synthesis");

    const initialPicksSnapshot = Array.isArray(finalAnalysis?.picks) ? [...finalAnalysis.picks] : [];

    if (finalAnalysis && typeof finalAnalysis === 'object') {
        const combinedVerifiedToolResults = [p.toolResults, lifecycleResult?.verifiedToolEvidence]
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .join('\n\n');
        const combinedToolTrace = mergeToolCallTraceEntries([
            ...(Array.isArray(p.toolCallTrace) ? p.toolCallTrace : []),
            ...(Array.isArray(lifecycleResult?.verifiedToolTrace) ? lifecycleResult.verifiedToolTrace : [])
        ]);
        const combinedVetoTexts = dedupeVetoMessages([
            ...(Array.isArray(p.criticVetoes) ? p.criticVetoes : []),
            ...(Array.isArray(lifecycleResult?.accumulatedVetoes) ? lifecycleResult.accumulatedVetoes : []),
            ...(lifecycleResult?.criticFeedback && !lifecycleResult.success ? [lifecycleResult.criticFeedback] : [])
        ]);
        const combinedVetoedLegs = mergeVetoedLegTargets(p.vetoedLegs, lifecycleResult?.vetoedLegs);
        const combinedVetoedClaims = mergeVetoedClaims(p.vetoedClaims, lifecycleResult?.vetoedClaims);

        const combinedMarketToolRecords: MarketToolRecord[] = [];
        const seenMarketKeys = new Set<string>();
        for (const rec of [
            ...(Array.isArray(p.marketToolRecords) ? p.marketToolRecords : []),
            ...(Array.isArray(lifecycleResult?.verifiedMarketToolRecords) ? lifecycleResult.verifiedMarketToolRecords : [])
        ]) {
            if (!rec || !rec.eventId) continue;
            const key = `${rec.eventId}::${rec.summary || ''}`;
            if (!seenMarketKeys.has(key)) {
                seenMarketKeys.add(key);
                combinedMarketToolRecords.push(rec);
            }
        }

        const initialPickCount = initialPicksSnapshot.length;
        const boardSourceForSanitize = rawInput || task || headersText;

        if (combinedVerifiedToolResults || p.toolResults) {
            sanitizeMisattributedPicksAndText(
                finalAnalysis,
                combinedVerifiedToolResults || p.toolResults!,
                headersText || rawInput || task
            );
        }
        sanitizeRowMismatchedPicks(finalAnalysis, boardSourceForSanitize, parsedHeaders, {
            toolEvidenceText: combinedVerifiedToolResults,
            toolRecords: combinedMarketToolRecords
        });
        if (
            parsedHeaders.length > 0 ||
            combinedVerifiedToolResults ||
            combinedVetoTexts.length > 0 ||
            combinedVetoedLegs.length > 0 ||
            combinedVetoedClaims.length > 0
        ) {
            sanitizeUngroundedClaims(finalAnalysis, combinedVerifiedToolResults, boardSourceForSanitize, {
                headers: parsedHeaders,
                vetoTexts: combinedVetoTexts,
                vetoedLegs: combinedVetoedLegs,
                vetoedClaims: combinedVetoedClaims,
                stripVetoedLegRecommendations: true
            });
        }
        if (parsedHeaders.length > 0 || combinedVerifiedToolResults || combinedToolTrace.length > 0) {
            const availableTools = p.toolRegistry
                ? ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement'].filter(t => p.toolRegistry!.has(t))
                : undefined;
            sanitizePullBeforePassClaims(finalAnalysis, combinedVerifiedToolResults, boardSourceForSanitize, {
                headers: parsedHeaders,
                toolCallTrace: combinedToolTrace,
                ...(availableTools && availableTools.length > 0 ? { availableTools } : {}),
                marketToolRecords: combinedMarketToolRecords,
                ...(Array.isArray(p.activeEventIds) ? { activeEventIds: p.activeEventIds } : {})
            });
        }

        const survivingPickCount = Array.isArray(finalAnalysis.picks) ? finalAnalysis.picks.length : 0;
        const hadVetoedLegs = combinedVetoedLegs.length > 0 || initialPickCount > survivingPickCount;
        const criticAuditFailed = lifecycleResult?.criticAuditFailed === true;
        const unauditedLegs = Array.isArray(lifecycleResult?.unauditedLegs) ? lifecycleResult.unauditedLegs : [];
        const hadProposedPicks = Boolean(p.hadProposedPicks || lifecycleResult?.hadProposedPicks || initialPickCount > 0);

        if (criticAuditFailed) {
            finalAnalysis.verification = {
                success: false,
                attempts: lifecycleResult.attempts,
                rating: lifecycleResult.computedRating,
                ...(combinedVetoTexts.length > 0 ? { reasons: combinedVetoTexts } : {})
            };
            enforceCriticAuditOnFinalAnalysis(finalAnalysis, {
                criticAuditFailed: true,
                unauditedLegs,
                hadProposedPicks,
                auditNote: lifecycleResult?.criticFeedback
            });
            ensureRiskCriticVetoScorecard(finalAnalysis, {
                vetoReason: lifecycleResult?.criticFeedback || combinedVetoTexts[0] || 'Risk Critic audit failed.',
                seatScorecards: p.seatScorecards
            });
            finalAnalysis.criticApproved = false;
        } else if (lifecycleResult.success === false) {
            const verificationReasons = dedupeVetoMessages([
                ...combinedVetoTexts,
                ...(typeof lifecycleResult?.criticFeedback === 'string' && lifecycleResult.criticFeedback.trim()
                    ? [lifecycleResult.criticFeedback.trim()]
                    : [])
            ]);
            finalAnalysis.verified = false;
            finalAnalysis.verification = {
                success: false,
                attempts: lifecycleResult.attempts,
                rating: lifecycleResult.computedRating,
                ...(verificationReasons.length > 0 ? { reasons: verificationReasons } : {})
            };

            // S2 (1): Surgical Leg-Prune Rescue before giving up when only specific leg(s) failed verification
            // and >= 1 clean leg survives all deterministic checks.
            const rowMapForRescue = extractRowOptions([boardSourceForSanitize], parsedHeaders);
            const feedbackRejectedLegs = extractRejectedLegTargetsFromFeedback(
                verificationReasons.join(' '),
                initialPicksSnapshot,
                parsedHeaders,
                boardSourceForSanitize
            );
            const rescueRejectedTargets = mergeVetoedLegTargets(combinedVetoedLegs, feedbackRejectedLegs);

            const lastAttemptFeedback = typeof lifecycleResult?.criticFeedback === 'string'
                ? lifecycleResult.criticFeedback.trim()
                : '';
            const lastAttemptRejectedTargets = extractRejectedLegTargetsFromFeedback(
                lastAttemptFeedback,
                initialPicksSnapshot,
                parsedHeaders,
                boardSourceForSanitize
            );
            const canAttemptSubsetRescue =
                p.criticVerdictApproved !== false &&
                initialPickCount >= 2 &&
                lastAttemptRejectedTargets.length >= 1 &&
                lastAttemptRejectedTargets.length < initialPickCount;

            let rescued = false;
            if (
                canAttemptSubsetRescue &&
                Array.isArray(finalAnalysis.picks) &&
                finalAnalysis.picks.length > 0 &&
                (rescueRejectedTargets.length > 0 || initialPickCount > finalAnalysis.picks.length)
            ) {
                const prunedPicks = rescueRejectedTargets.length > 0
                    ? finalAnalysis.picks.filter(
                        (pk: any) => !rescueRejectedTargets.some(target => pickMatchesVetoedTarget(pk, target, rowMapForRescue))
                    )
                    : [...finalAnalysis.picks];

                if (prunedPicks.length >= 1 && prunedPicks.length < initialPickCount) {
                    const candidate = JSON.parse(JSON.stringify(finalAnalysis));
                    candidate.picks = prunedPicks;
                    syncCompilerProseWithFinalPicks(candidate, {
                        initialPicks: initialPicksSnapshot,
                        headers: parsedHeaders,
                        slateText: boardSourceForSanitize,
                        ...(rescueRejectedTargets.length > 0 ? { vetoedLegs: rescueRejectedTargets } : {}),
                        ...(verificationReasons.length > 0 ? { vetoTexts: verificationReasons } : {}),
                        ...(p.seatScorecards && p.seatScorecards.length > 0 ? { seatScorecards: p.seatScorecards } : {})
                    });
                    sanitizeCompilerProposalOddsAndSummary(candidate);

                    const injuryOk = combinedVerifiedToolResults
                        ? auditInjuryAttribution(candidate, combinedVerifiedToolResults, headersText || rawInput || task).pass
                        : true;
                    const marketOk = (combinedVerifiedToolResults || combinedMarketToolRecords.length > 0)
                        ? auditMarketCoverageAndRowBinding(
                            candidate,
                            combinedVerifiedToolResults,
                            boardSourceForSanitize,
                            parsedHeaders,
                            combinedMarketToolRecords
                        ).pass
                        : true;
                    const groundingOk = auditClaimGrounding(
                        candidate,
                        combinedVerifiedToolResults,
                        boardSourceForSanitize,
                        { headers: parsedHeaders }
                    ).pass;
                    const premiseOk = auditCriticPremiseContradictions(
                        candidate,
                        combinedVerifiedToolResults,
                        boardSourceForSanitize,
                        { headers: parsedHeaders }
                    ).pass;

                    if (injuryOk && marketOk && groundingOk && premiseOk && Array.isArray(candidate.picks) && candidate.picks.length >= 1) {
                        Object.assign(finalAnalysis, candidate);
                        rescued = true;
                    }
                }
            }

            if (!rescued) {
                // S2 (2): Consistent pass fallback — zero contradictory recommendations, explicit
                // criticApproved: false, wageringPass: true, preserved scorecards with Risk Critic veto.
                normalizeRepairedFallbackOutput(finalAnalysis, {
                    reasons: verificationReasons,
                    vetoedLegs: rescueRejectedTargets,
                    seatScorecards: p.seatScorecards,
                    initialPicks: initialPicksSnapshot,
                    headers: parsedHeaders,
                    slateText: boardSourceForSanitize,
                    markUnverified: true
                });
            }
            enforceCriticAuditOnFinalAnalysis(finalAnalysis, {
                criticAuditFailed: false,
                unauditedLegs,
                hadProposedPicks
            });
            finalAnalysis.criticApproved = false;
        } else {
            finalAnalysis.verified = true;
            finalAnalysis.verification = {
                success: true,
                attempts: lifecycleResult.attempts,
                rating: lifecycleResult.computedRating
            };
            normalizePassIfAllLegsVetoed(
                finalAnalysis,
                initialPickCount,
                hadVetoedLegs || combinedVetoTexts.length > 0,
                {
                    vetoTexts: combinedVetoTexts,
                    vetoedLegs: combinedVetoedLegs,
                    seatScorecards: p.seatScorecards,
                    ...(hadVetoedLegs && survivingPickCount === 0 ? { criticApproved: false } : {})
                }
            );
            enforceCriticAuditOnFinalAnalysis(finalAnalysis, {
                criticAuditFailed: false,
                unauditedLegs,
                hadProposedPicks
            });
            const finalSurvivingCount = Array.isArray(finalAnalysis.picks) ? finalAnalysis.picks.length : 0;
            finalAnalysis.criticApproved = resolveFinalCriticApproved(finalAnalysis, {
                criticAuditFailed: false,
                verificationSuccess: true,
                verificationApproved: lifecycleResult.success === true && !hadVetoedLegs && combinedVetoTexts.length === 0,
                criticVerdictApproved: p.criticVerdictApproved,
                hadFullVeto: initialPickCount > 0 && hadVetoedLegs && finalSurvivingCount === 0,
                hadDeterministicVetoes: hadVetoedLegs || combinedVetoTexts.length > 0 || combinedVetoedClaims.length > 0
            });
        }
    }

    if (p.coveredEventIds && Array.isArray(finalAnalysis?.picks)) {
        const originalCount = finalAnalysis.picks.length;
        finalAnalysis.picks = filterPicksByCoverage(finalAnalysis.picks, p.coveredEventIds, parsedHeaders);
        if (finalAnalysis.picks.length === 0 && originalCount > 0) {
            finalAnalysis.ui_title = 'Insufficient data';
            finalAnalysis.reason = 'no picks with specialist coverage';
            finalAnalysis.criticApproved = false;
            finalAnalysis.wageringPass = true;
        }
    }

    if (finalAnalysis && typeof finalAnalysis === 'object' && Array.isArray(finalAnalysis.picks)) {
        const vetoTextsForSync = dedupeVetoMessages([
            ...(Array.isArray(p.criticVetoes) ? p.criticVetoes : []),
            ...(Array.isArray(lifecycleResult?.accumulatedVetoes) ? lifecycleResult.accumulatedVetoes : []),
            ...(typeof lifecycleResult?.criticFeedback === 'string' && lifecycleResult.criticFeedback.trim()
                ? [lifecycleResult.criticFeedback.trim()]
                : [])
        ]);
        const vetoLegsForSync = mergeVetoedLegTargets(p.vetoedLegs, lifecycleResult?.vetoedLegs);
        const wasUnverifiedPass = finalAnalysis.verified === false && finalAnalysis.picks.length === 0;
        if (!wasUnverifiedPass) {
            syncCompilerProseWithFinalPicks(finalAnalysis, {
                initialPicks: initialPicksSnapshot,
                headers: parsedHeaders,
                slateText: rawInput || task || headersText,
                ...(vetoLegsForSync.length > 0 ? { vetoedLegs: vetoLegsForSync } : {}),
                ...(vetoTextsForSync.length > 0 ? { vetoTexts: vetoTextsForSync } : {}),
                ...(p.seatScorecards && p.seatScorecards.length > 0 ? { seatScorecards: p.seatScorecards } : {}),
                ...(finalAnalysis.criticApproved === false ? { criticApproved: false } : {})
            });
        } else {
            ensureRiskCriticVetoScorecard(finalAnalysis, {
                vetoReason: vetoTextsForSync[0] || 'Verification failed after exhausting retries.',
                seatScorecards: p.seatScorecards
            });
        }
        if (wasUnverifiedPass) {
            finalAnalysis.components = [];
            if (typeof finalAnalysis.summary === 'string' && finalAnalysis.summary.trim() && !/^\[unverified\]/i.test(finalAnalysis.summary.trim())) {
                finalAnalysis.summary = `[UNVERIFIED] ${finalAnalysis.summary.trim()}`;
            }
        }
        if (
            finalAnalysis._repaired === true &&
            finalAnalysis.picks.length === 0 &&
            (finalAnalysis.criticApproved === undefined ||
                finalAnalysis.wageringPass === undefined ||
                !Array.isArray(finalAnalysis.scorecards) ||
                finalAnalysis.scorecards.length === 0 ||
                CONTRADICTORY_RECOMMENDATION_PROSE_REGEX.test(String(finalAnalysis.summary || '')) ||
                CONTRADICTORY_RECOMMENDATION_PROSE_REGEX.test(String(finalAnalysis.analysis || '')))
        ) {
            normalizeRepairedFallbackOutput(finalAnalysis, {
                reasons: vetoTextsForSync,
                vetoedLegs: vetoLegsForSync,
                seatScorecards: p.seatScorecards,
                initialPicks: initialPicksSnapshot,
                headers: parsedHeaders,
                slateText: rawInput || task || headersText,
                markUnverified: finalAnalysis.verified === false
            });
        }
        sanitizeCompilerProposalOddsAndSummary(finalAnalysis);

        const finalDetVetoes = [
            ...vetoTextsForSync,
            ...vetoLegsForSync,
            ...(Array.isArray(p.vetoedClaims) ? p.vetoedClaims : []),
            ...(Array.isArray(lifecycleResult?.vetoedClaims) ? lifecycleResult.vetoedClaims : [])
        ];
        reconcileFinalVerdictAndPicks(finalAnalysis, {
            criticPass1Approved: p.criticVerdictApproved,
            criticVerdictApproved: p.criticVerdictApproved,
            deterministicVetoes: finalDetVetoes,
            hadDeterministicVetoes:
                lifecycleResult?.criticAuditFailed === true ||
                lifecycleResult?.success === false ||
                finalAnalysis.verified === false ||
                finalDetVetoes.length > 0 ||
                (initialPicksSnapshot.length > 0 && finalAnalysis.picks.length === 0),
            hadFullVeto: initialPicksSnapshot.length > 0 && finalAnalysis.picks.length === 0,
            criticAuditFailed: lifecycleResult?.criticAuditFailed === true,
            verificationSuccess: lifecycleResult?.success !== false && finalAnalysis.verified !== false,
            verificationApproved:
                lifecycleResult?.success === true &&
                finalDetVetoes.length === 0 &&
                p.criticVerdictApproved !== false,
            vetoTexts: vetoTextsForSync,
            vetoedLegs: vetoLegsForSync,
            seatScorecards: p.seatScorecards,
            initialPicks: initialPicksSnapshot
        });
    }

    recordRunDebugSeat((context as any)?.id, 'manager', {
        role: managerAgent.role,
        provider: String(managerAgent.provider),
        model: managerAgent.modelName,
        promptChars: effectiveDynamicPrompt.length,
        limitChars: getManagerContextTokenCeiling(managerAgent.provider) * 4,
        ...(p.toolResults ? { toolResultsSent: p.toolResults } : {}),
        outputDigest: formatRunDebugOutputDigest(finalAnalysis)
    });

    if (lifecycleResult?.computedRating && analysts.length > 0) {
        const isVerifiedSuccess = !finalAnalysis?.ui_title?.toLowerCase().includes("error");
        for (const analyst of analysts) {
            globalSpecialistProfiler.recordOutcome(analyst.role, {
                success: isVerifiedSuccess,
                qualityRating: lifecycleResult.computedRating
            });
        }
    }

    return {
        finalAnalysis,
        lifecycleResult
    };
}
