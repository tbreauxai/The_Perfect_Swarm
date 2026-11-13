import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { parseJsonSafe, guardVerificationResult } from './parser.ts';
import { redactForLog } from './parser/responseGuards.ts';
import { groqPromptCharCap } from './providers/groq.ts';

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
}

export class AnalysisLifecycle {
    private proposer: Agent;
    private critic: Agent;
    private maxRetries: number;

    constructor(
        proposer: Agent,
        critic: Agent,
        maxRetries: number = 3
    ) {
        this.proposer = proposer;
        this.critic = critic;
        this.maxRetries = maxRetries;
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
        criticPrompt: string
    ): Promise<LifecycleExecutionResult> {
        let attempt = 0;
        let currentProposal: any = null;
        let feedback = "";

        while (attempt < this.maxRetries) {
            attempt++;
            
            // 1. Proposer executes (incorporating feedback if this is a retry)
            let executePrompt: string;
            if (feedback) {
                const feedbackSummary = feedback.length > 2000 ? `${feedback.slice(0, 2000)}...` : feedback;
                const rawDataSnippet = proposerPrompt.includes('[Raw Data]') || proposerPrompt.includes('Analyst Reports')
                    ? ''
                    : `\n\n[Raw Data Context]:\n${typeof rawData === 'string' ? rawData.slice(0, 2500) : JSON.stringify(rawData).slice(0, 2500)}`;
                executePrompt = `${proposerPrompt}\n\n[Previous Verification Critique & Corrections Required (Attempt ${attempt - 1})]:\n${feedbackSummary}${rawDataSnippet}\n\nPlease revise your proposal to address the critic's feedback while preserving valid insights.`;
            } else {
                const rawDataSection = proposerPrompt.includes('[Raw Data]') || proposerPrompt.includes('Analyst Reports')
                    ? ''
                    : `\n\n[Raw Data]:\n${typeof rawData === 'string' ? rawData.slice(0, 4000) : JSON.stringify(rawData).slice(0, 4000)}`;
                executePrompt = `${proposerPrompt}${rawDataSection}`;
            }

            context.addEvent({
                agentRole: this.proposer.role,
                action: `Executing proposal (Attempt ${attempt})`,
                modelName: this.proposer.modelName,
                prompt: executePrompt
            });
            
            const proposalRaw = await this.proposer.run(executePrompt, context, {
                responseMimeType: 'application/json',
                bypassCache: attempt > 1
            });
            
            currentProposal = parseJsonSafe(proposalRaw, { rawText: proposalRaw, error: "Failed to parse JSON" });

            // 2. Critic verifies
            context.addEvent({
                agentRole: this.critic.role,
                action: `Verifying proposal from attempt ${attempt}`,
                modelName: this.critic.modelName,
                prompt: "[Internal Verification]"
            });
            
            const CAP = groqPromptCharCap(undefined);
            const PROPOSAL_MAX = 3000;
            const REMINDER = 'Reply only {"pass":boolean,"feedback":string}.';

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

            const analystReports = typeof rawData === 'object' && rawData && 'analystReports' in rawData
                ? toSampleText((rawData as any).analystReports)
                : '';
            const historicalBaselines = typeof rawData === 'object' && rawData && 'historicalBaselines' in rawData
                ? toSampleText((rawData as any).historicalBaselines)
                : '';
            const rawBoard = typeof rawData === 'object' && rawData && 'rawBoard' in rawData
                ? toSampleText((rawData as any).rawBoard)
                : (typeof rawData === 'string' ? rawData : '');

            const reportSampleParts = [
                analystReports ? `[Analyst Reports Sample]:\n${analystReports}` : '',
                historicalBaselines ? `[Historical Baselines & Past Lessons]:\n${historicalBaselines}` : '',
                rawBoard ? `[Raw Board Sample]:\n${rawBoard}` : ''
            ].filter(Boolean);
            const reportSample = reportSampleParts.join('\n\n');

            const promptHeader = `${VERIFICATION_OUTPUT_CONTRACT}\n\n${criticPrompt}\n\nEvaluate the [Proposal] below against the [Analyst Reports Sample].`;
            const proposalSection = `\n\n[Proposal]:\n${proposalSample}`;
            const reportSection = `\n\n[Analyst Reports Sample]:\n`;
            const trailer = `\n\n${REMINDER}`;
            const maxReportBudget = CAP - (promptHeader.length + proposalSection.length + reportSection.length + trailer.length);
            const limitedReportSample = reportSample.length > maxReportBudget
                ? `${reportSample.slice(0, Math.max(0, maxReportBudget - 1)).trimEnd().replace(/\s+\S*$/, '')}…`
                : reportSample;

            const verifyPrompt = `${promptHeader}${proposalSection}${reportSection}${limitedReportSample}${trailer}`;
            if (verifyPrompt.length > CAP) {
                throw new Error(`Verification prompt exceeded Groq cap (${verifyPrompt.length} > ${CAP}).`);
            }

            const verificationRaw = await this.critic.run(verifyPrompt, context, {
                responseMimeType: 'application/json',
                bypassCache: true
            });
            
            const verification: VerificationResult = guardVerificationResult(verificationRaw);
            if (verification.parseFailed) {
                console.warn(`[Critic] unparsed verification output (attempt ${attempt}): ${redactForLog(String(verificationRaw)).slice(0, 300)}`);
            }

            // A claim that cites no field in the raw board is a veto
            if (verification.pass && currentProposal) {
                const rawBoardText = typeof rawData === 'string'
                    ? rawData
                    : (rawData?.rawBoard || rawData?.dataSample || JSON.stringify(rawData));
                const candidateClaims = Array.isArray(currentProposal.arguments)
                    ? currentProposal.arguments
                    : (Array.isArray(currentProposal.claims) ? currentProposal.claims : []);

                if (candidateClaims.length > 0 && rawBoardText) {
                    const rawLower = String(rawBoardText).toLowerCase();
                    for (const arg of candidateClaims) {
                        const claimSupporting = typeof arg === 'object' && arg !== null
                            ? (arg.supportingData || arg.field || arg.claim || '')
                            : String(arg);
                        if (!claimSupporting || !claimSupporting.trim()) {
                            verification.pass = false;
                            verification.feedback = 'Veto: Claim cites no field in the raw board.';
                            break;
                        }
                        const tokens = String(claimSupporting).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
                        const citesField = tokens.some(tok => rawLower.includes(tok));
                        if (!citesField && tokens.length > 0) {
                            verification.pass = false;
                            verification.feedback = `Veto: Claim "${String(claimSupporting).slice(0, 80)}" cites no field in the raw board.`;
                            break;
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
                    computedRating
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
            computedRating
        };
    }
}
