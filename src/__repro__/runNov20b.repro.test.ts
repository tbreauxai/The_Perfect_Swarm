import { describe, it, expect, vi } from 'vitest';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { GameQueryCache } from '../swarm/cache/gameQueryCache.ts';
import { buildCriticAuditReprompt } from '../swarm/tools/criticAudit.ts';

describe('runNov20b repros (wf-1795200330594)', () => {
    it('does not fail verification when Manager proposes a valid PASS (picks: []) and critic complains about empty picks', async () => {
        const proposer: any = {
            role: 'Manager Node',
            modelName: 'gemini-3.1-flash-lite',
            provider: 'gemini',
            run: vi.fn(async () => JSON.stringify({
                ui_title: 'Pass on tonight slate',
                summary: 'Passing on tonight slate due to divergent analyst consensus.',
                picks: []
            }))
        };

        const critic: any = {
            role: 'Risk Critic',
            modelName: 'gemini-3.1-flash-lite',
            provider: 'gemini',
            run: vi.fn(async () => JSON.stringify({
                pass: false,
                feedback: 'The proposal provides no picks (picks array is empty), so there are no legs to audit.'
            }))
        };

        const lifecycle = new AnalysisLifecycle(proposer, critic, 2, {
            toolRegistry: new ToolRegistry([]),
            queryCache: new GameQueryCache()
        });

        const result = await lifecycle.executeAndVerify(
            {
                rawBoard: 'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: R1 Orlando Magic +5.5 (-110)',
                analystReports: '[Quant]: Orlando Magic ML\n[Market]: Insufficient data'
            },
            new SwarmContext(),
            'Build 3-leg parlay',
            'Verify proposal'
        );

        expect(result.success).toBe(true);
        expect(result.computedRating).toBeGreaterThanOrEqual(0.5);
    });

    it('Stage 2 buildCriticAuditReprompt explicitly forbids tool calls', () => {
        const reprompt = buildCriticAuditReprompt(
            [{ key: 'R1:nba-401909306', rowId: 'R1', eventId: 'nba-401909306', sideText: 'Orlando Magic ML', teamLabel: 'Orlando Magic', teamAliases: ['orlando magic'], rawPick: {} }],
            'stage2'
        );
        expect(reprompt.toLowerCase()).toContain('do not call any tools');
    });
});
