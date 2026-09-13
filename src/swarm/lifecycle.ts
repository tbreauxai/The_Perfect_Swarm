import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';

export interface VerificationResult {
    pass: boolean;
    feedback?: string;
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
            
            if (typeof proposalRaw === 'object' && proposalRaw !== null) {
                currentProposal = proposalRaw;
            } else {
                try {
                    let clean = String(proposalRaw || '').replace(/```(?:json)?/gi, '').trim();
                    const startIdx = clean.indexOf('{');
                    const endIdx = clean.lastIndexOf('}');
                    if (startIdx !== -1 && endIdx !== -1) {
                        clean = clean.substring(startIdx, endIdx + 1);
                    }
                    currentProposal = JSON.parse(clean);
                } catch (e) {
                    currentProposal = { rawText: proposalRaw, error: "Failed to parse JSON" };
                }
            }

            // 2. Critic verifies
            context.addEvent({ agentRole: this.critic.role, action: `Verifying proposal from attempt ${attempt}`, modelName: this.critic.modelName, prompt: "[Internal Verification]" });
            
            const verifyPrompt = `${criticPrompt}\n\n[Raw Data]:\n${JSON.stringify(rawData)}\n\n[Proposed Analysis]:\n${JSON.stringify(currentProposal, null, 2)}\n\nEvaluate this proposal. You MUST output strict JSON in this format: { "pass": boolean, "feedback": "Detailed string explaining flaws, or confirming success" }.`;
            
            const verificationRaw = await this.critic.run(verifyPrompt, context, { responseMimeType: 'application/json' });
            
            let verification: VerificationResult;
            if (typeof verificationRaw === 'object' && verificationRaw !== null) {
                verification = verificationRaw as VerificationResult;
            } else {
                try {
                    let clean = String(verificationRaw || '').replace(/```(?:json)?/gi, '').trim();
                    const startIdx = clean.indexOf('{');
                    const endIdx = clean.lastIndexOf('}');
                    if (startIdx !== -1 && endIdx !== -1) {
                        clean = clean.substring(startIdx, endIdx + 1);
                    }
                    verification = JSON.parse(clean);
                } catch (e) {
                    verification = { pass: false, feedback: "Critic failed to output valid JSON evaluation. Treat as verification failure." };
                }
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
            attempts: attempt,
            finalProposal: currentProposal,
            criticFeedback: feedback
        };
    }
}
