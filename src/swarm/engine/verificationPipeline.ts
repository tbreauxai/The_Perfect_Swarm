import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { guardManagerResponse, sanitizeCompilerProposalOddsAndSummary, splitSentencesSafe } from '../parser.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
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
import { CRITIC_AUDIT_RULE, enforceCriticAuditOnFinalAnalysis } from '../tools/criticAudit.ts';
import { syncCompilerProseWithFinalPicks } from '../tools/compilerProseSync.ts';
import type { ToolEvidenceItem } from './seatToolLoop.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { GameQueryCache } from '../cache/gameQueryCache.ts';

import type { SwarmEngineSettings } from '../types.ts';

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

    const reasons = Array.from(
        new Set(
            [
                ...(Array.isArray(options?.reasons) ? options!.reasons : []),
                ...(Array.isArray(rep.verification?.reasons) ? rep.verification.reasons : [])
            ]
                .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
                .map(x => x.trim())
        )
    );

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

    // Select critic: Prefer dedicated critic, then cross-provider analyst (different from manager), then first analyst
    const crossProviderAnalyst = analysts.find(a => a.provider !== managerAgent.provider);
    const criticAgent = dedicatedCriticAgent || crossProviderAnalyst || analysts[0];

    const isMorningJudge = (settings as any)?.responseSchema === 'morning_judge';
    if (isMorningJudge) {
        criticAgent.setSystemInstruction(`You are the Swarm Verification Critic for Sports Betting Pre-game Judgment. Audit the proposed prediction strictly against the raw data, odds, injuries, and specialist reports. Ensure winProbHome (0.01-0.99), fairSpread, and likelyWinner are logically sound and formatted properly. Team names in Game Slate are authoritative; never rename or flag them.\n\n${CRITIC_EVIDENCE_RULE}\n\n${CRITIC_AUDIT_RULE}\n\n${INJURY_ATTRIBUTION_RULE}\n\n${MARKET_AND_ROW_RULES}\n\n${SPREAD_SIDE_RULE}\n\n${GROUNDING_RULE}
${FORM_GROUNDING_BULLETS}\n\n${VETO_STICKS_RULE}\n\n${PULL_BEFORE_PASS_RULE}`);
    } else {
        criticAgent.setSystemInstruction(`You are the Swarm Verification Critic. Audit proposed analyses strictly against the raw data, historical baselines, and analyst reports. Systematically evaluate and attempt to refute hypotheses formulated by specialists. Flag discrepancies, missed anomalies, ungrounded assumptions, or schema violations. VETO POLICY: Only fail ("pass": false) a betting proposal when a recommended pick leg itself has a fatal injury, fabricated stat/odds, missing coverage on that leg, contra_steam_misread (claiming steam toward a Steam: AGAINST side), symmetric_injury_misread (claiming an injury edge when Health Balance is symmetric or opponent-favored), or direct rule violation; do not veto valid proposed picks just because other unpicked games on the slate have heavy injuries or incomplete roster data. Team names in Game Slate are authoritative; never rename or flag them.\n\nCRITIC SCOPE:\n- You may call tools to verify evidence.\n- Only pull evidence for the games/legs the analyzers proposed.\n- Do not scan the full slate.\n- A leg fails only if no successful tool result from this run (including your own pulls) supports the cited market or injury.\n- Do not reject a leg solely because a prior evidence bundle was incomplete.\n- Never call shell, bash, python, or built-in code execution tools; when scoped evidence is already supplied below, output verdict JSON directly.\n\n${CRITIC_EVIDENCE_RULE}\n\n${CRITIC_AUDIT_RULE}\n\n${INJURY_ATTRIBUTION_RULE}\n\n${MARKET_AND_ROW_RULES}\n\n${SPREAD_SIDE_RULE}\n\n${GROUNDING_RULE}
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
        const combinedVetoTexts = Array.from(
            new Set(
                [
                    ...(Array.isArray(p.criticVetoes) ? p.criticVetoes : []),
                    ...(Array.isArray(lifecycleResult?.accumulatedVetoes) ? lifecycleResult.accumulatedVetoes : []),
                    ...(lifecycleResult?.criticFeedback && !lifecycleResult.success ? [lifecycleResult.criticFeedback] : [])
                ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            )
        );
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
        } else if (lifecycleResult.success === false) {
            const verificationReasons = Array.from(
                new Set(
                    [
                        ...combinedVetoTexts,
                        ...(typeof lifecycleResult?.criticFeedback === 'string' && lifecycleResult.criticFeedback.trim()
                            ? [lifecycleResult.criticFeedback.trim()]
                            : [])
                    ].filter(Boolean)
                )
            );
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

            let rescued = false;
            if (
                initialPickCount > 0 &&
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
        }
    }

    if (p.coveredEventIds && Array.isArray(finalAnalysis?.picks)) {
        const originalCount = finalAnalysis.picks.length;
        finalAnalysis.picks = filterPicksByCoverage(finalAnalysis.picks, p.coveredEventIds, parsedHeaders);
        if (finalAnalysis.picks.length === 0 && originalCount > 0) {
            finalAnalysis.ui_title = 'Insufficient data';
            finalAnalysis.reason = 'no picks with specialist coverage';
        }
    }

    if (finalAnalysis && typeof finalAnalysis === 'object' && Array.isArray(finalAnalysis.picks)) {
        const vetoTextsForSync = [
            ...(Array.isArray(p.criticVetoes) ? p.criticVetoes : []),
            ...(typeof lifecycleResult?.criticFeedback === 'string' && lifecycleResult.criticFeedback.trim()
                ? [lifecycleResult.criticFeedback.trim()]
                : [])
        ];
        const vetoLegsForSync = mergeVetoedLegTargets(p.vetoedLegs, lifecycleResult?.vetoedLegs);
        const wasUnverifiedPass = finalAnalysis.verified === false && finalAnalysis.picks.length === 0;
        syncCompilerProseWithFinalPicks(finalAnalysis, {
            initialPicks: initialPicksSnapshot,
            headers: parsedHeaders,
            slateText: rawInput || task || headersText,
            ...(vetoLegsForSync.length > 0 ? { vetoedLegs: vetoLegsForSync } : {}),
            ...(vetoTextsForSync.length > 0 ? { vetoTexts: vetoTextsForSync } : {}),
            ...(p.seatScorecards && p.seatScorecards.length > 0 ? { seatScorecards: p.seatScorecards } : {}),
            ...(finalAnalysis.criticApproved === false ? { criticApproved: false } : {})
        });
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
