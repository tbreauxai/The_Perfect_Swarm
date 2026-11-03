import { describe, it, expect } from 'vitest';
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
});
