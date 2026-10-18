import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareAdapter, resolveCloudflareCredentials } from './cloudflare.ts';
import { ProviderRegistry } from './registry.ts';

describe('CloudflareAdapter', () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.restoreAllMocks();
        process.env = { ...originalEnv };
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
        delete process.env.CF_ACCOUNT_ID;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        process.env = originalEnv;
    });

    it('is registered in ProviderRegistry', () => {
        const adapter = ProviderRegistry.get('cloudflare');
        expect(adapter).toBeInstanceOf(CloudflareAdapter);
        expect(adapter.providerName).toBe('cloudflare');
    });

    it('resolves account ID and token from compound account:token key', () => {
        const creds = resolveCloudflareCredentials('my-cf-account:my-cf-token');
        expect(creds.account).toBe('my-cf-account');
        expect(creds.token).toBe('my-cf-token');
    });

    it('resolves account ID from process.env.CLOUDFLARE_ACCOUNT_ID', () => {
        process.env.CLOUDFLARE_ACCOUNT_ID = 'env-account-id';
        const creds = resolveCloudflareCredentials('my-token');
        expect(creds.account).toBe('env-account-id');
        expect(creds.token).toBe('my-token');
    });

    it('resolves account ID from process.env.CF_ACCOUNT_ID fallback', () => {
        process.env.CF_ACCOUNT_ID = 'cf-env-account-id';
        const creds = resolveCloudflareCredentials('my-token');
        expect(creds.account).toBe('cf-env-account-id');
        expect(creds.token).toBe('my-token');
    });

    it('throws error when token is missing', async () => {
        process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
        const adapter = new CloudflareAdapter();
        await expect(adapter.call({
            apiKey: '',
            modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Test'
        })).rejects.toThrow('Missing Cloudflare Workers AI token.');
    });

    it('throws error when account ID is missing', async () => {
        const adapter = new CloudflareAdapter();
        await expect(adapter.call({
            apiKey: 'token-without-account',
            modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Test'
        })).rejects.toThrow('Missing CLOUDFLARE_ACCOUNT_ID.');
    });

    it('sends response_format: { type: "json_object" } when responseMimeType is application/json', async () => {
        const adapter = new CloudflareAdapter();
        let capturedUrl = '';
        let capturedBody: any = null;

        globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
            capturedUrl = url;
            capturedBody = JSON.parse(opts.body);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    choices: [{ message: { content: '{"cf_status":"ok"}' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'my-acc-id:my-token',
            modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Output json',
            config: { responseMimeType: 'application/json' }
        });

        expect(capturedUrl).toContain('/accounts/my-acc-id/ai/v1/chat/completions');
        expect(capturedBody).not.toBeNull();
        expect(capturedBody.response_format).toEqual({ type: 'json_object' });
        expect(result).toBe('{"cf_status":"ok"}');
    });

    it('omits response_format when responseMimeType is not application/json', async () => {
        const adapter = new CloudflareAdapter();
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
            apiKey: 'my-acc-id:my-token',
            modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Say hello'
        });

        expect(capturedBody.response_format).toBeUndefined();
        expect(result).toBe('Prose response');
    });

    it('retries without response_format if model returns 400 rejecting format', async () => {
        const adapter = new CloudflareAdapter();
        const callBodies: any[] = [];

        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
            const body = JSON.parse(opts.body);
            callBodies.push(body);
            if (callBodies.length === 1) {
                return {
                    ok: false,
                    status: 400,
                    headers: new Headers(),
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
                    choices: [{ message: { content: '{"fallback":"repaired"}' } }]
                })
            } as any;
        });

        const result = await adapter.call({
            apiKey: 'my-acc-id:my-token',
            modelName: '@cf/meta/llama-3.1-8b-instruct',
            prompt: 'Output json',
            config: { responseMimeType: 'application/json' }
        });

        expect(callBodies.length).toBe(2);
        expect(callBodies[0].response_format).toEqual({ type: 'json_object' });
        expect(callBodies[1].response_format).toBeUndefined();
        expect(result).toBe('{"fallback":"repaired"}');
    });

    it('handles 429 rate limit error', async () => {
        const adapter = new CloudflareAdapter();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => 'Workers AI rate limit reached'
        } as any);

        await expect(adapter.call({
            apiKey: 'my-acc-id:my-token',
            modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Test'
        })).rejects.toThrow(/\[RATE_LIMIT_429\] Cloudflare Workers AI rate limit: Workers AI rate limit reached/);
    });

    it('handles 500 server error', async () => {
        const adapter = new CloudflareAdapter();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            headers: new Headers(),
            text: async () => 'Workers AI service failure'
        } as any);

        await expect(adapter.call({
            apiKey: 'my-acc-id:my-token',
            modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            prompt: 'Test'
        })).rejects.toThrow(/\[SERVER_ERROR_500\] Cloudflare Workers AI: Workers AI service failure/);
    });
});
