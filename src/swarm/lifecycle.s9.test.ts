import { describe, it, expect, vi } from 'vitest';
import { AnalysisLifecycle } from './lifecycle.ts';
import { SwarmContext } from './context.ts';
import { ToolRegistry } from './tools/registry.ts';
import { GameQueryCache } from './cache/gameQueryCache.ts';

describe('lifecycle S9 protected ids ordering on 0-pick pass', () => {
  it('keeps the IND @ CLE block when proposal has 0 picks and discusses Pacers/Cavaliers', async () => {
    const proposer: any = {
      role: 'Manager Node',
      modelName: 'm',
      provider: 'groq',
      run: vi.fn(async () => JSON.stringify({
        summary: 'Passing on tonight slate; Indiana Pacers @ Cleveland Cavaliers has key injuries.',
        picks: []
      }))
    };

    let capturedVerifyPrompt = '';
    const critic: any = {
      role: 'Risk Critic',
      modelName: 'c',
      provider: 'groq',
      run: vi.fn(async (p: string) => {
        capturedVerifyPrompt = p;
        return JSON.stringify({ pass: true, feedback: 'Verified pass.' });
      })
    };

    const slate = [
      ...Array.from({ length: 12 }, (_, i) => `event_id=nba-other-${i + 1} | sport=nba | Away${i + 1} @ Home${i + 1} | options: R${i + 1} Home${i + 1} -3.5`),
      'event_id=nba-ind-cle | sport=nba | Indiana Pacers @ Cleveland Cavaliers | options: R13 Cleveland Cavaliers -5.5'
    ].join('\n');

    const toolResults = [
      ...Array.from({ length: 12 }, (_, i) => `EVENT nba-other-${i + 1} Away${i + 1} @ Home${i + 1}\nMKT: spread=-3.5 | ml_home=-150, ml_away=130 | ${'padding '.repeat(25)}`),
      'EVENT nba-ind-cle Indiana Pacers @ Cleveland Cavaliers\nINJ: CLE: Donovan Mitchell (G): OUT'
    ].join('\n\n');

    const lifecycle = new AnalysisLifecycle(proposer, critic, 1, {
      toolRegistry: new ToolRegistry([]),
      queryCache: new GameQueryCache()
    });

    const res = await lifecycle.executeAndVerify(
      { rawBoard: slate, toolResults },
      new SwarmContext(),
      'Build parlay',
      'Verify proposal'
    );

    expect(res.success).toBe(true);
    expect(capturedVerifyPrompt).toContain('nba-ind-cle');
    expect(capturedVerifyPrompt).toContain('Donovan Mitchell');
  });
});
