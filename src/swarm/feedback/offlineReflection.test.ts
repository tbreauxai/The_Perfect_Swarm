import { describe, it, expect, vi } from 'vitest';
import { triggerOfflineFailureReflection } from './offlineReflection.ts';

describe('Meta-Learning Failure Reflection (offline)', () => {
    it('executes reflection prompt with agent, parses rule, and upserts graded lesson', async () => {
        let capturedPrompt = '';
        const mockAgent = {
            async run(prompt: string) {
                capturedPrompt = prompt;
                return JSON.stringify({
                    rule: 'Do not extrapolate momentum across liquidity regime shifts.',
                    reason: 'Unstated assumption that trading volume would remain above $1M failed.',
                    category: 'failure_reflection'
                });
            }
        };

        const upsertSpy = vi.fn().mockResolvedValue('qdrant-point-123');
        const mockCortex = {
            upsertGradedLesson: upsertSpy
        };

        const result = await triggerOfflineFailureReflection({
            workflowId: 'wf-test-fail-1',
            originApp: 'duelodds',
            outcome: 'loss',
            task: 'Predict Chiefs vs Bills total points',
            reason: 'Heavy rain suppressed passing volume contrary to initial baseline',
            predictionSummary: 'Initial model predicted over 54.5 points with 68% confidence',
            cortex: mockCortex as any,
            agent: mockAgent as any
        });

        expect(capturedPrompt).toContain('What unstated assumption or missed anomaly caused this prediction to fail?');
        expect(capturedPrompt).toContain('Formulate 1 concise, preventative, actionable rule');
        expect(result.rule).toBe('Do not extrapolate momentum across liquidity regime shifts.');
        expect(result.reason).toContain('Unstated assumption that trading volume');
        expect(result.category).toBe('failure_reflection');
        expect(result.storedId).toBe('qdrant-point-123');

        expect(upsertSpy).toHaveBeenCalledTimes(1);
        const [calledId, calledPayload] = upsertSpy.mock.calls[0];
        expect(calledId).toContain('lesson:failure_reflection:wf-test-fail-1:');
        expect(calledPayload.rule).toBe('Do not extrapolate momentum across liquidity regime shifts.');
        expect(calledPayload.category).toBe('failure_reflection');
        expect(calledPayload.outcome).toBe('loss');
        expect(calledPayload.memory_type).toBe('graded_lesson');
    });

    it('falls back to heuristic preventative rule when agent throws', async () => {
        const mockFailingAgent = {
            async run() {
                throw new Error('LLM rate limited');
            }
        };

        const upsertSpy = vi.fn().mockResolvedValue('qdrant-point-fallback');
        const mockCortex = {
            upsertGradedLesson: upsertSpy
        };

        const result = await triggerOfflineFailureReflection({
            workflowId: 'wf-fallback-2',
            originApp: 'perfect-swarm',
            outcome: 'loss',
            task: 'Analyze system telemetry for outlier anomalies',
            reason: 'Node crash due to memory limit spike',
            cortex: mockCortex as any,
            agent: mockFailingAgent as any
        });

        expect(result.rule).toContain('Preventative Rule:');
        expect(result.rule).toContain('Analyze system telemetry');
        expect(result.category).toBe('failure_reflection');
        expect(result.storedId).toBe('qdrant-point-fallback');

        expect(upsertSpy).toHaveBeenCalledTimes(1);
        const [, calledPayload] = upsertSpy.mock.calls[0];
        expect(calledPayload.category).toBe('failure_reflection');
        expect(calledPayload.outcome).toBe('loss');
    });
});
