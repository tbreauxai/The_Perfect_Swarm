import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroqAdapter, capGroqPrompt, computeGroqMaxTokens } from './groq.ts';

describe('GroqAdapter Token Budget & Payload Sizing', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('capGroqPrompt', () => {
        it('preserves prompt under 6,000 characters', () => {
            const shortPrompt = 'Analyze the matchup: Dallas Cowboys @ Philadelphia Eagles.';
            expect(capGroqPrompt(shortPrompt)).toBe(shortPrompt);
        });

        it('cuts alternate markets and old news first when over 6,000 characters', () => {
            const head = 'Task: Dallas @ Philadelphia\n\nBaselines: Historical ratings... ' + 'A'.repeat(5500);
            const alternateMarkets = '\n\n### Alternate Markets\n' + 'B'.repeat(1000);
            const oldNews = '\n\nOld News:\n' + 'C'.repeat(1000);
            const tail = '\n\nCritical Key Factors: Line movement...';
            const longPrompt = `${head}${alternateMarkets}${oldNews}${tail}`;

            expect(longPrompt.length).toBeGreaterThan(6000);
            const capped = capGroqPrompt(longPrompt);
            expect(capped.length).toBeLessThanOrEqual(6000);
            expect(capped).not.toContain('### Alternate Markets');
            expect(capped).not.toContain('Old News:');
            expect(capped).toContain('Task: Dallas @ Philadelphia');
        });

        it('strictly hard-caps prompt at 6,000 characters even if no alternate markets present', () => {
            const longPrompt = 'X'.repeat(7500);
            const capped = capGroqPrompt(longPrompt);
            expect(capped.length).toBe(6000);
        });
    });

    describe('computeGroqMaxTokens', () => {
        it('defaults to 1024 for analyst and critic calls', () => {
            const analystOptions = {
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Analyze odds',
                apiKey: 'test-key',
                role: 'Market Proposer'
            };
            expect(computeGroqMaxTokens(analystOptions, 500)).toBe(1024);

            const criticOptions = {
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Audit risk',
                apiKey: 'test-key',
                role: 'Risk Critic'
            };
            expect(computeGroqMaxTokens(criticOptions, 500)).toBe(1024);
        });

        it('defaults to 2048 for manager / compiler / judge calls', () => {
            const managerOptions = {
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Synthesize analysis',
                apiKey: 'test-key',
                role: 'GodView Compiler'
            };
            expect(computeGroqMaxTokens(managerOptions, 500)).toBe(2048);
        });

        it('clamps maxTokens so estimatedPromptTokens + maxTokens stays under 6000', () => {
            // When prompt is 4,500 tokens, manager 2048 would exceed 6000 (4500 + 2048 = 6548)
            const managerOptions = {
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Synthesize analysis',
                apiKey: 'test-key',
                role: 'GodView Compiler'
            };
            const clamped = computeGroqMaxTokens(managerOptions, 4500);
            expect(clamped).toBe(1500);
            expect(4500 + clamped).toBeLessThanOrEqual(6000);
        });

        it('clamps caller-provided high maxTokens (e.g. 8192 or 5000) under 6000 budget', () => {
            const options = {
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Analyze odds',
                apiKey: 'test-key',
                config: { maxTokens: 8192 },
                role: 'Market Proposer'
            };
            const clamped = computeGroqMaxTokens(options, 2000);
            expect(clamped).toBe(4000);
            expect(2000 + clamped).toBeLessThanOrEqual(6000);
            expect(clamped).not.toBe(8192);
        });
    });

    describe('GroqAdapter.call integration', () => {
        it('never sends max_tokens: 8192 in request body and sends 1024 for analysts', async () => {
            let capturedBody: any = null;
            globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
                capturedBody = JSON.parse(init.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"status":"ok"}' } }],
                        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
                    })
                };
            });

            const adapter = new GroqAdapter();
            await adapter.call({
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Analyze market steam',
                apiKey: 'gsk-test',
                role: 'Market Proposer'
            });

            expect(capturedBody).not.toBeNull();
            expect(capturedBody.max_tokens).toBe(1024);
            expect(capturedBody.max_tokens).not.toBe(8192);
        });

        it('sends 2048 for manager calls', async () => {
            let capturedBody: any = null;
            globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
                capturedBody = JSON.parse(init.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"status":"ok"}' } }],
                        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
                    })
                };
            });

            const adapter = new GroqAdapter();
            await adapter.call({
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Synthesize debate',
                apiKey: 'gsk-test',
                role: 'GodView Compiler'
            });

            expect(capturedBody).not.toBeNull();
            expect(capturedBody.max_tokens).toBe(2048);
        });

        it('caps prompt in messages array to 6,000 characters', async () => {
            let capturedBody: any = null;
            globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
                capturedBody = JSON.parse(init.body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"status":"ok"}' } }],
                        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
                    })
                };
            });

            const adapter = new GroqAdapter();
            const hugePrompt = 'Important Data: ' + 'Z'.repeat(10000);
            await adapter.call({
                modelName: 'openai/gpt-oss-120b',
                prompt: hugePrompt,
                apiKey: 'gsk-test',
                role: 'Market Proposer'
            });

            expect(capturedBody).not.toBeNull();
            const userMsg = capturedBody.messages.find((m: any) => m.role === 'user');
            expect(userMsg.content.length).toBeLessThanOrEqual(6000);
        });

        it('retries without response_format if model returns 400 json_validate_failed', async () => {
            const callBodies: any[] = [];
            globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
                const body = JSON.parse(init.body);
                callBodies.push(body);
                if (callBodies.length === 1) {
                    return {
                        ok: false,
                        status: 400,
                        clone: () => ({
                            text: async () => JSON.stringify({ error: { message: 'json_validate_failed', type: 'invalid_request_error' } })
                        }),
                        text: async () => JSON.stringify({ error: { message: 'json_validate_failed', type: 'invalid_request_error' } })
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        choices: [{ message: { content: '{"status":"recovered"}' } }],
                        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
                    })
                };
            });

            const adapter = new GroqAdapter();
            const result = await adapter.call({
                modelName: 'openai/gpt-oss-120b',
                prompt: 'Analyze odds',
                apiKey: 'gsk-test',
                config: { responseMimeType: 'application/json' }
            });

            expect(callBodies.length).toBe(2);
            expect(callBodies[0].response_format).toEqual({ type: 'json_object' });
            expect(callBodies[1].response_format).toBeUndefined();
            expect(result).toBe('{"status":"recovered"}');
        });
    });
});
