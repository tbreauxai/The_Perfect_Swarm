import { describe, it, expect } from 'vitest';
import { ModelRouter } from './router.ts';
import { AnalysisLifecycle } from './lifecycle.ts';
import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('ModelRouter Word-Boundary Precision & Recommendations', () => {
    it('prevents substring false-positive keyword escalation using word boundaries', () => {
        // "plaudits" contains "audit" as a substring, but is not the word "audit"
        const plauditsTask = 'Review customer plaudits for our recent product launch';
        const plauditsFast = ModelRouter.evaluateFastPath(plauditsTask, '');
        expect(plauditsFast.eligible).toBe(true);
        expect(plauditsFast.targetTier).toBe('instant');

        const plauditsComplexity = ModelRouter.inferComplexity(plauditsTask, 0, 1, false);
        expect(plauditsComplexity).toBe('instant');

        // "cleaning" contains "clean", but is not the standalone keyword "clean"
        const cleaningTask = 'The office cleaning service arrives at noon';
        expect(ModelRouter.inferComplexity(cleaningTask, 0, 1, false)).toBe('instant');
    });

    it('correctly escalates when full keyword is present at word boundaries', () => {
        const auditTask = 'Perform an audit on authentication token expiration';
        const auditFast = ModelRouter.evaluateFastPath(auditTask, '');
        expect(auditFast.eligible).toBe(false);
        expect(auditFast.targetTier).toBe('complex');
        expect(ModelRouter.inferComplexity(auditTask, 0, 1, false)).toBe('complex');

        const secTask = 'Check security vulnerability in dependencies';
        expect(ModelRouter.evaluateFastPath(secTask, '').eligible).toBe(false);
        expect(ModelRouter.inferComplexity(secTask, 0, 1, false)).toBe('complex');

        const formatTask = 'Please format the results into a markdown table';
        const formatFast = ModelRouter.evaluateFastPath(formatTask, '');
        expect(formatFast.eligible).toBe(false);
        expect(formatFast.targetTier).toBe('formatting');
        expect(ModelRouter.inferComplexity(formatTask, 0, 1, false)).toBe('formatting');
    });

    it('returns modern verified OpenRouter free model recommendations', () => {
        expect(ModelRouter.getRecommendedModel('openrouter', 'complex')).toBe('deepseek/deepseek-r1:free');
        expect(ModelRouter.getRecommendedModel('openrouter', 'instant')).toBe('meta-llama/llama-3.3-70b-instruct:free');
        expect(ModelRouter.getRecommendedModel('openrouter', 'simple')).toBe('deepseek/deepseek-r1:free');
    });
});

describe('AnalysisLifecycle Bounded Retries & Reinforcement Scoring', () => {
    it('bounds prompts on retry without duplicating raw data when already in proposer prompt', async () => {
        const recordedPrompts: string[] = [];

        ProviderRegistry.register({
            providerName: 'lifecycle-test-prov',
            async call(options) {
                recordedPrompts.push(options.prompt || '');
                // Proposer returns initial proposal
                if (options.systemInstruction?.includes('Proposer')) {
                    return JSON.stringify({
                        ui_title: 'Test Proposal',
                        components: [{ id: '1', type: 'InsightList', props: { insights: [] } }]
                    });
                }
                // Critic fails on attempt 1, passes on attempt 2
                if (recordedPrompts.length <= 2) {
                    return JSON.stringify({
                        pass: false,
                        feedback: 'Missing critical security consideration in proposal.'
                    });
                }
                return JSON.stringify({
                    pass: true,
                    feedback: 'Proposal satisfactorily corrected.'
                });
            }
        });

        const proposer = new Agent('Manager Node', 'model-a', 'lifecycle-test-prov', 'k', undefined);
        proposer.setSystemInstruction('Proposer System Instruction');
        const critic = new Agent('Critic Node', 'model-b', 'lifecycle-test-prov', 'k', undefined);
        critic.setSystemInstruction('Critic System Instruction');

        const lifecycle = new AnalysisLifecycle(proposer, critic, 2);
        const context = new SwarmContext();

        const baseProposerPrompt = 'Task: Synthesize analyst reports\n\nAnalyst Reports:\n- Report 1: All clear.';
        const result = await lifecycle.executeAndVerify(
            { task: 'Synthesize reports', analystReports: 'Report 1: All clear.' },
            context,
            baseProposerPrompt,
            'Verify proposal against reports'
        );

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
        expect(result.computedRating).toBe(0.88); // 0.88 for attempt 2 pass

        // Verify that on retry (attempt 2 proposer prompt), raw data was not duplicated
        const retryPrompt = recordedPrompts[2]; // attempt 2 proposer run
        expect(retryPrompt).toContain('Previous Verification Critique & Corrections Required (Attempt 1)');
        expect(retryPrompt).toContain('Missing critical security consideration');
        expect(retryPrompt).not.toContain('[Raw Data Context]:');
    });

    it('penalizes rating when retries are exhausted', () => {
        expect(AnalysisLifecycle.computeReinforcementScore(false, 3, 3)).toBe(0.35);
        expect(AnalysisLifecycle.computeReinforcementScore(true, 1, 3)).toBe(0.98);
        expect(AnalysisLifecycle.computeReinforcementScore(true, 2, 3)).toBe(0.88);
    });
});
