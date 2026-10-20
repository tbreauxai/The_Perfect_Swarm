import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAvailableModels, checkProviderModelsHealth } from './providerService.ts';

describe('providerService fetchAvailableModels', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('fetches models for nvidia and cloudflare from /api/swarm/models', async () => {
        const mockFetch = vi.fn(async (url: any) => {
            const urlStr = String(url);
            if (urlStr.includes('provider=nvidia')) {
                return new Response(JSON.stringify([
                    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nvidia Nemotron', free: true }
                ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (urlStr.includes('provider=cloudflare')) {
                return new Response(JSON.stringify([
                    { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Cloudflare Llama 8B', free: true }
                ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        vi.stubGlobal('fetch', mockFetch);

        const nvidiaModels = await fetchAvailableModels('nvidia');
        expect(nvidiaModels).toHaveLength(1);
        expect(nvidiaModels[0].id).toBe('nvidia/llama-3.3-nemotron-super-49b-v1.5');

        const cfModels = await fetchAvailableModels('cloudflare');
        expect(cfModels).toHaveLength(1);
        expect(cfModels[0].id).toBe('@cf/meta/llama-3.1-8b-instruct');
    });

    it('returns simulated model for simulated provider without network call', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const simulated = await fetchAvailableModels('simulated');
        expect(simulated).toHaveLength(1);
        expect(simulated[0].id).toBe('simulated-swarm-v1');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns empty array for unknown provider', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        const unknown = await fetchAvailableModels('nonexistent-provider');
        expect(unknown).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
