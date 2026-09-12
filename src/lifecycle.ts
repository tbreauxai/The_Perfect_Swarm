import { Agent, SwarmContext } from '../swarm.ts';

export interface VerificationResult {
    pass: boolean;
    feedback?: string;
}

export class AnalysisLifecycle {
    constructor(
        private proposer: Agent,
        private critic: Agent,
        private maxRetries: number = 3
    ) {}

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
    ): Promise<any> {
        let attempt = 0;
        let currentProposal: any = null;
        let feedback = "";

        while (attempt < this.maxRetries) {
            attempt++;
            
            // 1. Proposer executes (incorporating feedback if this is a retry)
            const executePrompt = feedback 
                ? `${proposerPrompt}\n\n[Previous Feedback to Address]:\n${feedback}\n\n[Raw Data]:\n${JSON.stringify(rawData)}`
                : `${proposerPrompt}\n\n[Raw Data]:\n${JSON.stringify(rawData)}`;

            context.addEvent({ agentRole: this.proposer.role, action: `Executing proposal (Attempt ${attempt})`, modelName: this.proposer.modelName, prompt: executePrompt });
            
            const proposalRaw = await this.proposer.run(executePrompt, context, { responseMimeType: 'application/json' });
            
            try {
                currentProposal = JSON.parse(proposalRaw);
            } catch (e) {
                // If it fails to parse as JSON, wrap it in a fallback object
                currentProposal = { rawText: proposalRaw, error: "Failed to parse JSON" };
            }

            // 2. Critic verifies
            context.addEvent({ agentRole: this.critic.role, action: `Verifying proposal from attempt ${attempt}`, modelName: this.critic.modelName, prompt: "[Internal Verification]" });
            
            const verifyPrompt = `${criticPrompt}\n\n[Raw Data]:\n${JSON.stringify(rawData)}\n\n[Proposed Analysis]:\n${JSON.stringify(currentProposal, null, 2)}\n\nEvaluate this proposal. You MUST output strict JSON in this format: { "pass": boolean, "feedback": "Detailed string explaining flaws, or confirming success" }.`;
            
            const verificationRaw = await this.critic.run(verifyPrompt, context, { responseMimeType: 'application/json' });
            
            let verification: VerificationResult;
            try {
                verification = JSON.parse(verificationRaw);
            } catch (e) {
                // Force a fail if critic outputs invalid JSON
                verification = { pass: false, feedback: "Critic failed to output valid JSON evaluation. Treat as verification failure." };
            }

            // 3. Pass/Fail evaluation
            if (verification.pass) {
                context.addEvent({ agentRole: this.critic.role, action: `Verification PASSED on attempt ${attempt}.`, modelName: this.critic.modelName, prompt: "[Internal Verification Result]" });
                return {
                    success: true,
                    attempts: attempt,
                    finalProposal: currentProposal,
                    criticFeedback: verification.feedback
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
        context.addEvent({ agentRole: 'system', action: `Exhausted ${this.maxRetries} retries. Proposer failed to pass verification.`, modelName: 'system', prompt: "[System Error]" });
        
        return {
            success: false,
            attempts: this.maxRetries,
            finalProposal: currentProposal,
            criticFeedback: feedback,
            error: "Max retries reached without passing verification."
        };
    }
}
