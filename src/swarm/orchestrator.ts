import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import type { Provider } from './types.ts';
import { CentralState, DraftFolder } from './state.ts';
import type { GoogleGenAI } from '@google/genai';

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

    async coordinateAndMerge(
        context: SwarmContext,
        workerDrafts: DraftFolder[],
        mergePrompt: string
    ): Promise<boolean> {
        const allDraftData = workerDrafts.map(draft => draft.getAllDrafts());
        const prompt = `${mergePrompt}\n\nReview the following drafts:\n${JSON.stringify(allDraftData, null, 2)}`;
        
        const mergeDecision = await this.run(prompt, context, { responseMimeType: 'application/json' });

        if (!this.centralState.acquireLock(this.orchestratorId)) {
            throw new Error("Orchestrator failed to acquire the central state lock.");
        }

        try {
            const success = this.centralState.atomicMerge(this.orchestratorId, [mergeDecision]);
            if (success) {
                workerDrafts.forEach(draft => draft.clear());
            }
            return success;
        } finally {
            this.centralState.releaseLock(this.orchestratorId);
        }
    }
}
