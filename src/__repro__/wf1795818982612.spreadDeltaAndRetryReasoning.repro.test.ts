import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { auditMarketCoverageAndRowBinding } from '../swarm/tools/marketRowBinding.ts';

describe('wf-1795818982612: Ignore Steam/Movement Deltas in Spread Mismatch & Use reasoning_effort: low on Retry', () => {
  it('does NOT trigger spread mismatch for +2.0 when reasoning mentions steam/movement deltas', () => {
    const slate = 'ncaaf-401950 | Minnesota Golden Gophers @ Wisconsin Badgers | R5: Wisconsin Badgers -9.5 (-110)';
    const evidence = [
      'EVENT ncaaf-401950',
      '[MARKET MOVEMENT: ncaaf-401950] Open -7.5 -> Current -9.5 (2.0 pts) | Steam: TOWARD home Wisconsin Badgers (-7.5 -> -9.5, +2.0 pts)'
    ].join('\n');

    const proposalWithDeltaPhrasing = {
      picks: [
        {
          row: 'R5',
          side: 'Wisconsin Badgers -9.5',
          reason: 'Wisconsin Badgers -9.5 backed by 2.0 points of favorable steam (+2.0 pts, -7.5 -> -9.5, +2.0pp).'
        }
      ]
    };

    const audit = auditMarketCoverageAndRowBinding(proposalWithDeltaPhrasing, evidence, slate);
    expect(audit.pass).toBe(true);
    expect(audit.flags).toEqual([]);

    const actualMismatch = {
      picks: [
        {
          row: 'R5',
          side: 'Wisconsin Badgers -9.5',
          reason: 'Backing Wisconsin Badgers +2.0 in this matchup.'
        }
      ]
    };
    const mismatchAudit = auditMarketCoverageAndRowBinding(actualMismatch, evidence, slate);
    expect(mismatchAudit.pass).toBe(false);
    expect(mismatchAudit.flags).toContain('spread_side_mismatch');
  });

  it('passes reasoning_effort: "low" to Manager proposer.run on both Attempt 1 and Attempt 2 verification retry', async () => {
    const manager = new Agent('Manager Node', 'openai/gpt-oss-120b', 'simulated', 'mock-key');
    const critic = new Agent('Verification Critic', 'gemini-3.5-flash-lite', 'simulated', 'mock-key');

    const slate = 'ncaaf-401950 | Minnesota Golden Gophers @ Wisconsin Badgers | R5: Wisconsin Badgers -9.5 (-110)';
    const attempt1Bad = {
      summary: 'Backing R5 (Wisconsin Badgers -9.5).',
      picks: [],
      scorecards: [],
      components: [{ type: 'DataTable', props: { title: 'Recommended Bets', rows: [{ row: 'R5', pick: 'Wisconsin Badgers -9.5' }] } }],
      criticApproved: true,
      wageringPass: true
    };
    const attempt2Good = {
      summary: 'Backing Wisconsin Badgers -9.5 (R5).',
      picks: [{ row: 'R5', side: 'Wisconsin Badgers -9.5', confidence: 0.79, reason: 'Wisconsin Badgers -9.5 backed by 2.0 points of favorable steam.' }],
      scorecards: [],
      components: [],
      criticApproved: true,
      wageringPass: false
    };

    const runSpy = vi.spyOn(manager, 'run')
      .mockResolvedValueOnce(JSON.stringify(attempt1Bad))
      .mockResolvedValueOnce(JSON.stringify(attempt2Good));

    const ctx = new SwarmContext();
    const lifecycle = new AnalysisLifecycle(manager, critic, 2);

    const res = await lifecycle.executeAndVerify(
      { fullBoard: slate },
      ctx,
      'Evaluate NCAAF slate',
      'Audit NCAAF slate'
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[0]?.[2]?.reasoning_effort).toBe('low');
    expect(runSpy.mock.calls[1]?.[2]?.reasoning_effort).toBe('low');
  });
});
