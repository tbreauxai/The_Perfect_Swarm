import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearRunDebugRecords,
  getRunDebugRecord,
  recordRunDebugFailover,
  recordRunDebugSeat
} from '../swarm/engine/runDebugRecord.ts';
import { MANAGER_CHAIN } from '../swarm/engine/managerChain.ts';

describe('runNov20j repros (wf-1795237523010)', () => {
  const origDebug = process.env.SWARM_RUN_DEBUG;

  beforeEach(() => {
    clearRunDebugRecords();
    delete process.env.SWARM_RUN_DEBUG;
  });

  afterEach(() => {
    clearRunDebugRecords();
    if (origDebug === undefined) delete process.env.SWARM_RUN_DEBUG;
    else process.env.SWARM_RUN_DEBUG = origDebug;
  });

  it('T: recordRunDebugFailover maps role names to canonical seat keys without creating "Risk Critic"', () => {
    process.env.SWARM_RUN_DEBUG = '1';
    recordRunDebugSeat('wf-t', 'critic', { role: 'Risk Critic', provider: 'groq', promptChars: 1000, limitChars: 5600 });
    recordRunDebugFailover('wf-t', 'Risk Critic', 'gemini', 24000);
    recordRunDebugFailover('wf-t', 'Quant Proposer', 'nvidia', 14000);
    recordRunDebugFailover('wf-t', 'Market Proposer', 'openrouter', 14000);
    recordRunDebugFailover('wf-t', 'verifier', 'mistral', 14000);
    recordRunDebugFailover('wf-t', 'Manager Node', 'groq', 5600);

    const rec = getRunDebugRecord('wf-t');
    expect(rec).toBeDefined();
    expect(rec?.seats['Risk Critic']).toBeUndefined();
    expect(rec?.seats.critic?.postFailoverProvider).toBe('gemini');
    expect(rec?.seats.a1?.postFailoverProvider).toBe('nvidia');
    expect(rec?.seats.a2?.postFailoverProvider).toBe('openrouter');
    expect(rec?.seats.verifier?.postFailoverProvider).toBe('mistral');
    expect(rec?.seats.manager?.postFailoverProvider).toBe('groq');
  });

  it('U: MANAGER_CHAIN uses Nov 2026 Gemini free-tier siblings and drops retired gemini-2.5 models', () => {
    const models = MANAGER_CHAIN.map(e => `${e.provider}:${e.model}`);
    expect(models).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.1-flash-lite',
      'gemini:gemini-3.8-flash',
      'groq:openai/gpt-oss-120b',
      'mistral:mistral-small-latest',
      'cloudflare:@cf/meta/llama-3.1-8b-instruct',
      'nvidia:nvidia/nemotron-3.5-lightning-30b-a3b'
    ]);
    expect(models.some(m => m.includes('gemini-2.5'))).toBe(false);
  });
});
