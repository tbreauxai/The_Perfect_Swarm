import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { guardManagerResponse } from '../parser.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { getManagerContextTokenCeiling } from './synthesisPipeline.ts';
import { formatRunDebugOutputDigest, recordRunDebugSeat } from './runDebugRecord.ts';
import { parseGameHeaders, renderHeaders, filterPicksByCoverage } from '../context/gameHeaders.ts';
import { INJURY_ATTRIBUTION_RULE, sanitizeMisattributedPicksAndText } from '../tools/injuryAttribution.ts';
import { MARKET_AND_ROW_RULES, SPREAD_SIDE_RULE, sanitizeRowMismatchedPicks, type MarketToolRecord } from '../tools/marketRowBinding.ts';
import {
    GROUNDING_RULE,
    FORM_GROUNDING_BULLETS,
    VETO_STICKS_RULE,
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
}

export interface VerificationPipelineResult {
    finalAnalysis: any;
    lifecycleResult: any;
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
                rating: lifecycleResult.computedRating
            };
            enforceCriticAuditOnFinalAnalysis(finalAnalysis, {
                criticAuditFailed: true,
                unauditedLegs,
                hadProposedPicks,
                auditNote: lifecycleResult?.criticFeedback
            });
        } else if (lifecycleResult.success === false) {
            finalAnalysis.verified = false;
            finalAnalysis.verification = {
                success: false,
                attempts: lifecycleResult.attempts,
                rating: lifecycleResult.computedRating
            };
            if (hadVetoedLegs && survivingPickCount > 0) {
                // Keep remaining grounded picks and cleaned components after stripping vetoed legs and claims.
            } else if (initialPickCount > 0 && hadVetoedLegs && survivingPickCount === 0) {
                finalAnalysis.picks = [];
                finalAnalysis.components = [];
                normalizePassIfAllLegsVetoed(finalAnalysis, initialPickCount, true);
            } else {
                finalAnalysis.picks = [];
                finalAnalysis.components = [];
                const rawSummary = typeof finalAnalysis.summary === 'string' && finalAnalysis.summary.trim()
                    ? finalAnalysis.summary.trim()
                    : (typeof finalAnalysis.reason === 'string' && finalAnalysis.reason.trim() ? finalAnalysis.reason.trim() : 'Verification failed.');
                finalAnalysis.summary = /^\[unverified\]/i.test(rawSummary) ? rawSummary : `[UNVERIFIED] ${rawSummary}`;
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
                hadVetoedLegs || combinedVetoTexts.length > 0
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
        syncCompilerProseWithFinalPicks(finalAnalysis, {
            initialPicks: initialPicksSnapshot,
            headers: parsedHeaders,
            slateText: rawInput || task || headersText
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
