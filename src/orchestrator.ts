import { Agent, SwarmContext, Provider } from '../swarm.ts';
import { CentralState, DraftFolder } from './state.ts';
import { GoogleGenAI } from '@google/genai';

export class OrchestratorAgent extends Agent {
    private centralState: CentralState;
    private orchestratorId: string;

    constructor(
        centralState: CentralState,
        modelName: string,
        provider: Provider,
        apiKey: string,
        aiClient?: GoogleGenAI
    ) {
        super('orchestrator', modelName, provider, apiKey, aiClient);
        this.centralState = centralState;
        this.orchestratorId = `orchestrator-${Math.random().toString(36).substring(2, 9)}`;
    }

    // Orchestrator coordinates worker agents and merges their drafts
    async coordinateAndMerge(
        context: SwarmContext,
        workerDrafts: DraftFolder[],
        mergePrompt: string
    ): Promise<boolean> {
        // 1. Gather all drafts from workers
        const allDraftData = workerDrafts.map(draft => draft.getAllDrafts());

        // 2. Synthesize or review the drafts using the Orchestrator's LLM
        const prompt = `${mergePrompt}\n\nReview the following drafts:\n${JSON.stringify(allDraftData, null, 2)}`;
        
        // We expect the orchestrator to output a JSON object representing the final merged data or a decision.
        const mergeDecision = await this.run(prompt, context, { responseMimeType: 'application/json' });

        // 3. Obtain the Single-Writer Lock
        if (!this.centralState.acquireLock(this.orchestratorId)) {
            throw new Error("Orchestrator failed to acquire the central state lock.");
        }

        try {
            // 4. Perform atomic merge to the locked central state
            // Depending on the logic, we might just merge the LLM's structured output
            const success = this.centralState.atomicMerge(this.orchestratorId, [mergeDecision]);
            
            if (success) {
                // Clear the drafts if successful
                workerDrafts.forEach(draft => draft.clear());
            }

            return success;
        } finally {
            // 5. Release the lock
            this.centralState.releaseLock(this.orchestratorId);
        }
    }
}
