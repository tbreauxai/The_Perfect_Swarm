import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { parseJsonSafe, guardVerificationResult } from './parser.ts';

import type { VerificationResult } from './types.ts';
export type { VerificationResult };

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
            const executePrompt = feedback 
                ? `${proposerPrompt}\n\n[Previous Feedback to Address]:\n${feedback}\n\n[Raw Data]:\n${JSON.stringify(rawData)}`
                : `${proposerPrompt}\n\n[Raw Data]:\n${JSON.stringify(rawData)}`;

            context.addEvent({
                agentRole: this.proposer.role,
                action: `Executing proposal (Attempt ${attempt})`,
                modelName: this.proposer.modelName,
                prompt: executePrompt
            });
            
            const proposalRaw = await this.proposer.run(executePrompt, context, { responseMimeType: 'application/json' });
            
            currentProposal = parseJsonSafe(proposalRaw, { rawText: proposalRaw, error: "Failed to parse JSON" });

            // 2. Critic verifies
            context.addEvent({
                agentRole: this.critic.role,
                action: `Verifying proposal from attempt ${attempt}`,
                modelName: this.critic.modelName,
                prompt: "[Internal Verification]"
            });
            
            const verifyPrompt = `${criticPrompt}\n\n[Raw Data]:\n${JSON.stringify(rawData)}\n\n[Proposed Analysis]:\n${JSON.stringify(currentProposal, null, 2)}\n\nEvaluate this proposal. You MUST output strict JSON in this format: { "pass": boolean, "feedback": "Detailed string explaining flaws, or confirming success" }.`;
            
            const verificationRaw = await this.critic.run(verifyPrompt, context, { responseMimeType: 'application/json' });
            
            const verification: VerificationResult = guardVerificationResult(verificationRaw);

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
