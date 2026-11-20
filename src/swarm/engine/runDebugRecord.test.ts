import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearRunDebugRecords,
  getRunDebugRecord,
  getRunDebugRingIds,
  recordRunDebugDrop,
  recordRunDebugEdit,
  recordRunDebugFailover,
  recordRunDebugSeat
} from './runDebugRecord.ts';
import { createSwarmServer } from '../server/app.ts';

describe('runDebugRecord (S11)', () => {
  const origFlag = process.env.SWARM_RUN_DEBUG;
  const origTokens = process.env.SWARM_APP_TOKENS;

  beforeEach(() => {
    clearRunDebugRecords();
    delete process.env.SWARM_RUN_DEBUG;
    delete process.env.SWARM_APP_TOKENS;
  });

  afterEach(() => {
    clearRunDebugRecords();
    if (origFlag === undefined) delete process.env.SWARM_RUN_DEBUG;
    else process.env.SWARM_RUN_DEBUG = origFlag;
    if (origTokens === undefined) delete process.env.SWARM_APP_TOKENS;
    else process.env.SWARM_APP_TOKENS = origTokens;
  });

  it('records nothing when SWARM_RUN_DEBUG is off', () => {
    recordRunDebugSeat('wf-off', 'manager', { promptChars: 100, limitChars: 5600, provider: 'groq' });
    recordRunDebugDrop('wf-off', 'manager', 'Cluster Digests');
    recordRunDebugEdit('wf-off', 'manager', { check: 'test', reason: 'trimmed' });
    expect(getRunDebugRecord('wf-off')).toBeUndefined();
    expect(getRunDebugRingIds()).toHaveLength(0);
  });

  it('records seat chars/limit, dropped blocks, edits, failover, scrubs keys, and evicts 1st on 11th run', async () => {
    process.env.SWARM_RUN_DEBUG = '1';

    recordRunDebugSeat('wf-1', 'manager', {
      role: 'Manager Node',
      provider: 'groq',
      promptChars: 4200,
      limitChars: 5600,
      toolResultsSent: 'MKT: spread=-1.5 apiKey=sk-secret1234567890abcdef'
    });
    recordRunDebugDrop('wf-1', 'manager', 'Historical Baselines');
    recordRunDebugEdit('wf-1', 'manager', {
      check: 'sanitizeDivergentSeatAgreement',
      before: '3/3 seats agree with gsk_secretkeyvalue12345',
      after: 'Consensus divergent',
      reason: 'Stripped divergent claim'
    });
    recordRunDebugFailover('wf-1', 'manager', 'gemini', 24000);

    const rec = getRunDebugRecord('wf-1');
    expect(rec).toBeDefined();
    expect(rec?.seats.manager.promptChars).toBe(4200);
    expect(rec?.seats.manager.limitChars).toBe(5600);
    expect(rec?.seats.manager.postFailoverProvider).toBe('gemini');
    expect(rec?.seats.manager.postFailoverLimitChars).toBe(24000);
    expect(rec?.seats.manager.droppedBlocks).toContain('Historical Baselines');
    expect(rec?.seats.manager.edits).toHaveLength(1);

    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain('sk-secret1234567890abcdef');
    expect(serialized).not.toContain('gsk_secretkeyvalue12345');

    // Ring buffer of 10: 11th run evicts wf-1
    for (let i = 2; i <= 11; i++) {
      recordRunDebugSeat(`wf-${i}`, 'critic', { promptChars: 1000 + i, limitChars: 5600, provider: 'groq' });
    }
    expect(getRunDebugRingIds()).toHaveLength(10);
    expect(getRunDebugRecord('wf-1')).toBeUndefined();
    expect(getRunDebugRecord('wf-11')).toBeDefined();

    // Route GET /api/debug/runs/:workflowId behind appAuth
    process.env.SWARM_APP_TOKENS = JSON.stringify({ testapp: 'test-token-123' });
    const app = createSwarmServer();
    const unauth = await app.request('/api/debug/runs/wf-11');
    expect(unauth.status).toBe(401);

    const res = await app.request('/api/debug/runs/wf-11', {
      headers: { Authorization: 'Bearer test-token-123' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflowId).toBe('wf-11');

    const missing = await app.request('/api/debug/runs/wf-1', {
      headers: { Authorization: 'Bearer test-token-123' }
    });
    expect(missing.status).toBe(404);
  });
});
