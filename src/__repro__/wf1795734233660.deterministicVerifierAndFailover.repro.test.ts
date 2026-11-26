import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { SwarmContext } from '../swarm/context.ts';
import { globalProviderLimiter } from '../swarm/providers/limiter.ts';
import { MANAGER_CHAIN, buildManagerChain } from '../swarm/engine/managerChain.ts';
import {
  auditCriticPremiseContradictions,
  dedupePicksByDistinctEventId
} from '../swarm/tools/claimGrounding.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { discoverLiveModels, clearLiveModelsCache } from '../swarm/server/liveModels.ts';

describe('wf-1795734233660: Deterministic Verifier, 18s Zero-Retry Timeouts, Non-Google Failover, Partial-Veto Survival & /models/live Hygiene', () => {
  beforeEach(() => {
    globalProviderLimiter.reset();
    clearLiveModelsCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('S1: clean manager output passes deterministic verification with 0 LLM verifier calls and logs local/deterministic-verifier', async () => {
    const manager = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'simulated', 'mock-key');
    const critic = new Agent('Verification Critic', 'gemini-4-hydrogen', 'simulated', 'mock-key');
    const criticRunSpy = vi.spyOn(critic, 'run');

    const ctx = new SwarmContext();
    const lifecycle = new AnalysisLifecycle(manager, critic, 2);

    const slate = 'R9 | Buffalo Bills ML | event_id=nfl-401999 | Buffalo Bills vs New York Jets';
    const validProposal = {
      summary: 'Backing Buffalo Bills ML (R9) on grounded form and market support.',
      picks: [{ row: 'R9', side: 'Buffalo Bills ML', confidence: 0.78, reason: 'Buffalo Bills hold strong recent form.' }],
      scorecards: [{ seat: 'a1', pick: 'Buffalo Bills ML', notes: 'Approved R9.' }],
      components: [],
      criticApproved: true,
      wageringPass: false
    };
    vi.spyOn(manager, 'run').mockResolvedValueOnce(JSON.stringify(validProposal));

    const res = await lifecycle.executeAndVerify(
      { fullBoard: slate },
      ctx,
      'Evaluate NFL slate',
      'Audit NFL slate',
      ['nfl-401999']
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(1);
    expect(criticRunSpy).not.toHaveBeenCalled();

    const verifierCompleted = ctx.events.find(
      (e) => e.agentRole === 'verifier' && e.action === 'Completed execution'
    );
    expect(verifierCompleted).toBeDefined();
    expect(verifierCompleted?.modelName).toBe('local / deterministic-verifier');
    expect((verifierCompleted?.durationMs ?? 999)).toBeLessThan(50);
  });

  it('S1: invalid manager output (picks non-empty with wageringPass: true) fails deterministic Attempt 1, triggers 1 manager repair, and passes on Attempt 2 with 0 verifier LLM calls', async () => {
    const manager = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'simulated', 'mock-key');
    const critic = new Agent('Verification Critic', 'gemini-4-hydrogen', 'simulated', 'mock-key');
    const criticRunSpy = vi.spyOn(critic, 'run');
    const badProposal = {
      summary: 'Construct a parlay with R9 (Buffalo Bills ML) for strong value.',
      picks: [],
      scorecards: [],
      components: [{ type: 'DataTable', props: { title: 'Recommended Bets', rows: [{ row: 'R9', pick: 'Buffalo Bills ML' }] } }],
      criticApproved: true,
      wageringPass: true
    };
    const goodProposal = {
      summary: 'Backing Buffalo Bills ML (R9).',
      picks: [{ row: 'R9', side: 'Buffalo Bills ML', confidence: 0.8, reason: 'Clean spot.' }],
      scorecards: [],
      components: [],
      criticApproved: true,
      wageringPass: false
    };

    const managerRunSpy = vi.spyOn(manager, 'run')
      .mockResolvedValueOnce(JSON.stringify(badProposal))
      .mockResolvedValueOnce(JSON.stringify(goodProposal));

    const ctx = new SwarmContext();
    const lifecycle = new AnalysisLifecycle(manager, critic, 2);

    const res = await lifecycle.executeAndVerify(
      {
        fullBoard: 'R9 | Buffalo Bills ML | event_id=nfl-401999 | Buffalo Bills vs New York Jets'
      },
      ctx,
      'Evaluate NFL slate',
      'Audit NFL slate',
      ['nfl-401999']
    );

    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(managerRunSpy).toHaveBeenCalledTimes(2);
    expect(criticRunSpy).not.toHaveBeenCalled();
  });

  it('S2: timeout on NVIDIA aborts with zero retries (1 call), places model on 10m cooldown, and fails over; MANAGER_CHAIN is non-Google-first without gemini-4-hydrogen', async () => {
    expect(MANAGER_CHAIN[0].provider).not.toBe('gemini');
    expect(MANAGER_CHAIN.some((c) => /gemini-4-hydrogen/i.test(c.model))).toBe(false);
    expect(MANAGER_CHAIN[MANAGER_CHAIN.length - 1]).toEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite'
    });

    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-acct');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-tok');
    vi.stubEnv('GROQ_API_KEY', 'groq-tok');
    vi.stubEnv('GEMINI_API_KEY', 'gem-tok');
    const chain = buildManagerChain();
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0].provider).toBe('cloudflare');
    expect(chain.some((c) => /gemini-4-hydrogen/i.test(c.modelName || ''))).toBe(false);

    const primaryAgent = new Agent('Manager Node', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia', 'nv-key', undefined, [
      { provider: 'simulated', modelName: 'sim-fallback', apiKey: 'sim-key' }
    ]);
    primaryAgent.preserveFallbackOrder = true;

    const nvidiaTimeoutErr = new Error('[TIMEOUT] NVIDIA request timed out after 18000ms');
    const { ProviderRegistry } = await import('../swarm/providers/registry.ts');
    const origGet = ProviderRegistry.get.bind(ProviderRegistry);
    let nvidiaCalls = 0;
    let observedTimeoutMs = 0;
    vi.spyOn(ProviderRegistry, 'get').mockImplementation((prov: any) => {
      if (prov === 'nvidia') {
        return {
          call: async (opts: any) => {
            nvidiaCalls++;
            observedTimeoutMs = opts?.timeoutMs ?? 0;
            throw nvidiaTimeoutErr;
          }
        } as any;
      }
      return origGet(prov);
    });

    const ctx = new SwarmContext();
    const out = await primaryAgent.run('Test prompt', ctx, { bypassCache: true });
    expect(out).toBeTruthy();
    expect(nvidiaCalls).toBe(1);
    expect(observedTimeoutMs).toBeLessThanOrEqual(18000);
    expect(globalProviderLimiter.isAvailable('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b')).toBe(false);
  });

  it('S3 + distinct-game constraint: pipe-delimited R5 health advantage does not bleed onto R2; partial-veto preserves R9; same event_id legs are deduped', async () => {
    const slate = [
      'R9 | Buffalo Bills ML | event_id=nfl-401999 | Buffalo Bills vs New York Jets',
      'R5 | TCU Horned Frogs +14.5 | event_id=ncaaf-401856879 | TCU Horned Frogs @ Texas Tech Red Raiders',
      'R2 | Kansas City Chiefs -3.5 | event_id=nfl-401998 | Kansas City Chiefs vs Las Vegas Raiders',
      'R3 | New York Jets ML | event_id=nfl-401999 | Buffalo Bills vs New York Jets'
    ].join('\n');

    const evidence = [
      'EVENT ncaaf-401856879',
      'Health Balance: symmetric (TCU Horned Frogs 2 OUT/0 Q vs Texas Tech Red Raiders 2 OUT/0 Q)',
      'EVENT nfl-401998',
      'Health Balance: symmetric (Kansas City Chiefs 1 OUT/0 Q vs Las Vegas Raiders 1 OUT/0 Q)',
      'EVENT nfl-401999',
      'Health Balance: home_advantage (Buffalo Bills 0 OUT/0 Q vs New York Jets 3 OUT/0 Q)'
    ].join('\n');

    const digestProposal = {
      picks: [
        {
          row: 'R2',
          side: 'Kansas City Chiefs -3.5',
          reason: 'Kansas City Chiefs hold line value.'
        }
      ],
      analysis:
        '- [Market Proposer] Proposed 2 leg(s): R5 TCU Horned Frogs (conf 0.7) — Steam and health advantage | R2 Kansas City Chiefs -3.5 (conf 0.72) — Line value.'
    };
    const premiseAudit = auditCriticPremiseContradictions(digestProposal, evidence, slate);
    expect(premiseAudit.flags).not.toContain('symmetric_injury_misread');

    const dupCandidates = [
      { row: 'R9', event_id: 'nfl-401999', side: 'Buffalo Bills ML', confidence: 0.82 },
      { row: 'R3', event_id: 'nfl-401999', side: 'New York Jets ML', confidence: 0.55 },
      { row: 'R2', event_id: 'nfl-401998', side: 'Kansas City Chiefs -3.5', confidence: 0.74 }
    ];
    const deduped = dedupePicksByDistinctEventId(dupCandidates, [], slate);
    expect(deduped.map((p) => p.row)).toEqual(['R9', 'R2']);

    const manager = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'simulated', 'mock-key');
    const critic = new Agent('Verification Critic', 'gemini-3.5-flash-lite', 'simulated', 'mock-key');
    const ctx = new SwarmContext();

    const compiledWithMixedLegs = {
      summary: 'Parlay Buffalo Bills ML (R9) and TCU Horned Frogs +14.5 (R5).',
      picks: [
        { row: 'R9', event_id: 'nfl-401999', side: 'Buffalo Bills ML', confidence: 0.82, reason: 'Asymmetric injury edge for Buffalo Bills.' },
        { row: 'R5', event_id: 'ncaaf-401856879', side: 'TCU Horned Frogs +14.5', confidence: 0.7, reason: 'Health advantage for TCU.' }
      ],
      scorecards: [],
      components: [],
      criticApproved: true,
      wageringPass: false
    };
    const survivingProposal = {
      summary: 'Backing Buffalo Bills ML (R9).',
      picks: [
        { row: 'R9', event_id: 'nfl-401999', side: 'Buffalo Bills ML', confidence: 0.82, reason: 'Asymmetric injury edge for Buffalo Bills.' }
      ],
      scorecards: [],
      components: [],
      criticApproved: true,
      wageringPass: false
    };
    vi.spyOn(manager, 'run')
      .mockResolvedValueOnce(JSON.stringify(compiledWithMixedLegs))
      .mockResolvedValueOnce(JSON.stringify(survivingProposal));

    const vp = await runDeepAnalysisVerification({
      task: 'Evaluate NFL + NCAAF slate',
      rawInput: slate,
      effectiveDynamicPrompt: '',
      effectiveCompiledReports: JSON.stringify(compiledWithMixedLegs),
      effectiveHistoricalContext: '',
      managerAgent: manager,
      analysts: [manager],
      dedicatedCriticAgent: critic,
      context: ctx,
      toolResults: evidence,
      criticVetoes: ['symmetric_injury_misread: R5 TCU Horned Frogs claims health advantage on symmetric matchup.'],
      vetoedLegs: [{ rowId: 'R5', eventId: 'ncaaf-401856879', teamLabel: 'TCU Horned Frogs', teamAliases: ['tcu'], reason: 'symmetric_injury_misread' }],
      criticVerdictApproved: true
    });

    expect(vp.finalAnalysis.picks.map((p: any) => p.row)).toEqual(['R9']);
    expect(vp.finalAnalysis.criticApproved).toBe(true);
    expect(vp.finalAnalysis.wageringPass).toBe(false);
  });

  it('S4: /models/live uses concise Cloudflare slug labels (never description) and excludes non-chat models across providers', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.cloudflare.com')) {
        return {
          ok: true,
          json: async () => ({
            result: [
              {
                name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                description: 'Llama 3.3 70B quantized to fp8 for ultra-fast inference...'
              },
              {
                name: '@cf/meta/llama-guard-3-8b',
                description: 'Safety guard model'
              }
            ]
          })
        } as any;
      }
      if (url.includes('integrate.api.nvidia.com')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
              { id: 'fastino/gliner2-pii' },
              { id: 'nvidia/ising-calibration-1.5-31b' },
              { id: 'nvidia/nvclip' }
            ]
          })
        } as any;
      }
      if (url.includes('api.groq.com')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'qwen/qwen3.8-27b' },
              { id: 'canopylabs/orpheus-v1-english' }
            ]
          })
        } as any;
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.5-transcribe', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        } as any;
      }
      return { ok: true, text: async () => '' } as any;
    });

    const cfRes = await discoverLiveModels(
      'cloudflare',
      { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'tok' },
      { refresh: true, fetchFn: fetchMock as any }
    );
    expect(cfRes.models).toEqual([
      {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        label: 'meta/llama-3.3-70b-instruct-fp8-fast',
        freeTierVerified: true
      }
    ]);

    const nvRes = await discoverLiveModels(
      'nvidia',
      { NVIDIA_API_KEY: 'nv-key' },
      { refresh: true, fetchFn: fetchMock as any }
    );
    expect(nvRes.models.map((m) => m.id)).toEqual(['nvidia/nemotron-3.5-lightning-30b-a3b']);

    const groqRes = await discoverLiveModels(
      'groq',
      { GROQ_API_KEY: 'groq-key' },
      { refresh: true, fetchFn: fetchMock as any }
    );
    expect(groqRes.models.map((m) => m.id)).toEqual(['qwen/qwen3.8-27b']);

    const gemRes = await discoverLiveModels(
      'gemini',
      { GEMINI_API_KEY: 'gem-key' },
      { refresh: true, fetchFn: fetchMock as any }
    );
    expect(gemRes.models.map((m) => m.id)).toEqual(['gemini-3.5-flash-lite']);
  });
});
