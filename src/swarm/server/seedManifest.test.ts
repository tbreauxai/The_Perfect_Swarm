import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const { execMock } = vi.hoisted(() => ({
  execMock: vi.fn(async (params: any) => ({
    workflowId: 'test-wf-id',
    finalAnalysis: {
      verdict: 'VALUE_FOUND',
      confidence: 0.82
    }
  }))
}));

vi.mock('../engine/index.ts', async (orig) => {
  const real: any = await orig();
  return { ...real, executeSwarmWorkflow: execMock };
});

import { registerAnalyzeRoutes } from './routes/analyze.ts';
import {
  SEED_MANIFEST_VERSION,
  isSeedManifestRequest,
  validateSeedManifestRequest,
  seedManifestStubData,
  SeedManifest
} from './slimPayload.ts';
import { ToolRegistry } from '../tools/registry.ts';

function createValidSeedManifest(overrides: Partial<SeedManifest> = {}): SeedManifest {
  return {
    manifest_version: SEED_MANIFEST_VERSION,
    candidate_id: 'cand-kc-buf-ml',
    game_id: 'game-kc-buf-2026',
    sport: 'americanfootball_nfl',
    market_type: 'moneyline',
    pricing: {
      selection: 'KC',
      book_odds: -130,
      fair_prob: 0.58,
      line: -2.5
    },
    flags: {
      is_dome: false,
      hours_to_kickoff: 4.5,
      has_active_injury_tags: true
    },
    available_tools: ['calculator', 'injury_lookup'],
    task: 'Analyze candidate moneyline value',
    ...overrides
  };
}

describe('SeedManifest Contract & Validation', () => {
  it('identifies seed manifest requests correctly with isSeedManifestRequest', () => {
    expect(isSeedManifestRequest(createValidSeedManifest())).toBe(true);
    expect(isSeedManifestRequest({ payload: 'slim-v1' })).toBe(false);
    expect(isSeedManifestRequest(null)).toBe(false);
    expect(isSeedManifestRequest(undefined)).toBe(false);
    expect(isSeedManifestRequest('string')).toBe(false);
    expect(isSeedManifestRequest({})).toBe(false);
    expect(isSeedManifestRequest({ manifest_version: 'v1' })).toBe(false);
  });

  it('validates a correct SeedManifest with null error', () => {
    const manifest = createValidSeedManifest();
    expect(validateSeedManifestRequest(manifest)).toBeNull();
  });

  it('rejects missing or empty candidate_id', () => {
    const manifest1 = createValidSeedManifest({ candidate_id: '' });
    expect(validateSeedManifestRequest(manifest1)).toContain('missing or empty candidate_id');

    const manifest2 = createValidSeedManifest({ candidate_id: undefined as any });
    expect(validateSeedManifestRequest(manifest2)).toContain('missing or empty candidate_id');
  });

  it('rejects missing or empty game_id', () => {
    const manifest = createValidSeedManifest({ game_id: '' });
    expect(validateSeedManifestRequest(manifest)).toContain('missing or empty game_id');
  });

  it('rejects missing or empty sport', () => {
    const manifest = createValidSeedManifest({ sport: '  ' });
    expect(validateSeedManifestRequest(manifest)).toContain('missing or empty sport');
  });

  it('rejects missing or empty market_type', () => {
    const manifest = createValidSeedManifest({ market_type: '' });
    expect(validateSeedManifestRequest(manifest)).toContain('missing or empty market_type');
  });

  it('rejects malformed pricing', () => {
    const invalidPricing1 = createValidSeedManifest({ pricing: null as any });
    expect(validateSeedManifestRequest(invalidPricing1)).toContain('missing or invalid pricing');

    const invalidPricing2 = createValidSeedManifest({
      pricing: { selection: '', book_odds: -110, fair_prob: 0.5 }
    });
    expect(validateSeedManifestRequest(invalidPricing2)).toContain('pricing.selection');

    const invalidPricing3 = createValidSeedManifest({
      pricing: { selection: 'KC', book_odds: NaN, fair_prob: 0.5 }
    });
    expect(validateSeedManifestRequest(invalidPricing3)).toContain('pricing.book_odds');

    const invalidPricing4 = createValidSeedManifest({
      pricing: { selection: 'KC', book_odds: -110, fair_prob: 'high' as any }
    });
    expect(validateSeedManifestRequest(invalidPricing4)).toContain('pricing.fair_prob');
  });

  it('rejects malformed flags', () => {
    const invalidFlags1 = createValidSeedManifest({ flags: null as any });
    expect(validateSeedManifestRequest(invalidFlags1)).toContain('missing or invalid flags');

    const invalidFlags2 = createValidSeedManifest({
      flags: { is_dome: 'yes' as any, hours_to_kickoff: 2, has_active_injury_tags: false }
    });
    expect(validateSeedManifestRequest(invalidFlags2)).toContain('flags.is_dome');

    const invalidFlags3 = createValidSeedManifest({
      flags: { is_dome: true, hours_to_kickoff: NaN, has_active_injury_tags: false }
    });
    expect(validateSeedManifestRequest(invalidFlags3)).toContain('flags.hours_to_kickoff');

    const invalidFlags4 = createValidSeedManifest({
      flags: { is_dome: true, hours_to_kickoff: 10, has_active_injury_tags: 'no' as any }
    });
    expect(validateSeedManifestRequest(invalidFlags4)).toContain('flags.has_active_injury_tags');
  });

  it('rejects malformed available_tools', () => {
    const invalidTools1 = createValidSeedManifest({ available_tools: 'calculator' as any });
    expect(validateSeedManifestRequest(invalidTools1)).toContain('available_tools must be an array of strings');

    const invalidTools2 = createValidSeedManifest({ available_tools: [123 as any] });
    expect(validateSeedManifestRequest(invalidTools2)).toContain('available_tools must be an array of strings');
  });

  it('formats seedManifestStubData correctly', () => {
    const manifest = createValidSeedManifest();
    const stub = seedManifestStubData(manifest);
    expect(stub).toContain('[SEED_MANIFEST_V2]');
    expect(stub).toContain('candidate_id=cand-kc-buf-ml');
    expect(stub).toContain('game_id=game-kc-buf-2026');
    expect(stub).toContain('sport=americanfootball_nfl');
    expect(stub).toContain('market_type=moneyline');
    expect(stub).toContain('selection=KC');
    expect(stub).toContain('book_odds=-130');
    expect(stub).toContain('fair_prob=0.58');
    expect(stub).toContain('tools=calculator,injury_lookup');
  });
});

describe('SeedManifest Route Handling (/api/swarm/analyze and /api/swarm/stream)', () => {
  let executedWorkflowParams: any = null;

  function mockApp() {
    const app = new Hono();
    registerAnalyzeRoutes(app, {
      defaultSettings: {
        appId: 'duelodds',
        agents: [
          {
            id: 'manager',
            name: 'Manager',
            role: 'Manager',
            active: true,
            provider: 'simulated',
            model: 'simulated-model'
          }
        ]
      },
      defaultAi: undefined,
      defaultCortex: undefined,
      swarmBodyLimit: async (_c: any, next: any) => next()
    } as any);
    return app;
  }

  beforeEach(() => {
    execMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects malformed SeedManifest with 400 invalid_seed_manifest on analyze', async () => {
    const app = mockApp();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest_version: 'v2-seed',
        candidate_id: '', // Empty
        game_id: 'g-1'
      })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('invalid_seed_manifest');
    expect(json.error).toContain('missing or empty candidate_id');
  });

  it('rejects malformed SeedManifest with 400 invalid_seed_manifest on stream', async () => {
    const app = mockApp();
    const res = await app.request('/api/swarm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest_version: 'v2-seed',
        candidate_id: 'cand-1',
        game_id: '' // Empty
      })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('invalid_seed_manifest');
    expect(json.error).toContain('missing or empty game_id');
  });

  it('accepts valid SeedManifest on /api/swarm/analyze without data string', async () => {
    const app = mockApp();
    const manifest = createValidSeedManifest();
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest)
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.finalAnalysis).toBeDefined();
    expect(json.finalAnalysis.candidate_id).toBe('cand-kc-buf-ml');
    expect(json.finalAnalysis.verdict).toBe('VALUE_FOUND');

    // Verify workflow parameters received scoped context
    expect(execMock).toHaveBeenCalledTimes(1);
    const executedWorkflowParams = execMock.mock.calls[0][0];
    expect(executedWorkflowParams).toBeDefined();
    expect(executedWorkflowParams.candidateId).toBe('cand-kc-buf-ml');
    expect(executedWorkflowParams.marketType).toBe('moneyline');
    expect(executedWorkflowParams.eventIds).toEqual(['game-kc-buf-2026']);
    expect(executedWorkflowParams.sport).toBe('americanfootball_nfl');
    expect(executedWorkflowParams.pricing.selection).toBe('KC');
    expect(executedWorkflowParams.pricing.book_odds).toBe(-130);
    expect(executedWorkflowParams.flags.is_dome).toBe(false);
  });

  it('scopes ToolRegistry to manifest.available_tools', async () => {
    const app = mockApp();
    const manifest = createValidSeedManifest({
      available_tools: ['calculator']
    });
    const res = await app.request('/api/swarm/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest)
    });
    expect(res.status).toBe(200);

    // Verify scoped tools in executed workflow
    expect(execMock).toHaveBeenCalledTimes(1);
    const executedWorkflowParams = execMock.mock.calls[0][0];
    const tools = executedWorkflowParams?.tools;
    expect(tools).toBeDefined();
    expect(typeof tools.scoped).toBe('function');
    // Calculator should be allowed, others rejected
    expect(tools.has('calculator')).toBe(true);
    expect(tools.has('injury_lookup')).toBe(false);
  });

  it('accepts valid SeedManifest on /api/swarm/stream and initiates SSE stream', async () => {
    const app = mockApp();
    const manifest = createValidSeedManifest();
    const res = await app.request('/api/swarm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest)
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
