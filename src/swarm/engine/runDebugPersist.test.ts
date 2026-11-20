import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearRunDebugRecords,
  recordRunDebugDrop,
  recordRunDebugEdit,
  recordRunDebugFailover,
  recordRunDebugSeat
} from './runDebugRecord.ts';
import { isRunDebugPersistEnabled, persistRunDebugRecord } from './runDebugPersist.ts';
import { executeSwarmWorkflow } from './index.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { SwarmContext } from '../context.ts';

describe('runDebugPersist (S0 / S2)', () => {
  const origDebug = process.env.SWARM_RUN_DEBUG;
  const origPersist = process.env.SWARM_RUN_DEBUG_PERSIST;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    clearRunDebugRecords();
    delete process.env.SWARM_RUN_DEBUG;
    delete process.env.SWARM_RUN_DEBUG_PERSIST;
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret-test';
  });

  afterEach(() => {
    clearRunDebugRecords();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (origDebug === undefined) delete process.env.SWARM_RUN_DEBUG;
    else process.env.SWARM_RUN_DEBUG = origDebug;
    if (origPersist === undefined) delete process.env.SWARM_RUN_DEBUG_PERSIST;
    else process.env.SWARM_RUN_DEBUG_PERSIST = origPersist;
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  });

  it('flag off -> isRunDebugPersistEnabled is false and no fetch is sent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(isRunDebugPersistEnabled()).toBe(false);
    await persistRunDebugRecord('wf-off');

    process.env.SWARM_RUN_DEBUG = '1';
    expect(isRunDebugPersistEnabled()).toBe(false);
    await persistRunDebugRecord('wf-off');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flag on -> upserts {workflow_id, created_at, payload} with scrubbed & capped seats and sends 7d TTL delete', async () => {
    process.env.SWARM_RUN_DEBUG = '1';
    process.env.SWARM_RUN_DEBUG_PERSIST = '1';
    expect(isRunDebugPersistEnabled()).toBe(true);

    recordRunDebugSeat('wf-persist-1', 'manager', {
      role: 'Manager Node',
      provider: 'groq',
      promptChars: 5100,
      limitChars: 5600,
      toolResultsSent: 'MKT: spread=-1.5 key=sk-secret1234567890abcdef ' + 'x'.repeat(250_000)
    });
    recordRunDebugDrop('wf-persist-1', 'manager', 'Cluster Digests');
    recordRunDebugEdit('wf-persist-1', 'manager', {
      check: 'sanitizeDivergentSeatAgreement',
      before: '3/3 agree',
      after: 'divergent',
      reason: 'stripped'
    });
    recordRunDebugFailover('wf-persist-1', 'manager', 'gemini', 24000);

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response('', { status: 201 });
    }));

    await persistRunDebugRecord('wf-persist-1');

    expect(calls).toHaveLength(2);
    const [postCall, deleteCall] = calls;
    expect(postCall.url).toBe('https://example.supabase.co/rest/v1/swarm_run_debug');
    expect(postCall.init.method).toBe('POST');
    const headers = postCall.init.headers as Record<string, string>;
    expect(headers.Prefer).toContain('resolution=merge-duplicates');

    const bodyStr = String(postCall.init.body);
    expect(bodyStr.length).toBeLessThanOrEqual(210_000);
    expect(bodyStr).not.toContain('sk-secret1234567890abcdef');
    expect(bodyStr).not.toContain('service-role-secret-test');

    const parsed = JSON.parse(bodyStr);
    expect(parsed.workflow_id).toBe('wf-persist-1');
    expect(typeof parsed.created_at).toBe('string');
    expect(parsed.payload.seats.manager.promptChars).toBe(5100);
    expect(parsed.payload.seats.manager.limitChars).toBe(5600);
    expect(parsed.payload.seats.manager.postFailoverProvider).toBe('gemini');
    expect(parsed.payload.seats.manager.postFailoverLimitChars).toBe(24000);
    expect(parsed.payload.seats.manager.droppedBlocks).toContain('Cluster Digests');
    expect(parsed.payload.seats.manager.edits).toHaveLength(1);
    expect(parsed.payload.seats.manager.toolResultsSent).toContain('[trimmed]');

    expect(deleteCall.init.method).toBe('DELETE');
    expect(deleteCall.url).toMatch(/^https:\/\/example\.supabase\.co\/rest\/v1\/swarm_run_debug\?created_at=lt\./);
  });

  it('never throws when fetch fails', async () => {
    process.env.SWARM_RUN_DEBUG = '1';
    process.env.SWARM_RUN_DEBUG_PERSIST = '1';
    recordRunDebugSeat('wf-err', 'critic', { promptChars: 100, limitChars: 5600, provider: 'groq' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await expect(persistRunDebugRecord('wf-err')).resolves.toBeUndefined();
  });

  it('executeSwarmWorkflow calls persist once when enabled and never when disabled', async () => {
    ProviderRegistry.register({
      providerName: 'custom-mock',
      async call() {
        return JSON.stringify({ summary: 'ok', insights: ['ok'], ui_title: 'ok' });
      }
    } as any);

    const fetchSpy = vi.fn(async () => new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const baseSettings = {
      appId: 'test-persist-hook',
      agents: [
        { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k', model: 'm' },
        { id: 'a1', role: 'Quant Analyst', provider: 'custom-mock', apiKey: 'k', model: 'm' }
      ]
    };

    const ctxOff = new SwarmContext();
    (ctxOff as any).id = 'wf-hook-off';
    await executeSwarmWorkflow({
      task: 'Hello',
      context: ctxOff,
      forceFullSwarm: true,
      bypassCache: true,
      settings: baseSettings as any
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.SWARM_RUN_DEBUG = '1';
    process.env.SWARM_RUN_DEBUG_PERSIST = '1';
    const ctxOn = new SwarmContext();
    (ctxOn as any).id = 'wf-hook-on';
    await executeSwarmWorkflow({
      task: 'Hello',
      context: ctxOn,
      forceFullSwarm: true,
      bypassCache: true,
      settings: baseSettings as any
    });

    await new Promise(r => setTimeout(r, 20));
    const postCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/rest/v1/swarm_run_debug') && (c[1] as any)?.method === 'POST');
    expect(postCalls).toHaveLength(1);
  });
});
