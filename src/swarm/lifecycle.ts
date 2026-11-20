import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { parseJsonSafe, guardVerificationResult } from './parser.ts';
import { redactForLog } from './parser/responseGuards.ts';
import { groqPromptCharCap } from './providers/groq.ts';
import { seatBudget } from './context/promptBudget.ts';
import { parseGameHeaders, renderHeaders, filterPicksByCoverage, type GameHeader } from './context/gameHeaders.ts';
import { filterHeadersByEventIds } from './context/selectedGames.ts';
import {
    isFalseHallucinationCritique,
    mergeScopedToolEvidence,
    resolveDiscussedGameIds
} from './tools/criticEvidence.ts';
import { auditInjuryAttribution } from './tools/injuryAttribution.ts';
import {
    auditClaimGrounding,
    extractQuotedVetoedClaims,
    extractVetoedLegTargets,
    mergeVetoedClaims,
    mergeVetoedLegTargets,
    type VetoedLegTarget
} from './tools/claimGrounding.ts';
import {
    auditMarketCoverageAndRowBinding,
    extractRowOptions,
    isFalseMissingMoneylineCritique,
    type MarketToolRecord
} from './tools/marketRowBinding.ts';
import {
    auditPullBeforePass,
    isEmptyToolSummary,
    mergeToolCallTraceEntries,
    type ToolCallStatus,
    type ToolCallTraceEntry
} from './tools/pullBeforePass.ts';
import {
    CRITIC_AUDIT_RULE,
    buildCriticAuditReprompt,
    evaluateCriticAuditCoverage,
    extractProposedPickSummaries,
    isNoPicksToEvaluateText
} from './tools/criticAudit.ts';
import type { ToolRegistry } from './tools/registry.ts';
import { GameQueryCache } from './cache/gameQueryCache.ts';
import { executeToolWithCacheAndTimeout } from './engine/triageExecutor.ts';
import type { ToolEvidenceItem } from './engine/seatToolLoop.ts';

import type { VerificationResult } from './types.ts';
export type { VerificationResult };

const VERIFICATION_OUTPUT_CONTRACT = `OUTPUT CONTRACT (mandatory):
Return exactly one JSON object with a top-level boolean "pass" and a string "feedback".
"pass": true means no fatal issues were found; "pass": false means the proposal fails review.
Example passing response: {"pass":true,"feedback":"No fatal issues found."}
Example failing response: {"pass":false,"feedback":"The proposal contains a fatal issue."}
Do not omit "pass" or place it inside another object. Missing the top-level boolean is an automatic failure.`;

export interface LifecycleExecutionResult {
    success: boolean;
    attempts: number;
    finalProposal: any;
    criticFeedback?: string;
    computedRating: number;
    verifiedEventIds?: string[];
    verifiedToolEvidence?: string;
    verifiedMarketToolRecords?: MarketToolRecord[];
    verifiedToolTrace?: ToolCallTraceEntry[];
    vetoedLegs?: VetoedLegTarget[];
    vetoedClaims?: string[];
    accumulatedVetoes?: string[];
    criticAuditFailed?: boolean;
    unauditedLegs?: VetoedLegTarget[];
    hadProposedPicks?: boolean;
}

export interface AnalysisLifecycleOptions {
    toolRegistry?: ToolRegistry;
    queryCache?: GameQueryCache;
    toolOptions?: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch; qdrantClient?: any };
}

export class AnalysisLifecycle {
    private proposer: Agent;
    private critic: Agent;
    private maxRetries: number;
    private toolRegistry?: ToolRegistry;
    private queryCache?: GameQueryCache;
    private toolOptions?: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch; qdrantClient?: any };

    constructor(
        proposer: Agent,
        critic: Agent,
        maxRetries: number = 3,
        options?: AnalysisLifecycleOptions
    ) {
        this.proposer = proposer;
        this.critic = critic;
        this.maxRetries = maxRetries;
        this.toolRegistry = options?.toolRegistry;
        this.queryCache = options?.queryCache;
        this.toolOptions = options?.toolOptions;
    }

    /**
     * Computes a continuous reinforcement learning rating based on critic verification and attempt count:
     * - Passed on Attempt 1: 0.98 (flawless first-shot execution)
     * - Passed on Attempt 2: 0.88 (successful critic-guided self-correction)
     * - Passed on Attempt 3+: 0.78 (iterative convergence)
     * - Failed after max retries: 0.35 (penalized, prevents poisoning few-shot exemplar cortex)
     */
    static computeReinforcementScore(success: boolean, attempts: number, maxRetries: number = 3): number {
        if (success) {
            if (attempts === 1) return 0.98;
            if (attempts === 2) return 0.88;
            return Math.max(0.70, Number((0.98 - (attempts - 1) * 0.10).toFixed(2)));
        }
        return Math.max(0.20, Number((0.50 - (attempts / maxRetries) * 0.15).toFixed(2)));
    }

    /**
     * Executes the Red Team / Blue Team analysis loop.
     * The proposer generates an analysis/hypothesis.
     * The critic verifies it against the raw data.
     * If the critic finds flaws, the proposer must try again using the critic's feedback.
     */
    async executeAndVerify(
        rawData: any,
        context: SwarmContext,
        proposerPrompt: string,
        criticPrompt: string,
        coveredEventIds?: string[]
    ): Promise<LifecycleExecutionResult> {
        let attempt = 0;
        let currentProposal: any = null;
        let feedback = "";
        let lastCombinedToolSummary = "";
        let lastAttemptCriticAuditFailed = false;
        let lastAttemptUnauditedLegs: VetoedLegTarget[] = [];
        let anyAttemptHadProposedPicks = false;
        const verifiedEventIdsSet = new Set<string>(coveredEventIds || []);
        let accumulatedToolTrace: ToolCallTraceEntry[] = Array.isArray((rawData as any)?.toolCallTrace)
            ? mergeToolCallTraceEntries((rawData as any).toolCallTrace)
            : [];
        const accumulatedMarketRecords: MarketToolRecord[] = Array.isArray((rawData as any)?.marketToolRecords)
            ? [...(rawData as any).marketToolRecords]
            : [];
        const pushUniqueMarketRecord = (rec: MarketToolRecord) => {
            if (!accumulatedMarketRecords.some(existing => existing.eventId === rec.eventId && existing.summary === rec.summary)) {
                accumulatedMarketRecords.push(rec);
            }
        };
        const freshRetryEvidenceParts: string[] = [];

        const initialCriticVetoes: string[] = Array.isArray((rawData as any)?.criticVetoes)
            ? (rawData as any).criticVetoes.filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0)
            : [];
        const accumulatedVetoTexts: string[] = [...initialCriticVetoes];
        const initHeaders: GameHeader[] = Array.isArray((rawData as any)?.allHeaders) && (rawData as any).allHeaders.length > 0
            ? ((rawData as any).allHeaders as GameHeader[])
            : parseGameHeaders((rawData as any)?.fullBoard || rawData);
        const initRowMap = extractRowOptions([(rawData as any)?.fullBoard || rawData], initHeaders);
        let accumulatedVetoedLegs: VetoedLegTarget[] = mergeVetoedLegTargets(
            Array.isArray((rawData as any)?.vetoedLegs) ? (rawData as any).vetoedLegs : [],
            extractVetoedLegTargets(initialCriticVetoes, initHeaders, initRowMap)
        );
        let accumulatedVetoedClaims: string[] = mergeVetoedClaims(
            Array.isArray((rawData as any)?.vetoedClaims) ? (rawData as any).vetoedClaims : [],
            extractQuotedVetoedClaims(initialCriticVetoes)
        );

        const effectiveCoveredEventIds: string[] | undefined =
            coveredEventIds || (Array.isArray(rawData?.coveredEventIds) ? rawData.coveredEventIds : undefined);

        if (effectiveCoveredEventIds && effectiveCoveredEventIds.length > 0) {
            const coverageDirective = `\n[Specialist Coverage]: Analyst tools only covered the following event ID(s): ${effectiveCoveredEventIds.join(', ')}. Only recommend picks from covered games.`;
            if (!proposerPrompt.includes('[Specialist Coverage]')) {
                proposerPrompt = `${proposerPrompt}\n${coverageDirective}`;
            }
        }

        while (attempt < this.maxRetries) {
            attempt++;
            
            // 1. Proposer executes (incorporating feedback if this is a retry)
            let executePrompt: string;
            if (feedback) {
                const feedbackSummary = feedback.length > 2000 ? `${feedback.slice(0, 2000)}...` : feedback;
                const freshBlock = freshRetryEvidenceParts.length > 0
                    ? `\n\n[Fresh Tool Evidence Pulled Before Retry]:\n${freshRetryEvidenceParts.join('\n\n').slice(0, 2400)}`
                    : '';
                const vetoLines: string[] = [];
                if (accumulatedVetoedLegs.length > 0) {
                    vetoLines.push('- Vetoed legs (DO NOT put back into picks, Recommended Bets, or summary; keep remaining grounded legs, swap in another grounded leg from the slate, or pass if every leg is vetoed):');
                    for (const leg of accumulatedVetoedLegs) {
                        const label = [leg.rowId, leg.teamLabel].filter(Boolean).join(' ') || 'vetoed leg';
                        vetoLines.push(`  * ${label} (${leg.reason})`);
                    }
                }
                if (accumulatedVetoedClaims.length > 0) {
                    vetoLines.push('- Vetoed claims (DO NOT repeat in summary, opening analysis, insights, or pick reasons):');
                    for (const c of accumulatedVetoedClaims) {
                        vetoLines.push(`  * "${c}"`);
                    }
                }
                const vetoBlock = vetoLines.length > 0
                    ? `\n\n[VETOED LEGS & CLAIMS — DO NOT INCLUDE]:\n${vetoLines.join('\n')}`
                    : '';
                executePrompt = `${proposerPrompt}\n\n[Previous Verification Critique & Corrections Required (Attempt ${attempt - 1})]:\n${feedbackSummary}${vetoBlock}${freshBlock}\n\nCRITICAL RETRY RULES:\n1. Output a clean, standalone final JSON response as if writing it for the first time. NEVER mention "a previous error", "this correction", or prior attempts in your summary or analysis.\n2. Fix any factual misstatements (such as Away vs. Home team status in "Away @ Home" headers, or references to teams not in the selected legs) so they strictly match the Game Slate headers and Analyst Reports.\n3. Do NOT flip an analyst's recommended pick side (e.g. keep the analyst's selected team/spread and simply describe its Away/Home status accurately) unless the critic identified a fatal injury on that team.\n4. INJURY ATTRIBUTION RULE: Every injury citation must match the team_id or team name in the tool result or board. Never assign a player to the opposing team.\n5. MARKET AND ROW RULES: Cite the exact row ID matching the picked team, market, and line; never assign a row to the opposite team or opposite side.\n6. GROUNDING: Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result. If key players on that team are OUT, do not call the team relatively healthy. A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet. Do not cite a record, L2, or score unless it is in a successful tool result for that team. If you did not call the form tool, do not invent the record. If a tool returned data, do not say fundamentals or market data are missing. A pass is fine. Do not pad it with ungrounded form.\n7. PULL BEFORE PASS: Before saying a game has no fundamentals, injuries, or market data, call the tool for that game. If the tool returns data, use it and do not say it was not fetched. If the tool returns empty or errors, then you may say that game has no data. Do not cite a record, score, or L5 form unless it is in a successful tool result. A pass is allowed only after the relevant tools were called, or the tool result was empty.\n8. VETO STICKS: A Critic veto for ungrounded form, missing market, or fatal injury removes that leg. Do not repeat the vetoed claim in a later attempt or in the final analysis. Do not put a vetoed leg back into picks. If every leg is vetoed, the result is a pass.\n9. SPREAD SIDE: Read the sign from the row or the tool. A negative spread is the favorite. A positive spread is the underdog. Do not flip the sign when naming the other team. Portland +10.5 is not Portland -10.5.\n10. ${CRITIC_AUDIT_RULE}`;
            } else {
                executePrompt = proposerPrompt;
            }

            context.addEvent({
                agentRole: this.proposer.role,
                action: `Executing proposal (Attempt ${attempt})`,
                modelName: this.proposer.modelName,
                prompt: executePrompt
            });
            
            const proposalRaw = await this.proposer.run(executePrompt, context, {
                responseMimeType: 'application/json',
                bypassCache: attempt > 1,
                groqMode: 'chat'
            });
            
            currentProposal = parseJsonSafe(proposalRaw, { rawText: proposalRaw, error: "Failed to parse JSON" });

            if (effectiveCoveredEventIds && currentProposal && Array.isArray(currentProposal.picks)) {
                const headers = Array.isArray((rawData as any)?.allHeaders) && (rawData as any).allHeaders.length > 0
                    ? (rawData as any).allHeaders
                    : parseGameHeaders((rawData as any)?.fullBoard || rawData);
                const originalCount = currentProposal.picks.length;
                const allowedCoverageIds = verifiedEventIdsSet.size > 0
                    ? Array.from(verifiedEventIdsSet)
                    : effectiveCoveredEventIds;
                currentProposal.picks = filterPicksByCoverage(currentProposal.picks, allowedCoverageIds, headers);
                if (currentProposal.picks.length === 0 && originalCount > 0) {
                    currentProposal.ui_title = 'Insufficient data';
                    currentProposal.reason = 'no picks with specialist coverage';
                }
            }

            // 2. Critic verifies
            const CAP = seatBudget(this.critic.provider).maxPromptChars;
            const PROPOSAL_MAX = Math.min(3000, Math.floor(CAP * 0.35));
            const REMINDER = 'Do not call any tools or code-execution helpers. Reply only {"pass":boolean,"feedback":string}.';

            const toSampleText = (value: unknown): string => {
                if (value === null || value === undefined || value === '') return '';
                if (typeof value === 'string') return value;
                try {
                    return JSON.stringify(value, null, 2);
                } catch {
                    return String(value);
                }
            };

            const proposalText = toSampleText(currentProposal);
            const proposalSample = proposalText.length > PROPOSAL_MAX
                ? `${proposalText.slice(0, PROPOSAL_MAX).trimEnd().replace(/\s+\S*$/, '')}…[truncated]`
                : proposalText;

            const prePassedToolResults = typeof rawData === 'object' && rawData && 'toolResults' in rawData
                ? toSampleText((rawData as any).toolResults)
                : '';
            const prePassedToolItems: ToolEvidenceItem[] =
                typeof rawData === 'object' && rawData && Array.isArray((rawData as any).toolEvidenceItems)
                    ? (rawData as any).toolEvidenceItems
                    : [];

            const allParsedHeaders: GameHeader[] = Array.isArray((rawData as any)?.allHeaders) && (rawData as any).allHeaders.length > 0
                ? ((rawData as any).allHeaders as GameHeader[])
                : parseGameHeaders((rawData as any)?.fullBoard || rawData);
            const selectedGameIds = resolveDiscussedGameIds(currentProposal, allParsedHeaders, prePassedToolResults);
            const scopedHeaders = selectedGameIds.length > 0
                ? filterHeadersByEventIds(allParsedHeaders, selectedGameIds)
                : allParsedHeaders;

            let rawPulledText = '';
            const pulledItems: ToolEvidenceItem[] = [];
            const pulledMarketRecords = accumulatedMarketRecords;
            if (this.toolRegistry && selectedGameIds.length > 0) {
                const criticTools = [
                    'get_market_movement',
                    'get_injury_and_roster_delta',
                    'get_matchup_fundamentals',
                    'get_environment_and_weather'
                ].filter(t => this.toolRegistry!.has(t));
                if (criticTools.length > 0) {
                    const cache = this.queryCache ?? new GameQueryCache();
                    const headerById = new Map<string, GameHeader>(allParsedHeaders.map(h => [h.eventId, h]));
                    const pullCalls = selectedGameIds.flatMap(gId =>
                        criticTools.map(tool => ({ tool, gId }))
                    );
                    await Promise.all(
                        pullCalls.map(async ({ tool, gId }) => {
                            const hdr = headerById.get(gId);
                            const opts = hdr
                                ? {
                                      ...this.toolOptions,
                                      game: {
                                          event_id: hdr.eventId,
                                          ...(hdr.sport ? { sport: hdr.sport } : {}),
                                          home_team: hdr.home,
                                          away_team: hdr.away,
                                          home_team_abbr: hdr.home,
                                          away_team_abbr: hdr.away,
                                          ...(Array.isArray(hdr.options) && hdr.options.length > 0 ? { options: hdr.options } : {})
                                      }
                                  }
                                : this.toolOptions;
                            const params: Record<string, unknown> = tool === 'get_market_movement'
                                ? { game_id: gId, market_type: 'all' }
                                : { game_id: gId };
                            const res = await executeToolWithCacheAndTimeout(
                                { tool, parameters: params },
                                { game_id: gId },
                                this.toolRegistry!,
                                cache,
                                1500,
                                opts
                            );
                            context.addEvent({
                                agentRole: this.critic.role,
                                action: `Executed Tool: ${tool}`,
                                modelName: this.critic.modelName,
                                prompt: JSON.stringify(params),
                                tool,
                                output: res.success ? (res.data ?? res.summary) : { error: res.error },
                                durationMs: res.durationMs ?? 0
                            });
                            const status: ToolCallStatus = !res?.success
                                ? 'error'
                                : ((res as any).empty === true || isEmptyToolSummary(res?.summary || '') ? 'empty' : 'data');
                            accumulatedToolTrace.push({
                                tool,
                                eventId: gId,
                                status,
                                ...(typeof res?.summary === 'string' && res.summary.trim() ? { summary: res.summary.trim() } : {})
                            });
                            if (res?.success === true && typeof res.summary === 'string' && res.summary.trim().length > 0) {
                                pulledItems.push({
                                    tool,
                                    eventId: gId,
                                    summary: res.summary.trim()
                                });
                                if (tool === 'get_market_movement') {
                                    pushUniqueMarketRecord({
                                        tool,
                                        eventId: gId,
                                        summary: res.summary.trim(),
                                        ...(res.data !== undefined ? { data: res.data } : {}),
                                        ...(Array.isArray((res as any).markets_covered) ? { markets_covered: (res as any).markets_covered } : {})
                                    });
                                }
                                verifiedEventIdsSet.add(gId);
                            }
                        })
                    );
                    if (pulledItems.length > 0) {
                        rawPulledText = pulledItems.map(i => i.summary).join('\n\n');
                        context.addEvent({
                            agentRole: this.critic.role,
                            action: 'Scoped Critic Tool Pulls',
                            modelName: this.critic.modelName,
                            prompt: `selectedGames=${selectedGameIds.length}`,
                            output: { selectedGameIds, toolsPulled: pulledItems.length }
                        });
                    }
                }
            }

            const { mergedEvidenceText } = mergeScopedToolEvidence({
                prePassedItems: prePassedToolItems,
                pulledItems,
                toolCallTrace: accumulatedToolTrace,
                prePassedEvidenceText: prePassedToolResults,
                freshRetryEvidenceParts,
                selectedGameIds,
                slateSource: (rawData as any)?.fullBoard || rawData
            });
            const toolResults = mergedEvidenceText;
            const rawAnalystReports = typeof rawData === 'object' && rawData && 'analystReports' in rawData
                ? (rawData as any).analystReports
                : undefined;
            const analystReports = Array.isArray(rawAnalystReports)
                ? rawAnalystReports
                    .map((r: any) => {
                        if (typeof r === 'string') return r;
                        if (!r || typeof r !== 'object') return String(r ?? '');
                        const label = r.agent ?? r.seat ?? r.role ?? 'seat';
                        const text = r.summary ?? r.analysis ?? (Array.isArray(r.insights) ? r.insights.join('; ') : undefined);
                        return text ? `[${label}]: ${typeof text === 'string' ? text : toSampleText(text)}` : toSampleText(r);
                    })
                    .filter(Boolean)
                    .join('\n')
                : toSampleText(rawAnalystReports);
            const historicalBaselines = typeof rawData === 'object' && rawData && 'historicalBaselines' in rawData
                ? toSampleText((rawData as any).historicalBaselines)
                : '';
            const rawBoard = (selectedGameIds.length > 0 && scopedHeaders.length > 0)
                ? renderHeaders(scopedHeaders, 1600)
                : (typeof rawData === 'object' && rawData && 'rawBoard' in rawData
                    ? toSampleText((rawData as any).rawBoard)
                    : (typeof rawData === 'string' ? rawData : ''));

            const appComputedCounts = typeof rawData === 'object' && rawData && 'appComputedCounts' in rawData
                ? toSampleText((rawData as any).appComputedCounts)
                : '';

            const countsLine = appComputedCounts ? `\n${appComputedCounts}` : '';
            const retryContextLine = attempt > 1 && feedback
                ? `\n[Prior Critique From Attempt ${attempt - 1}]: ${feedback.slice(0, 280)}\nIf the revised [Proposal] resolved the prior critique and its recommended picks are grounded in the Game Slate and Analyst Reports, return {"pass":true,"feedback":"Verified after revision."}.`
                : '';
            const isExplicitEmptyPicksPass = Boolean(
                currentProposal &&
                typeof currentProposal === 'object' &&
                Array.isArray((currentProposal as any).picks) &&
                (currentProposal as any).picks.length === 0
            );
            const emptyPicksNote = isExplicitEmptyPicksPass
                ? '\nNote: If the [Proposal] recommends passing with an empty picks array (picks: []), that is a valid NO-BET / PASS; return {"pass":true,"feedback":"Valid pass / no-bet recommendation."} unless it contains ungrounded claims.'
                : '';
            const promptHeader = `${VERIFICATION_OUTPUT_CONTRACT}\n\n${criticPrompt}${countsLine}${retryContextLine}${emptyPicksNote}\n\nEvaluate the [Proposal] below against the [Tool Evidence] and [Analyst Reports Sample].`;
            let effectiveProposalSample = proposalSample;
            let proposalSection = `\n\n[Proposal]:\n${effectiveProposalSample}`;
            const trailer = `\n\n${REMINDER}`;
            let maxReportBudget = Math.max(0, CAP - (promptHeader.length + proposalSection.length + trailer.length + 2));

            // Keep [Tool Evidence] intact before trimming: give it full priority over secondary text
            // and, if needed under tight provider caps, modestly trim long proposal text before dropping tool evidence.
            const evPrefix = '[Tool Evidence]:\n';
            if (toolResults && evPrefix.length + toolResults.length > maxReportBudget) {
                const shortfall = evPrefix.length + toolResults.length - maxReportBudget;
                const minProposalChars = Math.min(effectiveProposalSample.length, 900);
                if (effectiveProposalSample.length > minProposalChars) {
                    const nextProposalLen = Math.max(minProposalChars, effectiveProposalSample.length - shortfall);
                    const cut = effectiveProposalSample.slice(0, nextProposalLen).trimEnd();
                    effectiveProposalSample = `${cut}…[truncated]`;
                    proposalSection = `\n\n[Proposal]:\n${effectiveProposalSample}`;
                    maxReportBudget = Math.max(0, CAP - (promptHeader.length + proposalSection.length + trailer.length + 2));
                }
            }
            const evidenceBudget = maxReportBudget;

            let evidenceSection = '';
            if (toolResults) {
                const fullEv = `${evPrefix}${toolResults}`;
                if (fullEv.length <= evidenceBudget) {
                    evidenceSection = fullEv;
                } else {
                    const groups = toolResults.split(/\n\n+/).filter(Boolean);
                    const selectedSet = new Set(selectedGameIds);
                    const isSelectedGroup = (g: string): boolean => {
                        if (selectedSet.size === 0) return false;
                        const firstLine = g.split(/\r?\n/)[0] || '';
                        for (const id of selectedSet) {
                            if (firstLine.includes(id)) return true;
                        }
                        return false;
                    };

                    // 1. First drop any trailing non-discussed game groups so discussed games stay intact
                    let keptGroups = [...groups];
                    let droppedCount = 0;
                    while (keptGroups.length > 0 && !isSelectedGroup(keptGroups[keptGroups.length - 1])) {
                        const suffix = droppedCount > 0 ? `\n\n[evidence truncated: ${droppedCount} games]` : '';
                        const candidate = `${evPrefix}${keptGroups.join('\n\n')}${suffix}`;
                        if (candidate.length <= evidenceBudget) {
                            evidenceSection = candidate;
                            break;
                        }
                        keptGroups.pop();
                        droppedCount++;
                    }
                    if (!evidenceSection && keptGroups.length > 0) {
                        const suffix = droppedCount > 0 ? `\n\n[evidence truncated: ${droppedCount} games]` : '';
                        const candidate = `${evPrefix}${keptGroups.join('\n\n')}${suffix}`;
                        if (candidate.length <= evidenceBudget) {
                            evidenceSection = candidate;
                        }
                    }

                    // 2. If all remaining discussed games still exceed evidenceBudget, compact proportionally
                    //    per game so every discussed game remains represented instead of dropping whole games.
                    if (!evidenceSection && keptGroups.length > 0) {
                        const suffix = droppedCount > 0 ? `\n\n[evidence truncated: ${droppedCount} games]` : '';
                        const bodyBudget = evidenceBudget - evPrefix.length - suffix.length;
                        const sepOverhead = 2 * (keptGroups.length - 1);
                        if (bodyBudget - sepOverhead >= keptGroups.length * 60) {
                            const n = keptGroups.length;
                            const used = new Array<number>(n).fill(0);
                            let remaining = bodyBudget - sepOverhead;
                            let active = keptGroups.map((_, i) => i);
                            while (active.length > 0 && remaining > 0) {
                                const share = Math.floor(remaining / active.length);
                                if (share <= 0) {
                                    for (const i of active) {
                                        if (remaining <= 0) break;
                                        if (used[i] < keptGroups[i].length) {
                                            used[i]++;
                                            remaining--;
                                        }
                                    }
                                    break;
                                }
                                let sat = 0;
                                const nextActive: number[] = [];
                                for (const i of active) {
                                    const need = keptGroups[i].length - used[i];
                                    if (need <= share) {
                                        used[i] += need;
                                        remaining -= need;
                                        sat++;
                                    } else {
                                        nextActive.push(i);
                                    }
                                }
                                if (sat === 0) {
                                    for (const i of active) {
                                        used[i] += share;
                                        remaining -= share;
                                    }
                                    break;
                                }
                                active = nextActive;
                            }
                            const compacted = keptGroups.map((g, i) => {
                                const cap = used[i];
                                if (cap >= g.length) return g;
                                return cap > 16 ? `${g.slice(0, cap - 1).trimEnd()}…` : g.slice(0, cap);
                            });
                            const compactedCandidate = `${evPrefix}${compacted.join('\n\n')}${suffix}`;
                            if (compactedCandidate.length <= evidenceBudget) {
                                evidenceSection = compactedCandidate;
                            }
                        }
                    }

                    // 3. Last-resort fallback if evidenceBudget is extremely tiny
                    if (!evidenceSection) {
                        while (keptGroups.length > 0) {
                            const suffix = droppedCount > 0 ? `\n\n[evidence truncated: ${droppedCount} games]` : '';
                            const candidate = `${evPrefix}${keptGroups.join('\n\n')}${suffix}`;
                            if (candidate.length <= evidenceBudget) {
                                evidenceSection = candidate;
                                break;
                            }
                            keptGroups.pop();
                            droppedCount++;
                        }
                    }
                    if (!evidenceSection) {
                        const fallbackMsg = `${evPrefix}[evidence truncated: ${groups.length} games]`;
                        evidenceSection = fallbackMsg.length <= evidenceBudget ? fallbackMsg : '';
                    }
                }
            }

            const secondaryParts = [
                analystReports ? `[Analyst Reports Sample]:\n${analystReports}` : '',
                historicalBaselines ? `[Historical Baselines & Past Lessons]:\n${historicalBaselines}` : '',
                rawBoard ? `[Raw Board Sample]:\n${rawBoard}` : ''
            ].filter(Boolean);
            const secondaryText = secondaryParts.join('\n\n');
            const remainingForSecondary = Math.max(0, maxReportBudget - evidenceSection.length - (evidenceSection ? 2 : 0));
            const limitedSecondary = secondaryText && remainingForSecondary > 20
                ? (secondaryText.length > remainingForSecondary
                    ? `${secondaryText.slice(0, Math.max(0, remainingForSecondary - 1)).trimEnd().replace(/\s+\S*$/, '')}…`
                    : secondaryText)
                : '';

            const limitedReportSample = [evidenceSection, limitedSecondary].filter(Boolean).join('\n\n');
            const verifyPrompt = `${promptHeader}${proposalSection}\n\n${limitedReportSample}${trailer}`;
            if (verifyPrompt.length > CAP) {
                throw new Error(`Verification prompt exceeded budget cap (${verifyPrompt.length} > ${CAP}).`);
            }

            context.addEvent({
                agentRole: this.critic.role,
                action: `Verifying proposal from attempt ${attempt}`,
                modelName: this.critic.modelName,
                prompt: `verifyPromptChars=${verifyPrompt.length}, evidenceChars=${evidenceSection.length}`
            });

            const verificationRaw = await this.critic.run(verifyPrompt, context, {
                responseMimeType: 'application/json',
                bypassCache: true,
                timeoutMs: 45000
            });
            
            let verification: VerificationResult = guardVerificationResult(verificationRaw);
            if (verification.parseFailed) {
                console.warn(`[Critic] unparsed verification output (attempt ${attempt}): ${redactForLog(String(verificationRaw)).slice(0, 300)}`);
            }

            const boardSourceForEarlyAudit = (rawData as any)?.fullBoard || rawData || '';
            const proposedLegsThisAttempt = extractProposedPickSummaries(
                currentProposal,
                allParsedHeaders,
                boardSourceForEarlyAudit
            );
            if (proposedLegsThisAttempt.length > 0) {
                anyAttemptHadProposedPicks = true;
            } else if (
                !verification.pass &&
                /\b(?:no\s+(?:specific\s+)?picks|picks\s+array\s+is\s+empty|no\s+legs\s+to\s+audit|fails?\s+to\s+include\s+(?:any\s+)?(?:specific\s+)?picks|required\s+pick\s+objects\s+were\s+not\s+provided|no\s+picks\s+to\s+evaluate)\b/i.test(verification.feedback || '')
            ) {
                verification = {
                    ...verification,
                    pass: true,
                    feedback: 'Verified valid no-bet / pass recommendation (empty picks).'
                };
            }

            // CRITIC AUDIT: "No picks to evaluate" is invalid when picks are non-empty.
            // Re-prompt the Verification Critic once on the same attempt with the explicit pick list.
            if (proposedLegsThisAttempt.length > 0 && isNoPicksToEvaluateText(verification.feedback)) {
                const repromptDirective = buildCriticAuditReprompt(proposedLegsThisAttempt, 'lifecycle');
                const evHead = evidenceSection ? `\n\n${evidenceSection}` : '';
                const maxEvForReprompt = Math.max(0, CAP - repromptDirective.length - trailer.length - 40);
                const clippedEv = evHead && maxEvForReprompt > 60 ? evHead.slice(0, maxEvForReprompt) : '';
                const repromptVerify = `${repromptDirective}${clippedEv}${trailer}`.slice(0, CAP);
                try {
                    const initialFb = verification.feedback;
                    const repromptRaw = await this.critic.run(repromptVerify, context, {
                        responseMimeType: 'application/json',
                        bypassCache: true,
                        timeoutMs: 45000
                    });
                    verification = guardVerificationResult(repromptRaw);
                    context.addEvent({
                        agentRole: this.critic.role,
                        action: 'Re-prompted Verification Critic (Invalid "No picks to evaluate")',
                        modelName: this.critic.modelName,
                        prompt: `attempt=${attempt}, proposedLegs=${proposedLegsThisAttempt.length}`,
                        output: {
                            initialFeedback: initialFb,
                            revisedPass: verification.pass,
                            revisedFeedback: verification.feedback
                        }
                    });
                } catch {
                    // Fall through to audit coverage check below
                }
            }

            const llmAuditCoverage = evaluateCriticAuditCoverage({
                proposedLegs: proposedLegsThisAttempt,
                criticResponseText: verification.feedback || '',
                criticParseFailed: verification.parseFailed,
                criticPass: verification.pass
            });
            lastAttemptCriticAuditFailed = llmAuditCoverage.criticSkippedAudit;
            lastAttemptUnauditedLegs = llmAuditCoverage.unauditedLegs;

            // Deterministic Critic Check: A claim that cites no field in the game slate or tool results,
            // or attributes an injury to the wrong team (INJURY ATTRIBUTION RULE), is a veto.
            if (currentProposal) {
                const slateHeaders = renderHeaders(scopedHeaders);
                const toolResultsSummary = toolResults;
                const traceDataText = accumulatedToolTrace
                    .filter(e => e && e.status === 'data' && typeof e.summary === 'string' && e.summary.trim().length > 0)
                    .map(e => e.summary!.trim())
                    .join('\n\n');
                const combinedToolSummary = [
                    toolResultsSummary,
                    prePassedToolResults,
                    rawPulledText,
                    traceDataText,
                    ...freshRetryEvidenceParts
                ]
                    .filter(Boolean)
                    .join('\n\n');
                if (combinedToolSummary) {
                    lastCombinedToolSummary = combinedToolSummary;
                }
                const allowedSourceText = `${slateHeaders}\n${combinedToolSummary}`.trim();
                const fallbackBoardText = typeof rawData === 'string'
                    ? rawData
                    : (rawData?.rawBoard || rawData?.dataSample || JSON.stringify(rawData || ''));

                const injuryAudit = auditInjuryAttribution(
                    currentProposal,
                    `${combinedToolSummary}\n${analystReports}`,
                    slateHeaders || fallbackBoardText
                );
                if (!injuryAudit.pass) {
                    verification.pass = false;
                    verification.feedback = injuryAudit.feedback || 'Veto: Proposal attributed an injury to the wrong team.';
                }

                const boardSourceForAudit = (rawData as any)?.fullBoard || rawData || slateHeaders || fallbackBoardText;
                const marketRowAudit = auditMarketCoverageAndRowBinding(
                    currentProposal,
                    combinedToolSummary,
                    boardSourceForAudit,
                    allParsedHeaders,
                    pulledMarketRecords
                );
                if (!marketRowAudit.pass) {
                    verification.pass = false;
                    verification.feedback = marketRowAudit.feedback || 'Veto: Row side mismatch or missing market coverage.';
                }

                const auditRowMap = extractRowOptions([boardSourceForAudit], allParsedHeaders);
                const groundingAudit = auditClaimGrounding(
                    currentProposal,
                    combinedToolSummary,
                    boardSourceForAudit,
                    {
                        headers: allParsedHeaders,
                        vetoTexts: accumulatedVetoTexts,
                        vetoedLegs: accumulatedVetoedLegs,
                        vetoedClaims: accumulatedVetoedClaims
                    }
                );
                if (!groundingAudit.pass) {
                    verification.pass = false;
                    const gMsg = groundingAudit.feedback || 'Veto (GROUNDING): Ungrounded claim or vetoed leg rewrite.';
                    verification.feedback = (injuryAudit.pass && marketRowAudit.pass)
                        ? gMsg
                        : [verification.feedback, gMsg].filter(Boolean).join(' ');
                }

                // Merge structured veto targets from deterministic audits immediately into the cumulative ledger
                accumulatedVetoedLegs = mergeVetoedLegTargets(
                    accumulatedVetoedLegs,
                    injuryAudit.vetoedLegs,
                    marketRowAudit.vetoedLegs,
                    groundingAudit.vetoedLegs
                );
                accumulatedVetoedClaims = mergeVetoedClaims(
                    accumulatedVetoedClaims,
                    groundingAudit.vetoedClaims
                );

                accumulatedToolTrace = mergeToolCallTraceEntries(accumulatedToolTrace);
                const availableSportsTools = this.toolRegistry
                    ? ['get_matchup_fundamentals', 'get_injury_and_roster_delta', 'get_market_movement'].filter(t => this.toolRegistry!.has(t))
                    : [];
                const pullAudit = auditPullBeforePass(
                    currentProposal,
                    combinedToolSummary,
                    boardSourceForAudit,
                    {
                        headers: allParsedHeaders,
                        toolCallTrace: accumulatedToolTrace,
                        availableTools: availableSportsTools,
                        marketToolRecords: pulledMarketRecords
                    }
                );
                if (!pullAudit.pass) {
                    let newlyPulledCount = 0;
                    if (this.toolRegistry && pullAudit.unqueriedGameIds.length > 0) {
                        const cache = this.queryCache ?? new GameQueryCache();
                        const headerById = new Map<string, GameHeader>(allParsedHeaders.map(h => [h.eventId, h]));
                        const missingCalls: Array<{ tool: string; gId: string }> = [];
                        for (const gId of pullAudit.unqueriedGameIds.slice(0, 8)) {
                            const toolsForGame = pullAudit.missingToolsByGame[gId] || availableSportsTools;
                            for (const tool of toolsForGame) {
                                if (this.toolRegistry.has(tool)) {
                                    missingCalls.push({ tool, gId });
                                }
                            }
                        }
                        if (missingCalls.length > 0) {
                            const newlyPulled: string[] = [];
                            await Promise.all(
                                missingCalls.map(async ({ tool, gId }) => {
                                    const hdr = headerById.get(gId);
                                    const opts = hdr
                                        ? {
                                              ...this.toolOptions,
                                              game: {
                                                  event_id: hdr.eventId,
                                                  ...(hdr.sport ? { sport: hdr.sport } : {}),
                                                  home_team: hdr.home,
                                                  away_team: hdr.away,
                                                  home_team_abbr: hdr.home,
                                                  away_team_abbr: hdr.away,
                                                  ...(Array.isArray(hdr.options) && hdr.options.length > 0 ? { options: hdr.options } : {})
                                              }
                                          }
                                        : this.toolOptions;
                                    const params: Record<string, unknown> = tool === 'get_market_movement'
                                        ? { game_id: gId, market_type: 'all' }
                                        : { game_id: gId };
                                    const res = await executeToolWithCacheAndTimeout(
                                        { tool, parameters: params },
                                        { game_id: gId },
                                        this.toolRegistry!,
                                        cache,
                                        1500,
                                        opts
                                    );
                                    context.addEvent({
                                        agentRole: this.critic.role,
                                        action: `Executed Tool: ${tool}`,
                                        modelName: this.critic.modelName,
                                        prompt: JSON.stringify(params),
                                        tool,
                                        output: res.success ? (res.data ?? res.summary) : { error: res.error },
                                        durationMs: res.durationMs ?? 0
                                    });
                                    const status: ToolCallStatus = !res?.success
                                        ? 'error'
                                        : ((res as any).empty === true || isEmptyToolSummary(res?.summary || '') ? 'empty' : 'data');
                                    accumulatedToolTrace.push({
                                        tool,
                                        eventId: gId,
                                        status,
                                        ...(typeof res?.summary === 'string' && res.summary.trim() ? { summary: res.summary.trim() } : {})
                                    });
                                    if (res?.success === true && typeof res.summary === 'string' && res.summary.trim().length > 0) {
                                        const cleanSum = res.summary.trim();
                                        newlyPulled.push(cleanSum);
                                        verifiedEventIdsSet.add(gId);
                                        if (tool === 'get_market_movement') {
                                            pushUniqueMarketRecord({
                                                tool,
                                                eventId: gId,
                                                summary: cleanSum,
                                                ...(res.data !== undefined ? { data: res.data } : {}),
                                                ...(Array.isArray((res as any).markets_covered) ? { markets_covered: (res as any).markets_covered } : {})
                                            });
                                        }
                                    }
                                })
                            );
                            accumulatedToolTrace = mergeToolCallTraceEntries(accumulatedToolTrace);
                            if (newlyPulled.length > 0) {
                                newlyPulledCount = newlyPulled.length;
                                freshRetryEvidenceParts.push(...newlyPulled);
                                lastCombinedToolSummary = [lastCombinedToolSummary, ...newlyPulled].filter(Boolean).join('\n\n');
                            }
                        }
                    }
                    verification.pass = false;
                    const pMsg = pullAudit.feedback || 'Veto (PULL BEFORE PASS): Tools must be called before passing or claiming missing data.';
                    const pullNote = newlyPulledCount > 0
                        ? ' Missing tools were just pulled; use the [Fresh Tool Evidence Pulled Before Retry] above.'
                        : '';
                    const allPriorPassed = injuryAudit.pass && marketRowAudit.pass && groundingAudit.pass;
                    verification.feedback = allPriorPassed
                        ? `${pMsg}${pullNote}`
                        : [verification.feedback, `${pMsg}${pullNote}`].filter(Boolean).join(' ');
                } else if (
                    !verification.pass &&
                    injuryAudit.pass &&
                    marketRowAudit.pass &&
                    groundingAudit.pass &&
                    pullAudit.pass &&
                    isFalseMissingMoneylineCritique(
                        verification.feedback,
                        currentProposal,
                        combinedToolSummary,
                        boardSourceForAudit,
                        allParsedHeaders,
                        pulledMarketRecords
                    )
                ) {
                    verification.pass = true;
                    verification.feedback = 'Verified: moneyline covered by ml_home/ml_away in market tool result.';
                } else if (
                    !verification.pass &&
                    injuryAudit.pass &&
                    marketRowAudit.pass &&
                    groundingAudit.pass &&
                    pullAudit.pass &&
                    isFalseHallucinationCritique(
                        verification.feedback,
                        currentProposal,
                        combinedToolSummary,
                        {
                            headers: allParsedHeaders,
                            toolCallTrace: accumulatedToolTrace,
                            marketToolRecords: pulledMarketRecords,
                            slateText: typeof boardSourceForAudit === 'string' ? boardSourceForAudit : slateHeaders
                        }
                    )
                ) {
                    const originalFeedback = verification.feedback;
                    verification.pass = true;
                    verification.feedback = 'Verified: cited injury, market, or form claims confirmed by successful run tool trace.';
                    context.addEvent({
                        agentRole: this.critic.role,
                        action: 'Dismissed False Hallucination Veto',
                        modelName: this.critic.modelName,
                        prompt: `attempt=${attempt}`,
                        output: { dismissedFeedback: originalFeedback }
                    });
                }

                if (verification.pass) {
                    const verificationSource = (allowedSourceText || fallbackBoardText).toLowerCase();

                    const candidateClaims = Array.isArray(currentProposal.arguments)
                        ? currentProposal.arguments
                        : (Array.isArray(currentProposal.claims) ? currentProposal.claims : []);

                    if (candidateClaims.length > 0 && verificationSource) {
                        for (const arg of candidateClaims) {
                            const claimSupporting = typeof arg === 'object' && arg !== null
                                ? (arg.supportingData || arg.field || arg.claim || '')
                                : String(arg);
                            if (!claimSupporting || !claimSupporting.trim()) {
                                verification.pass = false;
                                verification.feedback = 'Veto: Claim cites no field in the source data.';
                                break;
                            }
                            const tokens = String(claimSupporting).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
                            const citesField = tokens.some(tok => verificationSource.includes(tok));
                            if (!citesField && tokens.length > 0) {
                                verification.pass = false;
                                verification.feedback = `Veto: Claim "${String(claimSupporting).slice(0, 80)}" cites no field in the source data.`;
                                break;
                            }
                        }
                    }
                }
                if (llmAuditCoverage.criticSkippedAudit) {
                    verification.pass = false;
                    const auditFailMsg = llmAuditCoverage.auditNote || 'Veto (CRITIC AUDIT): Critic did not evaluate proposed picks.';
                    const existingNonSkip = verification.feedback && !isNoPicksToEvaluateText(verification.feedback)
                        ? verification.feedback
                        : '';
                    verification.feedback = existingNonSkip
                        ? `${existingNonSkip} ${auditFailMsg}`.trim()
                        : auditFailMsg;
                } else if (proposedLegsThisAttempt.length > 0 && isNoPicksToEvaluateText(verification.feedback)) {
                    verification.feedback = verification.pass
                        ? 'Verified proposed picks against tool evidence and slate rows.'
                        : 'Veto (CRITIC AUDIT): Proposed picks failed verification.';
                }

                if (!verification.pass && verification.feedback) {
                    if (!accumulatedVetoTexts.includes(verification.feedback)) {
                        accumulatedVetoTexts.push(verification.feedback);
                    }
                    accumulatedVetoedLegs = mergeVetoedLegTargets(
                        accumulatedVetoedLegs,
                        extractVetoedLegTargets([verification.feedback], allParsedHeaders, auditRowMap)
                    );
                    accumulatedVetoedClaims = mergeVetoedClaims(
                        accumulatedVetoedClaims,
                        extractQuotedVetoedClaims([verification.feedback])
                    );
                }
            }

            // 3. Pass/Fail evaluation
            if (verification.pass) {
                const computedRating = AnalysisLifecycle.computeReinforcementScore(true, attempt, this.maxRetries);
                context.addEvent({
                    agentRole: this.critic.role,
                    action: `Verification PASSED on attempt ${attempt} (RLAIF Rating: ${(computedRating * 100).toFixed(0)}%).`,
                    modelName: this.critic.modelName,
                    prompt: "[Internal Verification Result]",
                    output: { attempts: attempt, computedRating, feedback: verification.feedback }
                });
                return {
                    success: true,
                    attempts: attempt,
                    finalProposal: currentProposal,
                    criticFeedback: verification.feedback,
                    computedRating,
                    verifiedEventIds: Array.from(verifiedEventIdsSet),
                    ...(lastCombinedToolSummary ? { verifiedToolEvidence: lastCombinedToolSummary } : {}),
                    ...(accumulatedMarketRecords.length > 0 ? { verifiedMarketToolRecords: accumulatedMarketRecords } : {}),
                    ...(accumulatedToolTrace.length > 0 ? { verifiedToolTrace: mergeToolCallTraceEntries(accumulatedToolTrace) } : {}),
                    ...(accumulatedVetoedLegs.length > 0 ? { vetoedLegs: accumulatedVetoedLegs } : {}),
                    ...(accumulatedVetoedClaims.length > 0 ? { vetoedClaims: accumulatedVetoedClaims } : {}),
                    ...(accumulatedVetoTexts.length > 0 ? { accumulatedVetoes: accumulatedVetoTexts } : {}),
                    criticAuditFailed: false,
                    ...(anyAttemptHadProposedPicks ? { hadProposedPicks: true } : {})
                };
            } else {
                feedback = verification.feedback || "Proposal failed verification without specific feedback.";
                context.addEvent({
                    agentRole: this.critic.role,
                    action: `Verification FAILED on attempt ${attempt}. Feedback: ${feedback}`,
                    modelName: this.critic.modelName,
                    prompt: "[Internal Verification Result]"
                });
            }
        }

        // If we exhaust retries without passing
        const computedRating = AnalysisLifecycle.computeReinforcementScore(false, attempt, this.maxRetries);
        context.addEvent({
            agentRole: 'system',
            action: `Exhausted ${this.maxRetries} retries. Proposer failed to pass verification (RLAIF Rating: ${(computedRating * 100).toFixed(0)}%).`,
            modelName: 'system',
            prompt: "[System Error]",
            output: { attempts: attempt, computedRating, feedback }
        });
        
        return {
            success: false,
            attempts: attempt,
            finalProposal: currentProposal,
            criticFeedback: feedback,
            computedRating,
            verifiedEventIds: Array.from(verifiedEventIdsSet),
            ...(lastCombinedToolSummary ? { verifiedToolEvidence: lastCombinedToolSummary } : {}),
            ...(accumulatedMarketRecords.length > 0 ? { verifiedMarketToolRecords: accumulatedMarketRecords } : {}),
            ...(accumulatedToolTrace.length > 0 ? { verifiedToolTrace: mergeToolCallTraceEntries(accumulatedToolTrace) } : {}),
            ...(accumulatedVetoedLegs.length > 0 ? { vetoedLegs: accumulatedVetoedLegs } : {}),
            ...(accumulatedVetoedClaims.length > 0 ? { vetoedClaims: accumulatedVetoedClaims } : {}),
            ...(accumulatedVetoTexts.length > 0 ? { accumulatedVetoes: accumulatedVetoTexts } : {}),
            ...(lastAttemptCriticAuditFailed ? { criticAuditFailed: true } : {}),
            ...(lastAttemptUnauditedLegs.length > 0 ? { unauditedLegs: lastAttemptUnauditedLegs } : {}),
            ...(anyAttemptHadProposedPicks ? { hadProposedPicks: true } : {})
        };
    }
}
