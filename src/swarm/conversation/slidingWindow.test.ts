import { describe, it, expect } from 'vitest';
import { SlidingWindowContext } from './slidingWindow.ts';
import { TokenEstimator } from '../compression/tokenEstimator.ts';

describe('SlidingWindowContext', () => {
    it('initializes empty and accepts turns', async () => {
        const sw = new SlidingWindowContext({ maxVerbatimTurns: 4 });
        expect(sw.getVerbatimTurns().length).toBe(0);
        expect(sw.getRollingSummary()).toBe('');

        await sw.addTurn({ role: 'user', content: 'What is the system status?' });
        await sw.addTurn({ role: 'assistant', content: 'All services operating nominally.' });

        expect(sw.getVerbatimTurns().length).toBe(2);
        expect(sw.getRollingSummary()).toBe('');
    });

    it('rotates older turns into rolling summary when turn count exceeds threshold', async () => {
        const sw = new SlidingWindowContext({ maxVerbatimTurns: 4 });

        for (let i = 1; i <= 6; i++) {
            await sw.addTurn({ role: 'user', content: `Query #${i}: Check metric ${i * 10}` });
            await sw.addTurn({ role: 'assistant', content: `Response #${i}: Metric ${i * 10} recorded status ok` });
        }

        // Must retain at most 4 verbatim turns
        expect(sw.getVerbatimTurns().length).toBe(4);
        // Rolling summary must now contain evicted history points
        expect(sw.getRollingSummary()).toContain('Summary:');
        expect(sw.getRollingSummary()).toContain('user');

        const effective = sw.getEffectiveContext();
        expect(effective[0].role).toBe('system');
        expect(effective[0].content).toContain('[Rolling Summary of Preceding Conversation History]');
    });

    it('permanently caps total context tokens strictly below 6000 tokens during long streaming sessions', async () => {
        const sw = new SlidingWindowContext({
            maxVerbatimTurns: 8,
            maxContextTokens: 2000 // tight budget for verification
        });

        // Simulate 50 turns of heavy data streaming
        for (let i = 1; i <= 50; i++) {
            await sw.addTurn({
                role: i % 2 === 1 ? 'user' : 'assistant',
                content: `Turn ${i}: ${'Detailed streaming log message with token telemetry data '.repeat(15)}`
            });

            // Ensure ceiling holds at every turn
            expect(sw.getTotalTokenCount()).toBeLessThanOrEqual(2500);
        }

        const prompt = sw.renderContextPrompt();
        const totalTokens = TokenEstimator.countTokens(prompt);
        expect(totalTokens).toBeLessThan(2500);
    });

    it('supports custom summarizer hook', async () => {
        const sw = new SlidingWindowContext({
            maxVerbatimTurns: 2,
            summarizer: async (evicted, prior) => {
                return `[CustomSummary]: evicted ${evicted.length} turns (prior: ${prior || 'none'})`;
            }
        });

        await sw.addTurn({ role: 'user', content: 'turn 1' });
        await sw.addTurn({ role: 'assistant', content: 'turn 2' });
        await sw.addTurn({ role: 'user', content: 'turn 3' });

        expect(sw.getVerbatimTurns().length).toBe(2);
        expect(sw.getRollingSummary()).toContain('[CustomSummary]: evicted 1 turns');
    });

    it('resets cleanly', async () => {
        const sw = new SlidingWindowContext({ maxVerbatimTurns: 2 });
        await sw.addTurn({ role: 'user', content: 'test' });
        sw.reset();
        expect(sw.getVerbatimTurns().length).toBe(0);
        expect(sw.getRollingSummary()).toBe('');
    });
});
