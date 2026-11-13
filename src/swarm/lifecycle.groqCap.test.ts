import { describe, it, expect } from 'vitest';
import { AnalysisLifecycle } from './lifecycle.ts';
import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { capGroqPrompt, groqPromptCharCap } from './providers/groq.ts';

describe('Critic Groq cap budget', () => {
    it('keeps the verification prompt under the 6k Groq cap while preserving the contract and proposal marker', async () => {
        const captured: { prompt?: string } = {};
        ProviderRegistry.register({
            providerName: 'groq',
            async call(options) {
                const prompt = capGroqPrompt(options.prompt, groqPromptCharCap(options.config?.groqMode));
                captured.prompt = prompt;

                if (options.systemInstruction?.includes('Proposer')) {
                    return JSON.stringify({
                        summary: 'Home team edges out with a sharper attack plan.',
                        analysis: 'PROPOSAL_MARKER_7f3a ' + 'P'.repeat(4000)
                    });
                }

                if (prompt.includes('top-level boolean "pass"') && prompt.includes('PROPOSAL_MARKER_7f3a')) {
                    return JSON.stringify({ pass: true, feedback: 'ok' });
                }

                return JSON.stringify({ verifiable: false, issues: ['No analysis text provided to audit.'] });
            }
        });

        const proposer = new Agent('Manager Node', 'model-critic-groq-proposer', 'groq', 'k', undefined);
        proposer.setSystemInstruction('Proposer Node');
        const critic = new Agent('Risk Critic', 'model-critic-groq-critic', 'groq', 'k', undefined);
        critic.setSystemInstruction('Critic Node');

        const rawData = {
            task: 'task: ' + 'T'.repeat(7000),
            historicalBaselines: 'H'.repeat(3000),
            analystReports: 'A'.repeat(5000),
            rawBoard: 'B'.repeat(3000),
            dataSample: 'D'.repeat(4000)
        };

        const result = await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
            rawData,
            new SwarmContext(),
            'Generate a decision for this matchup.',
            'Review the proposal and enforce the top-level boolean "pass" contract.'
        );

        expect(result.success).toBe(true);
        expect(captured.prompt).toBeDefined();
        expect(captured.prompt).toContain('top-level boolean "pass"');
        expect(captured.prompt).toContain('PROPOSAL_MARKER_7f3a');
        expect(captured.prompt).not.toContain('task:');
        expect(captured.prompt!.length).toBeLessThanOrEqual(6000);
        expect(captured.prompt).toContain('OUTPUT CONTRACT');
    });
});
