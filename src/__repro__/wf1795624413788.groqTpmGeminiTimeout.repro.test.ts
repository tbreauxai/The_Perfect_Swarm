import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ProviderRegistry } from '../swarm/providers/registry.ts';
import { GroqAdapter } from '../swarm/providers/groq.ts';
import { GeminiAdapter, buildGeminiRequestConfig } from '../swarm/providers/gemini.ts';
import { CloudflareAdapter } from '../swarm/providers/cloudflare.ts';
import { MistralAdapter } from '../swarm/providers/mistral.ts';
import {
  ProviderLimiter,
  globalProviderLimiter,
  FAILOVER_MAX_TPM_WAIT_MS,
} from '../swarm/providers/limiter.ts';
import {
  TokenBudgetManager,
  globalTokenBudgetManager,
} from '../swarm/loadBalancer/tokenBudgetManager.ts';
import { MANAGER_CHAIN } from '../swarm/engine/managerChain.ts';
import { selectDecoupledVerifierAgent } from '../swarm/engine/verificationPipeline.ts';
import { handleSwarmSse } from '../swarm/server/streaming.ts';

function makeClock(start: number) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('todo.md Spec (wf-1795624413788 & run_timeout): S1–S3', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    globalProviderLimiter.reset();
    globalTokenBudgetManager.reset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    globalProviderLimiter.reset();
    globalTokenBudgetManager.reset();
    ProviderRegistry.register(new GeminiAdapter());
    ProviderRegistry.register(new GroqAdapter());
    ProviderRegistry.register(new CloudflareAdapter());
    ProviderRegistry.register(new MistralAdapter());
  });

  describe('S1: Eliminate 50-60s Groq TPM Sleeps', () => {
    it('fast-skip: when Groq requires 45,000ms wait and Cloudflare/Mistral has 0ms wait, Manager failover skips Groq in < 50ms', async () => {
      expect(FAILOVER_MAX_TPM_WAIT_MS).toBe(5_000);

      // Mock Groq's bucket wait to 45,000ms and Cloudflare/Mistral to 0ms
      const waitSpy = vi
        .spyOn(globalProviderLimiter, 'budgetWaitMs')
        .mockImplementation((provider: string) => {
          if (provider === 'groq') return 45_000;
          return 0;
        });

      const calledProviders: string[] = [];
      ProviderRegistry.register({
        providerName: 'gemini',
        async call() {
          calledProviders.push('gemini');
          const err: any = new Error('[SERVER_ERROR_503] Model overloaded');
          err.status = 503;
          throw err;
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'groq',
        async call() {
          calledProviders.push('groq');
          return JSON.stringify({ ui_title: 'ShouldNotRun', summary: 'groq', components: [] });
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'cloudflare',
        async call() {
          calledProviders.push('cloudflare');
          return JSON.stringify({ ui_title: 'OK', summary: 'Completed on Cloudflare', components: [] });
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'mistral',
        async call() {
          calledProviders.push('mistral');
          return JSON.stringify({ ui_title: 'OK', summary: 'Completed on Mistral', components: [] });
        },
      } as any);

      // Even if Groq is placed ahead of Cloudflare/Mistral in an agent's fallback list,
      // the 5,000ms fast-skip gate MUST skip Groq immediately without sleeping.
      const origSleep = (globalProviderLimiter as any).sleep;
      (globalProviderLimiter as any).sleep = async () => {};
      try {
        const agent = new Agent(
          'Manager Node',
          'gemini-3.5-flash-lite',
          'gemini',
          'gem-key',
          undefined,
          [
            { provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'gsk-key' },
            { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'acc:tok' },
            { provider: 'mistral', modelName: 'mistral-small-latest', apiKey: 'mis-key' },
          ],
        );
        agent.preserveFallbackOrder = true;

        const ctx = new SwarmContext();
        const t0 = Date.now();
        const result = await agent.run('Compile final JSON analysis.', ctx, {
          responseMimeType: 'application/json',
          bypassCache: true,
        });
        const elapsedMs = Date.now() - t0;

        expect(elapsedMs).toBeLessThan(50);
        expect(result.summary).toBe('Completed on Cloudflare');
        expect(calledProviders).not.toContain('groq');
        expect(calledProviders).toContain('cloudflare');

        const skipEvent = ctx.events.find(
          (e) =>
            e.action === 'Provider Skipped' &&
            e.output?.provider === 'groq' &&
            String(e.output?.reason || '').includes('skipped_tpm_wait: 45000ms'),
        );
        expect(skipEvent).toBeDefined();
      } finally {
        (globalProviderLimiter as any).sleep = origSleep;
        waitSpy.mockRestore();
      }
    });

    it('MANAGER_CHAIN orders high-TPM Cloudflare, Mistral, OpenRouter ahead of Groq', () => {
      const providers = MANAGER_CHAIN.map((e) => e.provider);
      expect(providers.indexOf('cloudflare')).toBeLessThan(providers.indexOf('groq'));
      expect(providers.indexOf('mistral')).toBeLessThan(providers.indexOf('groq'));
      expect(providers.indexOf('openrouter')).toBeLessThan(providers.indexOf('groq'));
      expect(providers.indexOf('groq')).toBeLessThan(providers.indexOf('nvidia'));
    });

    it('per-model Groq buckets: draining groq:openai/gpt-oss-120b does NOT block groq:openai/gpt-oss-20b or groq:llama-3.3-70b-versatile', async () => {
      // 1. TokenBudgetManager per-model isolation & limits
      const tbm = new TokenBudgetManager();
      expect(tbm.getTpmLimit('groq', 'openai/gpt-oss-120b')).toBe(8000);
      expect(tbm.getTpmLimit('groq', 'openai/gpt-oss-20b')).toBe(8000);
      expect(tbm.getTpmLimit('groq', 'llama-3.3-70b-versatile')).toBe(12000);

      // Drain gpt-oss-120b completely
      tbm.recordUsage('groq', 7800, 'Risk Critic', 'openai/gpt-oss-120b');
      expect(tbm.canAllocate('groq', 1000, 'openai/gpt-oss-120b')).toBe(false);
      expect(tbm.estimateWaitMs('groq', 1000, 'openai/gpt-oss-120b')).toBeGreaterThan(50_000);

      // Separate Groq models remain completely unblocked
      expect(tbm.canAllocate('groq', 1000, 'openai/gpt-oss-20b')).toBe(true);
      expect(tbm.estimateWaitMs('groq', 1000, 'openai/gpt-oss-20b')).toBe(0);
      expect(tbm.canAllocate('groq', 10000, 'llama-3.3-70b-versatile')).toBe(true);
      expect(tbm.estimateWaitMs('groq', 10000, 'llama-3.3-70b-versatile')).toBe(0);

      // 2. ProviderLimiter per-model isolation
      const clock = makeClock(Date.UTC(2026, 10, 25, 18, 0, 0));
      const limiter = new ProviderLimiter(undefined, clock.now, clock.sleep);
      await limiter.run(
        { provider: 'groq', model: 'openai/gpt-oss-120b', estTokens: 6500 },
        async () => 'pass1-done',
      );

      // gpt-oss-120b now requires ~60s wait
      expect(limiter.budgetWaitMs('groq', 2000, 'openai/gpt-oss-120b')).toBeGreaterThan(50_000);
      // gpt-oss-20b and llama-3.3-70b-versatile have 0ms wait and execute immediately
      expect(limiter.budgetWaitMs('groq', 2000, 'openai/gpt-oss-20b')).toBe(0);
      expect(limiter.budgetWaitMs('groq', 9000, 'llama-3.3-70b-versatile')).toBe(0);

      const out20b = await limiter.run(
        { provider: 'groq', model: 'openai/gpt-oss-20b', estTokens: 2000 },
        async () => 'ok-20b',
      );
      const out70b = await limiter.run(
        { provider: 'groq', model: 'llama-3.3-70b-versatile', estTokens: 9000 },
        async () => 'ok-70b',
      );
      expect(out20b).toBe('ok-20b');
      expect(out70b).toBe('ok-70b');
      expect(clock.sleeps).toHaveLength(0);
    });

    it('decouples Critic Verification from Risk Critic Pass 1 Groq bucket', () => {
      vi.stubEnv('GEMINI_API_KEY', 'gem-test-key');
      vi.stubEnv('CLOUDFLARE_API_TOKEN', 'acc:cf-test-key');
      vi.stubEnv('GROQ_API_KEY', 'gsk-test-key');

      const managerAgent = new Agent('Manager Node', 'gemini-3.5-flash-lite', 'gemini', 'gem-test-key');
      const pass1Critic = new Agent('Risk Critic', 'openai/gpt-oss-120b', 'groq', 'gsk-test-key');
      const ctx = new SwarmContext();
      ctx.addEvent({
        agentRole: 'Risk Critic',
        action: 'Completed execution',
        modelName: 'groq / openai/gpt-oss-120b',
        prompt: 'Audit picks',
      });
      globalTokenBudgetManager.recordUsage('groq', 7500, 'Risk Critic', 'openai/gpt-oss-120b');

      // With Gemini available, routes Verification to 0ms-wait Gemini (different model from Manager)
      const decoupledGemini = selectDecoupledVerifierAgent({
        baseCriticAgent: pass1Critic,
        managerAgent,
        analysts: [pass1Critic],
        context: ctx,
      });
      expect(decoupledGemini.provider).toBe('gemini');
      expect(decoupledGemini.modelName).toBe('gemini-3.1-flash-lite');

      // Without Gemini, routes Verification to Cloudflare @cf/meta/llama-3.3-70b-instruct-fp8-fast
      vi.stubEnv('GEMINI_API_KEY', '');
      const decoupledCf = selectDecoupledVerifierAgent({
        baseCriticAgent: pass1Critic,
        managerAgent,
        analysts: [pass1Critic],
        context: ctx,
      });
      expect(decoupledCf.provider).toBe('cloudflare');
      expect(decoupledCf.modelName).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

      // Without Gemini or Cloudflare, routes Verification to separate Groq model (openai/gpt-oss-20b)
      vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
      const decoupledGroq20b = selectDecoupledVerifierAgent({
        baseCriticAgent: pass1Critic,
        managerAgent,
        analysts: [pass1Critic],
        context: ctx,
      });
      expect(decoupledGroq20b.provider).toBe('groq');
      expect(decoupledGroq20b.modelName).toBe('openai/gpt-oss-20b');
    });

    it('Groq request to openai/gpt-oss-120b includes reasoning_effort: "low" and max_completion_tokens <= 1500', async () => {
      let capturedBody: any = null;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"pass":true,"feedback":"OK"}' } }],
            usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as any;

      const adapter = new GroqAdapter();
      await adapter.call({
        modelName: 'openai/gpt-oss-120b',
        prompt: 'Audit the proposed picks strictly against tool evidence.',
        apiKey: 'gsk-test-key',
        role: 'Risk Critic',
        config: {
          responseMimeType: 'application/json',
          maxTokens: 3000,
        },
      });

      expect(capturedBody).not.toBeNull();
      expect(capturedBody.reasoning_effort).toBe('low');
      expect(capturedBody.max_completion_tokens).toBeLessThanOrEqual(1500);
      expect(capturedBody.max_completion_tokens).toBeGreaterThan(0);
      expect(capturedBody.max_tokens).toBeLessThanOrEqual(1500);
    });
  });

  describe('S2: Gemini 3.x/4.x Param Hygiene & Per-Hop Failover Telemetry', () => {
    it('omits thinking_budget and deprecated Gemini 2.5 params on gemini-3.5-flash-lite, gemini-3.8-flash, and gemini-4-hydrogen', () => {
      const dirtyOptions: any = {
        modelName: 'gemini-3.5-flash-lite',
        prompt: 'Compile JSON',
        apiKey: 'AIza-test',
        config: {
          responseMimeType: 'application/json',
          thinking_budget: 2048,
          thinkingBudget: 2048,
          thinkingConfig: { thinkingBudget: 1024, thinking_budget: 1024 },
          temperature: 0.2,
          topP: 0.9,
          top_p: 0.9,
          topK: 40,
          top_k: 40,
          candidateCount: 1,
          candidate_count: 1,
        },
      };

      for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen']) {
        const cfg = buildGeminiRequestConfig(model, { ...dirtyOptions, modelName: model });
        expect(cfg.thinking_budget).toBeUndefined();
        expect(cfg.thinkingBudget).toBeUndefined();
        expect(cfg.thinkingConfig?.thinking_budget).toBeUndefined();
        expect(cfg.thinkingConfig?.thinkingBudget).toBeUndefined();
        expect(cfg.thinkingConfig?.thinkingLevel).toBe('LOW');
        expect(cfg.top_p).toBeUndefined();
        expect(cfg.top_k).toBeUndefined();
        expect(cfg.candidate_count).toBeUndefined();

        if (model === 'gemini-4-hydrogen') {
          expect(cfg.temperature).toBeUndefined();
          expect(cfg.topP).toBeUndefined();
          expect(cfg.topK).toBeUndefined();
          expect(cfg.candidateCount).toBeUndefined();
        }
      }
    });

    it('records exact HTTP status (400 / 503) and secret-redacted errorSnippet (<= 160 chars) in failover events', async () => {
      const longTail = 'x'.repeat(240);
      ProviderRegistry.register({
        providerName: 'gemini',
        async call(opts: any) {
          if (opts.modelName === 'gemini-3.5-flash-lite') {
            const err: any = new Error(
              `Gemini API Error (400): INVALID_ARGUMENT bad field key=AIzaSySecretKey1234567890 ${longTail}`,
            );
            err.status = 400;
            throw err;
          }
          const err: any = new Error(
            'Gemini API Error (503): Service overloaded with Bearer sk-secret-token-abcdef123456',
          );
          err.status = 503;
          throw err;
        },
      } as any);
      ProviderRegistry.register({
        providerName: 'cloudflare',
        async call() {
          return JSON.stringify({ ui_title: 'OK', summary: 'Recovered on Cloudflare', components: [] });
        },
      } as any);

      const origSleep = (globalProviderLimiter as any).sleep;
      (globalProviderLimiter as any).sleep = async () => {};
      try {
        const agent = new Agent(
          'Manager Node',
          'gemini-3.5-flash-lite',
          'gemini',
          'gem-key',
          undefined,
          [
            { provider: 'gemini', modelName: 'gemini-3.1-flash-lite', apiKey: 'gem-key' },
            { provider: 'cloudflare', modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: 'acc:tok' },
          ],
        );
        agent.preserveFallbackOrder = true;

        const ctx = new SwarmContext();
        const res = await agent.run('Compile report', ctx, {
          responseMimeType: 'application/json',
          bypassCache: true,
        });
        expect(res.summary).toBe('Recovered on Cloudflare');

        const failoverEvents = ctx.events.filter((e) => e.action === 'Provider Failover Triggered');
        const hop400 = failoverEvents.find((e) => e.failover?.fromModel === 'gemini-3.5-flash-lite');
        const hop503 = failoverEvents.find((e) => e.failover?.fromModel === 'gemini-3.1-flash-lite');

        expect(hop400).toBeDefined();
        expect(hop400?.failover?.fromProvider).toBe('gemini');
        expect(hop400?.failover?.fromModel).toBe('gemini-3.5-flash-lite');
        expect(hop400?.failover?.status).toBe(400);
        expect(hop400?.failover?.errorSnippet).toBeDefined();
        expect(hop400!.failover!.errorSnippet!.length).toBeLessThanOrEqual(160);
        expect(hop400!.failover!.errorSnippet!).not.toContain('AIzaSySecretKey1234567890');
        expect(hop400!.failover!.errorSnippet!).toContain('[REDACTED]');

        expect(hop503).toBeDefined();
        expect(hop503?.failover?.fromProvider).toBe('gemini');
        expect(hop503?.failover?.fromModel).toBe('gemini-3.1-flash-lite');
        expect(hop503?.failover?.status).toBe(503);
        expect(hop503?.failover?.errorSnippet).toBeDefined();
        expect(hop503!.failover!.errorSnippet!.length).toBeLessThanOrEqual(160);
        expect(hop503!.failover!.errorSnippet!).not.toContain('sk-secret-token-abcdef123456');
        expect(hop503!.failover!.errorSnippet!).toContain('[REDACTED]');
      } finally {
        (globalProviderLimiter as any).sleep = origSleep;
      }
    });
  });

  describe('S3: Structured Diagnostics When run_timeout Fires', () => {
    it('emits workflowId, lastStage, activeSeat, activeProvider, activeModel, and elapsedMs in swarm_error on run_timeout', async () => {
      const origEnv = process.env.SWARM_RUN_DEADLINE_MS;
      process.env.SWARM_RUN_DEADLINE_MS = '40';

      try {
        const { Hono } = await import('hono');
        const app = new Hono();
        const ctx = new SwarmContext();
        (ctx as any).id = 'wf-local-20261125175946-e7r1nu';

        app.get('/sse', async (c) => {
          return handleSwarmSse(c, {
            prompt: 'Analyze NBA slate',
            data: 'slate',
            context: ctx,
            workflowExecutor: async (p: any) => {
              await p.onStage?.({ stage: 'verification' });
              await p.onEvent?.({
                id: 'ev-1',
                timestamp: new Date().toISOString(),
                agentRole: 'Risk Critic',
                action: 'Started execution',
                modelName: 'groq / openai/gpt-oss-120b',
                prompt: 'Verify proposal',
              });
              // Stall past deadline
              await new Promise((resolve) => setTimeout(resolve, 200));
              return { status: 'complete', picks: [] } as any;
            },
          } as any);
        });

        const res = await app.request('/sse');
        const text = await res.text();

        expect(text).toContain('event: swarm_error');
        expect(text).not.toContain('event: swarm_complete');

        // Parse the swarm_error data JSON payload
        const match = text.match(/event:\s*swarm_error\s*\ndata:\s*(\{[^\n]+\})/);
        expect(match).not.toBeNull();
        const errPayload = JSON.parse(match![1]);

        expect(errPayload.error).toBe('run_timeout');
        expect(errPayload.workflowId).toBe('wf-local-20261125175946-e7r1nu');
        expect(errPayload.lastStage).toBe('verification');
        expect(errPayload.activeSeat).toBe('Risk Critic');
        expect(errPayload.activeProvider).toBe('groq');
        expect(errPayload.activeModel).toBe('openai/gpt-oss-120b');
        expect(typeof errPayload.elapsedMs).toBe('number');
        expect(errPayload.elapsedMs).toBeGreaterThanOrEqual(30);
      } finally {
        if (origEnv === undefined) delete process.env.SWARM_RUN_DEADLINE_MS;
        else process.env.SWARM_RUN_DEADLINE_MS = origEnv;
      }
    });
  });
});
