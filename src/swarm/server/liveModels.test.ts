import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    discoverLiveModels,
    clearLiveModelsCache,
    redactSecretValues
} from './liveModels.ts';
import { createSwarmServer } from './app.ts';

const SAMPLE_PRICING_MD = `
## Gemini 4 Hydrogen
\`gemini-4-hydrogen\`
| Tier | Input | Output |
| Free Tier | Free of charge | Free of charge |

## Gemini 4 Carbon
\`gemini-4-carbon\`
| Tier | Input | Output |
| Free Tier | Not available | Not available |

## Gemini 4 Argon
\`gemini-4-argon\`
| Tier | Input | Output |
| Free Tier | Not available | Not available |

| \`gemini-3.5-flash-lite\` | Free of charge | Free of charge |
`;

describe('Live Free-Tier Model Discovery (GET /api/swarm/models/live & /api/models/live)', () => {
    beforeEach(() => {
        clearLiveModelsCache();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('Gemini: intersects /v1beta/models with pricing.md.txt, includes gemini-4-hydrogen (freeTierVerified: true), excludes paid-only carbon/argon and embedding', async () => {
        const fetchFn = vi.fn(async (url: string) => {
            if (url.includes('pricing.md.txt')) {
                return new Response(SAMPLE_PRICING_MD, { status: 200 });
            }
            if (url.includes('generativelanguage.googleapis.com/v1beta/models')) {
                return new Response(
                    JSON.stringify({
                        models: [
                            {
                                name: 'models/gemini-4-hydrogen',
                                displayName: 'Gemini 4 Hydrogen',
                                supportedGenerationMethods: ['generateContent'],
                                inputTokenLimit: 1048576,
                                thinking: true
                            },
                            {
                                name: 'models/gemini-4-carbon',
                                displayName: 'Gemini 4 Carbon',
                                supportedGenerationMethods: ['generateContent'],
                                inputTokenLimit: 1048576
                            },
                            {
                                name: 'models/gemini-4-argon',
                                displayName: 'Gemini 4 Argon',
                                supportedGenerationMethods: ['generateContent'],
                                inputTokenLimit: 1048576
                            },
                            {
                                name: 'models/gemini-embedding-001',
                                displayName: 'Gemini Embedding 001',
                                supportedGenerationMethods: ['embedContent']
                            },
                            {
                                name: 'models/gemini-3.5-flash-lite',
                                displayName: 'Gemini 3.5 Flash-Lite',
                                supportedGenerationMethods: ['generateContent'],
                                inputTokenLimit: 1048576
                            }
                        ]
                    }),
                    { status: 200 }
                );
            }
            return new Response('Not found', { status: 404 });
        }) as unknown as typeof fetch;

        const res = await discoverLiveModels('gemini', { GEMINI_API_KEY: 'AIza-secret-gemini-key' }, { fetchFn });
        expect(res.provider).toBe('gemini');
        expect(res.keyConfigured).toBe(true);
        expect(res.source).toBe('live_api+official_pricing_md');

        const ids = res.models.map((m) => m.id);
        expect(ids).toContain('gemini-4-hydrogen');
        expect(ids).toContain('gemini-3.5-flash-lite');
        expect(ids).not.toContain('gemini-4-carbon');
        expect(ids).not.toContain('gemini-4-argon');
        expect(ids).not.toContain('gemini-embedding-001');

        const hydrogen = res.models.find((m) => m.id === 'gemini-4-hydrogen')!;
        expect(hydrogen).toMatchObject({
            id: 'gemini-4-hydrogen',
            label: 'Gemini 4 Hydrogen',
            freeTierVerified: true,
            supportsThinking: true,
            inputTokenLimit: 1048576
        });
    });

    it('NVIDIA: uses process.env.NVIDIA_API_KEY, filters out embed/rerank/OCR models, and falls back to models.dev when unset', async () => {
        const fetchLive = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('https://integrate.api.nvidia.com/v1/models');
            expect((init?.headers as any)?.Authorization).toBe('Bearer nvapi-secret-key');
            return new Response(
                JSON.stringify({
                    data: [
                        { id: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
                        { id: 'nvidia/nv-embedqa-e5-v5' },
                        { id: 'nvidia/nv-rerankqa-mistral-4b-v3' },
                        { id: 'nvidia/nemoretriever-ocr' }
                    ]
                }),
                { status: 200 }
            );
        }) as unknown as typeof fetch;

        const liveRes = await discoverLiveModels('nvidia', { NVIDIA_API_KEY: 'nvapi-secret-key' }, { fetchFn: fetchLive });
        expect(liveRes.keyConfigured).toBe(true);
        expect(liveRes.source).toBe('live_api');
        expect(liveRes.models.map((m) => m.id)).toEqual(['nvidia/nemotron-3.5-lightning-30b-a3b']);

        clearLiveModelsCache();
        const fetchFallback = vi.fn(async (url: string) => {
            expect(url).toBe('https://models.dev/api.json');
            return new Response(
                JSON.stringify({
                    nvidia: {
                        models: {
                            'nvidia/llama-3.3-nemotron-super-49b-v1': {
                                id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
                                name: 'Llama 3.3 Nemotron Super 49B',
                                reasoning: true,
                                limit: { context: 131072 },
                                modalities: { output: ['text'] }
                            },
                            'nvidia/nv-embed-v1': {
                                id: 'nvidia/nv-embed-v1',
                                name: 'NV Embed',
                                modalities: { output: ['embedding'] }
                            }
                        }
                    }
                }),
                { status: 200 }
            );
        }) as unknown as typeof fetch;

        const fallbackRes = await discoverLiveModels('nvidia', {}, { fetchFn: fetchFallback });
        expect(fallbackRes.keyConfigured).toBe(false);
        expect(fallbackRes.source).toBe('models_dev_fallback');
        expect(fallbackRes.models.map((m) => m.id)).toEqual(['nvidia/llama-3.3-nemotron-super-49b-v1']);
    });

    it('OpenRouter: returns strictly zero-cost (prompt === "0" && completion === "0") or :free models', async () => {
        const fetchFn = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    data: [
                        { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron Free', pricing: { prompt: '0', completion: '0' }, context_length: 131072 },
                        { id: 'google/gemini-zero', name: 'Zero Cost Model', pricing: { prompt: '0', completion: '0' } },
                        { id: 'anthropic/claude-paid', name: 'Paid Model', pricing: { prompt: '0.000003', completion: '0.000015' } }
                    ]
                }),
                { status: 200 }
            )
        ) as unknown as typeof fetch;

        const res = await discoverLiveModels('openrouter', { OPENROUTER_API_KEY: 'sk-or-secret' }, { fetchFn });
        expect(res.models.map((m) => m.id)).toEqual(['nvidia/nemotron-3.5-lightning:free', 'google/gemini-zero']);
    });

    it('Caching & Auth Routes: second call within 6h uses memory cache (0 upstream fetches), ?refresh=true bypasses cache, and keys never leak', async () => {
        vi.stubEnv('SWARM_APP_TOKENS', 'duelodds:test-token');
        vi.stubEnv('GROQ_API_KEY', 'gsk_super_secret_do_not_leak');
        let groqModelsCalls = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url) === 'https://api.groq.com/openai/v1/models') {
                    groqModelsCalls++;
                    return new Response(
                        JSON.stringify({
                            data: [
                                { id: 'openai/gpt-oss-120b' },
                                { id: 'whisper-large-v3' }
                            ]
                        }),
                        { status: 200 }
                    );
                }
                return new Response('[]', { status: 200 });
            })
        );

        const app = createSwarmServer({ cors: false });
        // Let background startup catalog/model-warning checks settle before counting route calls
        await new Promise((r) => setTimeout(r, 15));
        const authHeaders = { Authorization: 'Bearer test-token' };

        // Unauthenticated request is rejected by the same auth middleware as /api/swarm/stream
        const rUnauth = await app.request('/api/swarm/models/live?provider=groq');
        expect(rUnauth.status).toBe(401);

        // First call -> fetches /v1/models
        const beforeR1 = groqModelsCalls;
        const r1 = await app.request('/api/swarm/models/live?provider=groq', { headers: authHeaders });
        expect(r1.status).toBe(200);
        const body1 = await r1.json();
        expect(body1.models.map((m: any) => m.id)).toEqual(['openai/gpt-oss-120b']);
        const afterR1 = groqModelsCalls;
        expect(afterR1).toBe(beforeR1 + 1);

        // Second call via /api/models/live alias -> 0 new upstream fetches (served from 6h cache)
        const r2 = await app.request('/api/models/live?provider=groq', { headers: authHeaders });
        expect(r2.status).toBe(200);
        const body2 = await r2.json();
        expect(body2.models.map((m: any) => m.id)).toEqual(['openai/gpt-oss-120b']);
        expect(groqModelsCalls).toBe(afterR1);

        // ?refresh=true -> forces fresh fetch
        const r3 = await app.request('/api/swarm/models/live?provider=groq&refresh=true', { headers: authHeaders });
        expect(r3.status).toBe(200);
        expect(groqModelsCalls).toBe(afterR1 + 1);

        // Secret redaction check
        const redacted = redactSecretValues(
            'Error calling ?key=AIza-secret-123 with Bearer nvapi-abc-999 and gsk_super_secret_do_not_leak',
            { GROQ_API_KEY: 'gsk_super_secret_do_not_leak' }
        );
        expect(redacted).not.toContain('AIza-secret-123');
        expect(redacted).not.toContain('nvapi-abc-999');
        expect(redacted).not.toContain('gsk_super_secret_do_not_leak');
    });
});
