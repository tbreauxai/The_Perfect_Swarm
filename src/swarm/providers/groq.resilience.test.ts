import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GroqAdapter, computeGroqScorecardMaxTokens, pruneInputHistory } from './groq.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { ProviderRegistry } from './registry.ts';

describe('Adaptive Token Capping & Fallback Chain (groq.ts & agentResolution.ts)', () => {
    describe('Groq input history pruning under 7,000 TPM limit', () => {
        it('pruneInputHistory removes historical context and baselines', () => {
            const prompt = `Task: Analyze game\nHistorical Baselines: Team A won 5 consecutive games with high tempo.\nMetadata: {"season": 2026}\nData Chunk [1/1]: Game data`;
            const pruned = pruneInputHistory(prompt);
            expect(pruned).not.toContain('Historical Baselines');
            expect(pruned).toContain('Task: Analyze game');
            expect(pruned).toContain('Data Chunk [1/1]: Game data');
        });

        it('computeGroqScorecardMaxTokens prunes input history before rejecting under 7,000 TPM limit', () => {
            const history = 'Historical Baselines: ' + 'Past game stats and baseline analysis\n'.repeat(250);
            const prompt = `Task: Analyze\n${history}\nData Chunk: Data`;
            expect(prompt.length).toBeGreaterThan(8000);

            // Passing prompt text allows pruning to fit under budget
            const tokens = computeGroqScorecardMaxTokens(800, 25_000, prompt);
            expect(tokens).toBe(800); // Successfully pruned, returns full 800 cap instead of being rejected!
        });

        it('GroqAdapter.call prunes input history to fit under 7,000 TPM limit instead of throwing LimiterSkipError', async () => {
            let capturedBody: any = null;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
                capturedBody = JSON.parse(init.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"status":"ok"}' } }],
                        usage: { total_tokens: 15 }
                    })
                };
            }) as any;

            try {
                const history = 'Historical Baselines: ' + 'History line data\n'.repeat(300);
                const prompt = `Task: Line check\n${history}\nData: R12 line data`;
                // System instruction + prompt exceeds 24,800 chars, but history can be pruned
                const adapter = new GroqAdapter();
                const res = await adapter.call({
                    modelName: 'openai/gpt-oss-120b',
                    prompt,
                    systemInstruction: 's'.repeat(16_000),
                    apiKey: 'gsk-mock-key',
                    role: 'Scorecard Analyst',
                    config: { groqMode: 'chat', maxTokensCap: 800 }
                });

                expect(res).toBeDefined();
                expect(capturedBody).toBeDefined();
                expect(capturedBody.max_tokens).toBe(800);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    describe('Fallback preservation on transient rate limits (429) & limiter skips even with disableFallback', () => {
        beforeEach(() => {
            ProviderRegistry.register({
                providerName: 'mock-failing-provider',
                async call() {
                    throw new Error('[RATE_LIMIT_429] Groq rate limit / quota exceeded (retry-after: 5s)');
                }
            } as any);

            ProviderRegistry.register({
                providerName: 'mock-limiter-skip-provider',
                async call() {
                    throw new Error('[LIMITER_SKIP] Groq token budget exceeded; skipping Groq');
                }
            } as any);

            ProviderRegistry.register({
                providerName: 'mock-fallback-provider',
                async call() {
                    return JSON.stringify({
                        status: 'ok',
                        recovered: true,
                        insights: ['Recovered via fallback provider']
                    });
                }
            } as any);
        });

        it('fails over to backup provider on 429 even when disableFallback is true', async () => {
            const agent = new Agent(
                'Resilient Analyst',
                'model-1',
                'mock-failing-provider' as any,
                'key-1',
                undefined,
                [{ provider: 'mock-fallback-provider' as any, modelName: 'fb-model', apiKey: 'fb-key' }]
            );
            agent.disableFallback = true; // disableFallback toggled

            const ctx = new SwarmContext();
            const output = await agent.run('Task prompt', ctx, { responseMimeType: 'application/json' });
            expect(output).toBeDefined();
            expect(output.recovered).toBe(true);

            // Failover event should be recorded
            const failoverEvent = ctx.events.find(e => e.action === 'Provider Failover Triggered');
            expect(failoverEvent).toBeDefined();
        });

        it('fails over to backup provider on limiter skip even when disableFallback is true', async () => {
            const agent = new Agent(
                'Resilient Analyst',
                'model-2',
                'mock-limiter-skip-provider' as any,
                'key-1',
                undefined,
                [{ provider: 'mock-fallback-provider' as any, modelName: 'fb-model', apiKey: 'fb-key' }]
            );
            agent.disableFallback = true; // disableFallback toggled

            const ctx = new SwarmContext();
            const output = await agent.run('Task prompt', ctx, { responseMimeType: 'application/json' });
            expect(output).toBeDefined();
            expect(output.recovered).toBe(true);
        });

        it('does NOT fail over on non-transient non-limiter errors (like 400) when disableFallback is true', async () => {
            ProviderRegistry.register({
                providerName: 'mock-bad-request-provider',
                async call() {
                    throw new Error('Mock API Error (400): Bad request');
                }
            } as any);

            const agent = new Agent(
                'Resilient Analyst',
                'model-3',
                'mock-bad-request-provider' as any,
                'key-1',
                undefined,
                [{ provider: 'mock-fallback-provider' as any, modelName: 'fb-model', apiKey: 'fb-key' }]
            );
            agent.disableFallback = true;

            const ctx = new SwarmContext();
            await expect(
                agent.run('Task prompt', ctx, { responseMimeType: 'application/json' })
            ).rejects.toThrow(/Bad request/);
        });
    });
});
