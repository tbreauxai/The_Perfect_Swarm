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
});
