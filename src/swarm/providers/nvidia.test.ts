import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NvidiaAdapter } from './nvidia.ts';
import { ProviderRegistry } from './registry.ts';

describe('NvidiaAdapter', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('is registered in ProviderRegistry', () => {
        const adapter = ProviderRegistry.get('nvidia');
        expect(adapter).toBeInstanceOf(NvidiaAdapter);
        expect(adapter.providerName).toBe('nvidia');
    });

    it('sends response_format: { type: "json_object" } when responseMimeType is application/json', async () => {
        const adapter = new NvidiaAdapter();
        let capturedBody: any = null;

        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
            capturedBody = JSON.parse(opts.body);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    choices: [{ message: { content: '{"status":"ok"}' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Output json',
            config: { responseMimeType: 'application/json' }
        });

        expect(capturedBody).not.toBeNull();
        expect(capturedBody.response_format).toEqual({ type: 'json_object' });
        expect(capturedBody.model).toBe('nvidia/llama-3.3-nemotron-super-49b-v1.5');
        expect(result).toBe('{"status":"ok"}');
    });

    it('omits response_format when responseMimeType is not application/json', async () => {
        const adapter = new NvidiaAdapter();
        let capturedBody: any = null;

        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
            capturedBody = JSON.parse(opts.body);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    choices: [{ message: { content: 'Prose response' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Say hello'
        });

        expect(capturedBody).not.toBeNull();
        expect(capturedBody.response_format).toBeUndefined();
        expect(result).toBe('Prose response');
    });

    it('throws error when API key is missing', async () => {
        const adapter = new NvidiaAdapter();
        await expect(adapter.call({
            apiKey: '',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Test'
        })).rejects.toThrow('Missing NVIDIA API Key.');
    });

    it('handles 429 rate limit error', async () => {
        const adapter = new NvidiaAdapter();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => 'Rate limit exceeded'
        } as any);

        await expect(adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Test'
        })).rejects.toThrow(/\[RATE_LIMIT_429\] NVIDIA rate limit: Rate limit exceeded/);
    });

    it('handles 500 server error', async () => {
        const adapter = new NvidiaAdapter();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => 'Internal server error'
        } as any);

        await expect(adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Test'
        })).rejects.toThrow(/\[SERVER_ERROR_500\] NVIDIA: Internal server error/);
    });

    it('retries without response_format if model returns 400 format error', async () => {
        const adapter = new NvidiaAdapter();
        const callBodies: any[] = [];

        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
            const body = JSON.parse(opts.body);
            callBodies.push(body);
            if (callBodies.length === 1) {
                return {
                    ok: false,
                    status: 400,
                    clone: () => ({
                        text: async () => 'Unsupported parameter: response_format'
                    }),
                    text: async () => 'Unsupported parameter: response_format'
                } as any;
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    choices: [{ message: { content: '{"status":"ok_retry"}' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Output json',
            config: { responseMimeType: 'application/json' }
        });

        expect(callBodies.length).toBe(2);
        expect(callBodies[0].response_format).toEqual({ type: 'json_object' });
        expect(callBodies[1].response_format).toBeUndefined();
        expect(result).toBe('{"status":"ok_retry"}');
    });

    it('retries once on timeout and succeeds if second attempt finishes', async () => {
        const adapter = new NvidiaAdapter();
        let attempts = 0;

        globalThis.fetch = vi.fn().mockImplementation(async () => {
            attempts++;
            if (attempts === 1) {
                const err = new Error('Request timed out');
                err.name = 'TimeoutError';
                throw err;
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    choices: [{ message: { content: 'Recovered after timeout' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Test'
        });

        expect(attempts).toBe(2);
        expect(result).toBe('Recovered after timeout');
    });

    it('throws [TIMEOUT] if both timeout attempts fail', async () => {
        const adapter = new NvidiaAdapter();
        let attempts = 0;

        globalThis.fetch = vi.fn().mockImplementation(async () => {
            attempts++;
            const err = new Error('Request timed out');
            err.name = 'TimeoutError';
            throw err;
        });

        await expect(adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            prompt: 'Test'
        })).rejects.toThrow(/\[TIMEOUT\] NVIDIA request timed out/);

        expect(attempts).toBe(2);
    });

    it('omits response_format for known reasoning models even when responseMimeType is json', async () => {
        const adapter = new NvidiaAdapter();
        let capturedBody: any = null;

        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
            capturedBody = JSON.parse(opts.body);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    choices: [{ message: { content: '{"reasoning_output":"valid"}' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'nvapi-test-key',
            modelName: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
            prompt: 'Output json',
            config: { responseMimeType: 'application/json' }
        });

        expect(capturedBody).not.toBeNull();
        expect(capturedBody.response_format).toBeUndefined();
        expect(result).toBe('{"reasoning_output":"valid"}');
    });
});
