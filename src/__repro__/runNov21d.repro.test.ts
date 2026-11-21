import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { SimulatedAdapter } from '../swarm/providers/simulated.ts';
import { sanitizePullBeforePassClaims } from '../swarm/tools/pullBeforePass.ts';

describe('runNov21d repros (wf-1795276340194)', () => {
  it('V1: portable swarm validation script exits 0', () => {
    const res = spawnSync('npx', ['tsx', 'test-portable-swarm.ts'], {
      shell: true,
      encoding: 'utf8',
      timeout: 30000
    });
    expect(res.status, res.stderr || res.stdout).toBe(0);
  }, 35000);

  it('V2: SimulatedAdapter matches Evaluate the [Proposal] verifier prompt', async () => {
    const adapter = new SimulatedAdapter();
    const raw = await adapter.call({
      prompt: 'Evaluate the [Proposal] for consistency and data grounding.',
      systemInstruction: 'You are an analyst.'
    });
    const parsed = JSON.parse(raw);
    expect(parsed.pass).toBe(true);
  });

  it('V3: sanitizePullBeforePassClaims scrubs "lack sufficient market data" when MKT was pulled', () => {
    const report = {
      rationale: 'We cannot bet this game because we lack sufficient market data.'
    };
    const evidenceText = [
      'TOOL_COVERAGE: game-123 FUND=1 MKT=1 INJ=1',
      '[MARKET MOVEMENT: game-123] FanDuel spread -3.5 -> -4.0'
    ].join('\n');

    const cleaned = sanitizePullBeforePassClaims(report, evidenceText, 'game-123: Team A @ Team B', {
      toolCallTrace: [
        { tool: 'get_matchup_fundamentals', eventId: 'game-123', status: 'data' },
        { tool: 'get_market_movement', eventId: 'game-123', status: 'data' },
        { tool: 'get_injury_and_roster_delta', eventId: 'game-123', status: 'data' }
      ]
    });

    expect(cleaned.rationale).not.toMatch(/lack\s+sufficient\s+market\s+data/i);
  });
});
