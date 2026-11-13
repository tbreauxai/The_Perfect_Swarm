import { describe, it, expect, vi } from 'vitest';
import { guardVerificationResult } from '../parser/responseGuards.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Critic Veto & Verification Engine Tests', () => {
    it('an empty critic object fails verification', () => {
        const emptyObjResult = guardVerificationResult({});
        expect(emptyObjResult.pass).toBe(false);
        expect(emptyObjResult.feedback).toContain('empty object');

        const emptyJsonStrResult = guardVerificationResult('{}');
        expect(emptyJsonStrResult.pass).toBe(false);
        expect(emptyJsonStrResult.feedback).toContain('empty object');
    });

    it('a missing pass field in critic object fails verification', () => {
        const missingPassResult = guardVerificationResult({ feedback: 'Looks fine but missing pass boolean' });
        expect(missingPassResult.pass).toBe(false);
        expect(missingPassResult.feedback).toContain('missing pass field');

        const missingPassJson = guardVerificationResult('{"feedback": "Looks okay"}');
        expect(missingPassJson.pass).toBe(false);
        expect(missingPassJson.feedback).toContain('missing pass field');
    });

    it('keeps the top-level pass contract explicit after compressing the critic prompt', async () => {
        let capturedCriticPrompt = '';
        ProviderRegistry.register({
            providerName: 'critic-contract-test-prov',
            async call(options) {
                if (options.systemInstruction?.includes('Proposer')) {
                    return JSON.stringify({ summary: 'Test proposal' });
                }
                capturedCriticPrompt = options.prompt || '';
                return JSON.stringify({ pass: true, feedback: 'No fatal issues found.' });
            }
        });

        const proposer = new Agent('Manager Node', 'model-contract-p', 'critic-contract-test-prov', 'k', undefined);
        proposer.setSystemInstruction('Proposer Node');
        const critic = new Agent('Risk Critic', 'model-contract-c', 'critic-contract-test-prov', 'k', undefined);
        critic.setSystemInstruction('Critic Node');

        const result = await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
            { dataSample: 'test data' },
            new SwarmContext(),
            'Generate a test proposal',
            'Review the proposal.'
        );

        expect(result.success).toBe(true);
        expect(capturedCriticPrompt).toContain('"pass":true');
        expect(capturedCriticPrompt).toContain('"pass":false');
        expect(capturedCriticPrompt).toContain('Missing the top-level boolean is an automatic failure.');
    });

    it('a claim citing no field in the raw board is a veto', async () => {
        ProviderRegistry.register({
            providerName: 'critic-veto-test-prov',
            async call(options) {
                if (options.systemInstruction?.includes('Proposer')) {
                    return JSON.stringify({
                        likelyWinner: 'Home Team',
                        winProbHome: 0.75,
                        fairSpread: -4.5,
                        arguments: [
                            {
                                claim: 'Team has higher offensive rating',
                                supportingData: 'xyz_alien_metric_not_on_board 99.9'
                            }
                        ]
                    });
                }
                // Critic returns pass: true initially
                return JSON.stringify({
                    pass: true,
                    feedback: 'Proposed judgment looks plausible.'
                });
            }
        });

        const proposer = new Agent('Manager Node', 'model-veto-p', 'critic-veto-test-prov', 'k', undefined);
        proposer.setSystemInstruction('Proposer Node');
        const critic = new Agent('Critic Node', 'model-veto-c', 'critic-veto-test-prov', 'k', undefined);
        critic.setSystemInstruction('Critic Node');

        const lifecycle = new AnalysisLifecycle(proposer, critic, 1);
        const context = new SwarmContext();

        // Raw board contains standard fields, but NOT xyz_alien_metric_not_on_board
        const rawBoard = JSON.stringify({
            homeTeam: 'Home Team',
            awayTeam: 'Away Team',
            spread: -3.5,
            total: 215.5,
            offensiveRating: 112.4
        });

        const result = await lifecycle.executeAndVerify(
            { task: 'Betting judgment', rawBoard, dataSample: rawBoard },
            context,
            'Generate betting judgment',
            'Verify judgment strictly against raw board'
        );

        // Verification must be vetoed because claim cites non-existent field
        expect(result.success).toBe(false);
        expect(result.criticFeedback).toContain('Veto: Claim');
    });

    it('redacts sensitive keys in unparsed verification warnings and skips verifiable:false logs', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const secret = 'sk-or-v1-' + 'a'.repeat(40);

        ProviderRegistry.register({
            providerName: 'critic-redaction-test-prov',
            async call(options) {
                if (options.systemInstruction?.includes('Proposer')) {
                    return JSON.stringify({ analysis: 'Check metrics and return a verdict.' });
                }
                return JSON.stringify({ verifiable: true, feedback: secret });
            }
        });

        const proposer = new Agent('Manager Node', 'model-redact-p', 'critic-redaction-test-prov', 'k', undefined);
        proposer.setSystemInstruction('Proposer Node');
        const critic = new Agent('Critic Node', 'model-redact-c', 'critic-redaction-test-prov', 'k', undefined);
        critic.setSystemInstruction('Critic Node');

        const result = await new AnalysisLifecycle(proposer, critic, 1).executeAndVerify(
            { task: 'Testing redaction', historicalBaselines: 'baseline' },
            new SwarmContext(),
            'Generate a proposal',
            'Check the proposal.'
        );

        expect(result.success).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warning = String(warnSpy.mock.calls[0][0]);
        expect(warning).not.toContain(secret);
        expect(warning).not.toContain('sk-or-v1-');
        const sample = warning.slice(warning.indexOf('): ') + 4);
        expect(sample.length).toBeLessThanOrEqual(300);

        warnSpy.mockClear();
        const plainResult = guardVerificationResult({ verifiable: false, issues: ['No analysis text provided to audit.'] });
        expect(plainResult.pass).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(plainResult.feedback).toContain('No analysis text provided to audit.');
    });
});
