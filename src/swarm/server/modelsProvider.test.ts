import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    fetchProviderModels,
    rankModelsForAccount,
    isModelDead,
    DEFAULT_PROVIDER_MODELS,
    clearCatalogCache,
    applyDailyProbe,
    probeAllProviders
} from './modelsProvider.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';

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

    it('serves fixed catalog for capped providers without probing', async () => {
        const mockCall = vi.fn(async () => 'ok');
        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'openrouter',
            call: mockCall
        } as any);

        const models = [
            { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Paid Flagship', context_length: 128000 }
        ];

        const result = await rankModelsForAccount('openrouter', models, 'test-key');

        expect(result.length).toBe(3);
        expect(result.map(m => m.id)).toEqual([
            'openrouter/free',
            'google/gemma-4-31b-it:free',
            'nvidia/nemotron-3.5-lightning:free'
        ]);
        expect(mockCall).not.toHaveBeenCalled();
    });

    it('prioritizes DEFAULT_PROVIDER_MODELS in probe batch for dynamic providers', async () => {
        const mockCall = vi.fn(async () => 'ok');
        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'groq',
            call: mockCall
        } as any);

        const models = [
            { id: 'llama-3.1-8b-instant', name: 'Fast 8B' },
            { id: 'openai/gpt-oss-120b', name: 'Default 120B' },
            { id: 'llama-3.3-70b-versatile', name: 'Llama 70B' }
        ];

        const result = await rankModelsForAccount('groq', models, 'test-key');

        expect(result.length).toBeGreaterThan(0);
        const probedModelNames = mockCall.mock.calls.map((c: any) => c[0].modelName);
        expect(probedModelNames).toContain(DEFAULT_PROVIDER_MODELS.groq);
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

    it('keeps rate-limited models alongside live results and marks them degraded', async () => {
        const mockCall = vi.fn(async (options: any) => {
            if (options.modelName === 'limited-model') throw new Error('429 rate limit');
            return 'ok';
        });
        vi.spyOn(ProviderRegistry, 'get').mockReturnValue({
            providerName: 'groq',
            call: mockCall
        } as any);

        const result = await rankModelsForAccount('groq', [
            { id: 'live-model', name: 'Live' },
            { id: 'limited-model', name: 'Limited' }
        ], 'test-key');

        expect(result).toHaveLength(2);
        expect(result.find((model) => model.id === 'limited-model')).toMatchObject({
            available: true,
            degraded: true
        });
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
            providerName: 'groq',
            call: mockCall
        } as any);

        const models = [
            { id: 'dead-model-404', name: 'Dead Model' },
            { id: 'transient-timeout', name: 'Timeout Model' },
            { id: 'openai/gpt-oss-120b', name: 'Working Default' }
        ];

        await rankModelsForAccount('groq', models, 'test-key');

        expect(isModelDead('groq', 'dead-model-404')).toBe(true);
        expect(isModelDead('groq', 'transient-timeout')).toBe(false);
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
            fetchProviderModels('groq', 'key-123', {}, { forceRefresh: true }),
            fetchProviderModels('groq', 'key-123', {}, { forceRefresh: true })
        ]);

        expect(res1).toEqual(res2);
        expect(probeCount).toBe(1);

        // Subsequent call hits cache
        const res3 = await fetchProviderModels('groq', 'key-123', {});
        expect(res3).toEqual(res1);
        expect(probeCount).toBe(1);
    });

    it('does not probe on normal catalog reads and serves the provider default', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const result = await fetchProviderModels('nvidia', 'key-123', {});
        const deadModelIds = new Set([
            'gemini-3.5-flash',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'nvidia/llama-3.3-nemotron-super-49b-v1.5'
        ]);

        expect(fetch).not.toHaveBeenCalled();
        expect(result.map((model) => model.id)).toEqual([DEFAULT_PROVIDER_MODELS.nvidia]);
        expect(result[0].available).toBe(true);
        expect(Object.values(DEFAULT_PROVIDER_MODELS).filter((model) => deadModelIds.has(model))).toEqual([]);
    });

    it('serves stored last-good models on a cold read without provider calls', async () => {
        const stored = {
            lastProbeAt: 123,
            providers: { groq: { models: [{ id: 'stored-groq', available: true }], strikes: {} } }
        };
        const learningStore = { loadCatalogState: vi.fn(async () => stored) };
        const provider = vi.spyOn(ProviderRegistry, 'get');

        const result = await fetchProviderModels('groq', undefined, {}, {
            learningStore: learningStore as unknown as QdrantLearningStore
        });

        expect(result.map((model) => model.id)).toEqual(['stored-groq']);
        expect(learningStore.loadCatalogState).toHaveBeenCalledOnce();
        expect(provider).not.toHaveBeenCalled();
    });

    it('does not resurrect a default after it has three persisted dead strikes', async () => {
        const learningStore = {
            loadCatalogState: vi.fn(async () => ({
                providers: {
                    groq: { models: [], strikes: { [DEFAULT_PROVIDER_MODELS.groq]: 3 } }
                }
            }))
        };
        const result = await fetchProviderModels('groq', undefined, {}, {
            learningStore: learningStore as unknown as QdrantLearningStore
        });

        expect(result).toEqual([]);
    });

    it('drops dead models after three daily strikes, resets on ok, and keeps limited models', () => {
        let state: any = { models: [{ id: 'dead', available: true }], strikes: {} };
        state = applyDailyProbe(state, [{ id: 'dead', availability: 'dead' }], 'groq');
        expect(state.models).toHaveLength(1);
        state = applyDailyProbe(state, [{ id: 'dead', availability: 'dead' }], 'groq');
        expect(state.models).toHaveLength(1);
        state = applyDailyProbe(state, [{ id: 'dead', availability: 'dead' }], 'groq');
        expect(state.models).toHaveLength(0);
        expect(state.strikes.dead).toBe(3);

        state = applyDailyProbe(state, [{ id: 'recovered', availability: 'dead' }], 'groq');
        state = applyDailyProbe(state, [{ id: 'recovered', availability: 'dead' }], 'groq');
        state = applyDailyProbe(state, [{ id: 'recovered', availability: 'ok' }], 'groq');
        expect(state.strikes.recovered).toBe(0);
        expect(state.models.find((model: any) => model.id === 'recovered').available).toBe(true);

        for (let i = 0; i < 5; i++) {
            state = applyDailyProbe(state, [{ id: 'limited', availability: 'limited' }], 'groq');
        }
        expect(state.models.find((model: any) => model.id === 'limited')).toMatchObject({
            available: true,
            degraded: true
        });
        expect(state.strikes.limited).toBe(0);
    });

    it('preserves unprobed model state and never strikes fixed catalog entries', () => {
        const previous = {
            models: [{ id: 'kept', available: true }],
            strikes: { fixed: 2 }
        };
        expect(applyDailyProbe(previous, [], 'groq').models).toEqual(previous.models);
        const fixed = applyDailyProbe(previous, [
            { id: 'nvidia/nemotron-3.5-lightning:free', availability: 'dead' }
        ], 'openrouter');
        expect(fixed.models.some((model) => model.id === 'kept')).toBe(false);
        expect(fixed.strikes.fixed).toBe(2);
        expect(fixed.strikes['nvidia/nemotron-3.5-lightning:free']).toBeUndefined();
    });

    it('persists catalog state once after a scheduled provider probe pass', async () => {
        const state = {
            loadCatalogState: vi.fn(async () => null),
            saveCatalogState: vi.fn(async (_state: Record<string, any>) => {}),
        };
        vi.stubGlobal('fetch', vi.fn(async () =>
            new Response(JSON.stringify({ data: [] }), { status: 200 })
        ));

        await probeAllProviders({}, state as unknown as QdrantLearningStore);

        expect(state.saveCatalogState).toHaveBeenCalledOnce();
        expect(state.saveCatalogState.mock.calls[0][0].lastProbeAt).toEqual(expect.any(Number));
        expect(state.saveCatalogState.mock.calls[0][0].providers.openrouter.models)
            .toContainEqual(expect.objectContaining({ id: DEFAULT_PROVIDER_MODELS.openrouter }));
    });
});
