import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { parseJsonSafe, guardVerificationResult } from './parser.ts';
import { redactForLog } from './parser/responseGuards.ts';
import { groqPromptCharCap } from './providers/groq.ts';
import { seatBudget } from './context/promptBudget.ts';
import { parseGameHeaders, renderHeaders, filterPicksByCoverage, type GameHeader } from './context/gameHeaders.ts';
import { resolveSelectedGameIds, filterHeadersByEventIds } from './context/selectedGames.ts';
import { auditInjuryAttribution } from './tools/injuryAttribution.ts';
import { auditClaimGrounding } from './tools/claimGrounding.ts';
import {
    auditMarketCoverageAndRowBinding,
    isFalseMissingMoneylineCritique,
    type MarketToolRecord
} from './tools/marketRowBinding.ts';
import type { ToolRegistry } from './tools/registry.ts';
import { GameQueryCache } from './cache/gameQueryCache.ts';
import { executeToolWithCacheAndTimeout } from './engine/triageExecutor.ts';
import { buildVerifierEvidence } from './engine/verifierEvidence.ts';
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
        const verifiedEventIdsSet = new Set<string>(coveredEventIds || []);

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
                executePrompt = `${proposerPrompt}\n\n[Previous Verification Critique & Corrections Required (Attempt ${attempt - 1})]:\n${feedbackSummary}\n\nCRITICAL RETRY RULES:\n1. Output a clean, standalone final JSON response as if writing it for the first time. NEVER mention "a previous error", "this correction", or prior attempts in your summary or analysis.\n2. Fix any factual misstatements (such as Away vs. Home team status in "Away @ Home" headers, or references to teams not in the selected legs) so they strictly match the Game Slate headers and Analyst Reports.\n3. Do NOT flip an analyst's recommended pick side (e.g. keep the analyst's selected team/spread and simply describe its Away/Home status accurately) unless the critic identified a fatal injury on that team.\n4. INJURY ATTRIBUTION RULE: Every injury citation must match the team_id or team name in the tool result or board. Never assign a player to the opposing team.\n5. MARKET AND ROW RULES: Cite the exact row ID matching the picked team, market, and line; never assign a row to the opposite team or opposite side.\n6. GROUNDING: Do not cite a score, goals-allowed, or health claim unless it is in a successful tool result. If key players on that team are OUT, do not call the team relatively healthy. A vetoed leg is removed from picks. Do not rewrite it as a recommended single bet.`;
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
                currentProposal.picks = filterPicksByCoverage(currentProposal.picks, effectiveCoveredEventIds, headers);
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

            const allParsedHeaders: GameHeader[] = Array.isArray((rawData as any)?.allHeaders) && (rawData as any).allHeaders.length > 0
                ? ((rawData as any).allHeaders as GameHeader[])
                : parseGameHeaders((rawData as any)?.fullBoard || rawData);
            const selectedGameIds = resolveSelectedGameIds(currentProposal, allParsedHeaders);
            const scopedHeaders = selectedGameIds.length > 0
                ? filterHeadersByEventIds(allParsedHeaders, selectedGameIds)
                : allParsedHeaders;

            let scopedToolResults = '';
            const pulledMarketRecords: MarketToolRecord[] = Array.isArray((rawData as any)?.marketToolRecords)
                ? [...(rawData as any).marketToolRecords]
                : [];
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
                    const pulledItems: ToolEvidenceItem[] = [];
                    await Promise.all(
                        pullCalls.map(async ({ tool, gId }) => {
                            const hdr = headerById.get(gId);
                            const opts = hdr
                                ? {
                                      ...this.toolOptions,
                                      game: {
                                          event_id: hdr.eventId,
                                          home_team: hdr.home,
                                          away_team: hdr.away,
                                          home_team_abbr: hdr.home,
                                          away_team_abbr: hdr.away
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
                            if (res?.success === true && typeof res.summary === 'string' && res.summary.trim().length > 0) {
                                pulledItems.push({
                                    tool,
                                    eventId: gId,
                                    summary: res.summary.trim()
                                });
                                if (tool === 'get_market_movement') {
                                    pulledMarketRecords.push({
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
                        scopedToolResults = buildVerifierEvidence([{ toolEvidenceItems: pulledItems }], rawData)
                            || pulledItems.map(i => i.summary).join('\n\n');
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

            const toolResults = scopedToolResults || prePassedToolResults;
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
            const promptHeader = `${VERIFICATION_OUTPUT_CONTRACT}\n\n${criticPrompt}${countsLine}${retryContextLine}\n\nEvaluate the [Proposal] below against the [Tool Evidence] and [Analyst Reports Sample].`;
            const proposalSection = `\n\n[Proposal]:\n${proposalSample}`;
            const trailer = `\n\n${REMINDER}`;
            const maxReportBudget = Math.max(0, CAP - (promptHeader.length + proposalSection.length + trailer.length + 2));
            const digestReserve = analystReports ? Math.min(900, Math.floor(maxReportBudget * 0.2)) : 0;
            const evidenceBudget = Math.max(0, maxReportBudget - digestReserve);

            let evidenceSection = '';
            if (toolResults) {
                const evPrefix = '[Tool Evidence]:\n';
                const fullEv = `${evPrefix}${toolResults}`;
                if (fullEv.length <= evidenceBudget) {
                    evidenceSection = fullEv;
                } else {
                    const groups = toolResults.split(/\n\n+/).filter(Boolean);
                    let keptGroups = [...groups];
                    let droppedCount = 0;
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
            
            const verification: VerificationResult = guardVerificationResult(verificationRaw);
            if (verification.parseFailed) {
                console.warn(`[Critic] unparsed verification output (attempt ${attempt}): ${redactForLog(String(verificationRaw)).slice(0, 300)}`);
            }

            // Deterministic Critic Check: A claim that cites no field in the game slate or tool results,
            // or attributes an injury to the wrong team (INJURY ATTRIBUTION RULE), is a veto.
            if (currentProposal) {
                const slateHeaders = renderHeaders(scopedHeaders);
                const toolResultsSummary = toolResults;
                const allowedSourceText = `${slateHeaders}\n${toolResultsSummary}`.trim();
                const fallbackBoardText = typeof rawData === 'string'
                    ? rawData
                    : (rawData?.rawBoard || rawData?.dataSample || JSON.stringify(rawData || ''));

                const injuryAudit = auditInjuryAttribution(
                    currentProposal,
                    `${toolResultsSummary}\n${analystReports}`,
                    slateHeaders || fallbackBoardText
                );
                if (!injuryAudit.pass) {
                    verification.pass = false;
                    verification.feedback = injuryAudit.feedback || 'Veto: Proposal attributed an injury to the wrong team.';
                }

                const boardSourceForAudit = (rawData as any)?.fullBoard || rawData || slateHeaders || fallbackBoardText;
                const combinedToolSummary = [toolResultsSummary, prePassedToolResults].filter(Boolean).join('\n\n');
                if (combinedToolSummary) {
                    lastCombinedToolSummary = combinedToolSummary;
                }
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

                const vetoTexts = [
                    ...(Array.isArray((rawData as any)?.criticVetoes) ? (rawData as any).criticVetoes : []),
                    ...(attempt > 1 && feedback ? [feedback] : [])
                ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
                const groundingAudit = auditClaimGrounding(
                    currentProposal,
                    combinedToolSummary,
                    boardSourceForAudit,
                    { headers: allParsedHeaders, vetoTexts }
                );
                if (!groundingAudit.pass) {
                    verification.pass = false;
                    const gMsg = groundingAudit.feedback || 'Veto (GROUNDING): Ungrounded claim or vetoed leg rewrite.';
                    verification.feedback = (injuryAudit.pass && marketRowAudit.pass)
                        ? gMsg
                        : [verification.feedback, gMsg].filter(Boolean).join(' ');
                } else if (
                    !verification.pass &&
                    injuryAudit.pass &&
                    marketRowAudit.pass &&
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
                    ...(lastCombinedToolSummary ? { verifiedToolEvidence: lastCombinedToolSummary } : {})
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
            ...(lastCombinedToolSummary ? { verifiedToolEvidence: lastCombinedToolSummary } : {})
        };
    }
}
