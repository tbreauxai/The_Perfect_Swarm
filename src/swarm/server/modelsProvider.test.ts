import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    fetchProviderModels,
    rankModelsForAccount,
    isModelDead,
    DEFAULT_PROVIDER_MODELS,
    clearCatalogCache
} from './modelsProvider.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('modelsProvider rankModelsForAccount & probing', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        clearCatalogCache();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        clearCatalogCache();
    });

    it('prioritizes DEFAULT_PROVIDER_MODELS and OpenRouter free models in probe batch', async () => {
        const mockCall = vi.fn(async () => 'ok');
        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'openrouter',
            call: mockCall
        } as any);

        const models = [
            { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Paid Flagship', context_length: 128000 },
            { id: 'anthropic/claude-3.5-sonnet', name: 'Paid Sonnet', context_length: 200000 },
            { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Default Nemotron Free', context_length: 128000 },
            { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 70B Free', context_length: 128000 },
            { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B Free', context_length: 32000 }
        ];

        const result = await rankModelsForAccount('openrouter', models, 'test-key');

        expect(result.length).toBeGreaterThan(0);
        const probedModelNames = mockCall.mock.calls.map((c: any) => c[0].modelName);
        expect(probedModelNames).toContain(DEFAULT_PROVIDER_MODELS.openrouter);
        expect(probedModelNames).toContain('meta-llama/llama-3.3-70b-instruct:free');
    });

    it('does not return an empty catalog when all probed models are rate-limited', async () => {
        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'groq',
            call: vi.fn(async () => {
                throw new Error('429 rate limit exceeded');
            })
        } as any);

        const models = [
            { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
            { id: 'llama-3.3-70b-versatile', name: 'Llama 70B' }
        ];

        const result = await rankModelsForAccount('groq', models, 'test-key');

        expect(result.length).toBeGreaterThan(0);
        expect(result[0].id).toBe('openai/gpt-oss-120b');
        expect(result[0].available).toBe(true);
    });

    it('records 404 as dead models but does not mark timeouts as dead', async () => {
        const mockCall = vi.fn(async (options: any) => {
            if (options.modelName === 'dead-model-404') {
                throw new Error('404 model_not_found');
            }
            if (options.modelName === 'transient-timeout') {
                throw new Error('AbortError: The operation was aborted due to timeout');
            }
            return 'ok';
        });

        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'mistral',
            call: mockCall
        } as any);

        const models = [
            { id: 'dead-model-404', name: 'Dead Model' },
            { id: 'transient-timeout', name: 'Timeout Model' },
            { id: 'mistral-small-latest', name: 'Working Default' }
        ];

        await rankModelsForAccount('mistral', models, 'test-key');

        expect(isModelDead('mistral', 'dead-model-404')).toBe(true);
        expect(isModelDead('mistral', 'transient-timeout')).toBe(false);
    });

    it('returns available: false without probing when no apiKey is provided', async () => {
        const mockCall = vi.fn();
        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'gemini',
            call: mockCall
        } as any);

        const models = [
            { id: 'gemini-2.5-flash', name: 'Gemini Flash' }
        ];

        const result = await rankModelsForAccount('gemini', models, undefined);

        expect(mockCall).not.toHaveBeenCalled();
        expect(result.length).toBe(1);
        expect(result[0].available).toBe(false);
    });

    it('caches catalog results and coalesces concurrent probes', async () => {
        let probeCount = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: any) => {
            if (String(url).includes('models')) {
                probeCount++;
                return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }] }), { status: 200 });
            }
            return new Response('{}', { status: 200 });
        }));

        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'groq',
            call: vi.fn(async () => 'ok')
        } as any);

        // Run two concurrent fetchProviderModels calls
        const [res1, res2] = await Promise.all([
            fetchProviderModels('groq', 'key-123', {}),
            fetchProviderModels('groq', 'key-123', {})
        ]);

        expect(res1).toEqual(res2);
        expect(probeCount).toBe(1);

        // Subsequent call hits cache
        const res3 = await fetchProviderModels('groq', 'key-123', {});
        expect(res3).toEqual(res1);
        expect(probeCount).toBe(1);
    });

    it('returns fallback within boundedWaitMs if upstream hangs', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            // Simulate hanging network call
            await new Promise((r) => setTimeout(r, 5000));
            return new Response('{}', { status: 200 });
        }));

        const result = await fetchProviderModels('nvidia', 'key-123', {}, { boundedWaitMs: 50 });
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].id).toBe(DEFAULT_PROVIDER_MODELS.nvidia);
    });
});
