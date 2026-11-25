import { ProviderRegistry } from '../providers/registry.ts';
import { globalProviderLimiter } from '../providers/limiter.ts';
import { getDefaultLearningStore, QdrantLearningStore } from '../learning-persistence.ts';

export const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
    gemini: 'gemini-3.5-flash-lite',
    groq: 'openai/gpt-oss-120b',
    openrouter: 'nvidia/nemotron-3.5-lightning:free',
    mistral: 'mistral-small-latest',
    cloudflare: '@cf/meta/llama-3.1-8b-instruct',
    nvidia: 'nvidia/nemotron-3.5-lightning-30b-a3b'
};

/** Active Nov 2026 free-tier Gemini text/JSON models in priority order. */
export const GEMINI_FREE_TIER_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it'
] as const;

export const GEMINI_FREE_TIER_CATALOG: ReadonlyArray<{ id: string; name: string; free: boolean }> = [
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', free: true },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', free: true },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', free: true },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', free: true },
    { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', free: true },
    { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', free: true }
];

const GEMINI_FREE_TIER_PRIORITY = new Map<string, number>(
    GEMINI_FREE_TIER_MODELS.map((id, idx) => [id, idx])
);

const GEMINI_METADATA_TTL_MS = 20 * 60 * 1000; // 20 minutes (zero-quota GET /v1beta/models cache)
const geminiMetadataCache = new Map<string, { models: any[]; at: number }>();

/**
 * Transparently remaps retired Gemini 2.0/2.5 (and non-existent 3.5-flash) overrides
 * to the recommended free-tier primary `gemini-3.5-flash-lite`.
 */
export function remapDeprecatedGeminiModel(modelId?: string): string {
    const trimmed = String(modelId || '').replace(/^models\//i, '').trim();
    if (!trimmed) return DEFAULT_PROVIDER_MODELS.gemini;
    if (/^gemini-2\.[05](?:[-.]|$)/i.test(trimmed) || /^gemini-3\.5-flash$/i.test(trimmed)) {
        return 'gemini-3.5-flash-lite';
    }
    return trimmed;
}

/**
 * Strictly filters dynamic Gemini model discovery to active free-tier text/JSON models.
 * Excludes non-text modalities (-image, -tts, -live, veo, imagen, omni, transcribe, embedding),
 * retired gemini-2.0-* / gemini-2.5-* models, and paid-only Gemini 4 / Pro IDs.
 */
export function isAllowedFreeTierGeminiModel(id: string): boolean {
    const norm = String(id || '').replace(/^models\//i, '').trim().toLowerCase();
    if (!norm) return false;
    if (/(?:-image\b|image-generation|-tts\b|-live\b|\bveo\b|\bimagen\b|\bomni\b|transcribe|embedding|embed|aqa|bison|gecko|whisper|audio|robotics|computer-use|deep-research|antigravity|nano-banana|clip-preview|customtools|moderation|safeguard|realtime|speech)/i.test(norm)) {
        return false;
    }
    if (/^gemini-(?:1\.|2\.0|2\.5)/i.test(norm)) return false;
    if (/^gemini-4(?:-|$|\.)/i.test(norm)) return false;
    if (/gemini-3\.1-pro|-pro(?:-|$)|\bultra\b/i.test(norm)) return false;
    if (GEMINI_FREE_TIER_PRIORITY.has(norm)) return true;
    return /^(?:gemini-3\.[1-9]-flash(?:-lite)?|gemma-4-\d+b(?:-a\d+b)?-it)$/i.test(norm);
}

const catalogCache = new Map<string, { models: any[]; at: number }>();
const inFlightProbes = new Map<string, Promise<any[]>>();
export interface ProviderCatalogState {
    models: any[];
    strikes: Record<string, number>;
}

export interface ModelCatalogState {
    lastProbeAt?: number;
    providers: Record<string, ProviderCatalogState>;
}

const emptyCatalogState = (): ModelCatalogState => ({ providers: {} });
let catalogState = emptyCatalogState();
let catalogStateLoaded = false;
let catalogStateLoadPromise: Promise<ModelCatalogState> | null = null;
let probeAllPromise: Promise<void> | null = null;
let catchUpPromise: Promise<void> | null = null;

export function clearCatalogCache(): void {
    catalogCache.clear();
    geminiMetadataCache.clear();
    availabilityCache.clear();
    deadModels.clear();
    inFlightProbes.clear();
    catalogState = emptyCatalogState();
    catalogStateLoaded = false;
    catalogStateLoadPromise = null;
    probeAllPromise = null;
    catchUpPromise = null;
}

async function loadCatalogState(store: QdrantLearningStore = getDefaultLearningStore()): Promise<ModelCatalogState> {
    if (catalogStateLoaded) return catalogState;
    if (!catalogStateLoadPromise) {
        catalogStateLoadPromise = (async () => {
            const stored = await store.loadCatalogState();
            if (stored && stored.providers && typeof stored.providers === 'object' && !Array.isArray(stored.providers)) {
                catalogState = {
                    ...(typeof stored.lastProbeAt === 'number' ? { lastProbeAt: stored.lastProbeAt } : {}),
                    providers: stored.providers
                } as ModelCatalogState;
            }
            catalogStateLoaded = true;
            return catalogState;
        })().catch((err) => {
            console.warn('[catalog] persisted state load failed:', err?.message || err);
            catalogStateLoaded = true;
            return catalogState;
        }).finally(() => {
            catalogStateLoadPromise = null;
        });
    }
    return catalogStateLoadPromise;
}

function fallbackCatalog(provider: string): any[] {
    const prov = provider.toLowerCase();
    if (prov === 'simulated') {
        return [{ id: 'simulated-swarm-v1', name: 'Simulated Swarm Model', free: true }];
    }
    if (prov === 'gemini') {
        return GEMINI_FREE_TIER_CATALOG.map((model) => ({
            ...model,
            capability: capabilityScore(model.id),
            available: true
        }));
    }
    const fixed = FIXED_CATALOGS[prov];
    if (fixed) {
        return fixed.map((model) => ({
            ...model,
            capability: capabilityScore(model.id),
            available: true
        }));
    }
    const model = DEFAULT_PROVIDER_MODELS[prov];
    return model ? [{ id: model, name: model, available: true }] : [];
}

function catalogWithFallback(provider: string): any[] {
    const stored = catalogState.providers[provider];
    return stored ? stored.models : fallbackCatalog(provider);
}

export function applyDailyProbe(
    previous: ProviderCatalogState | undefined,
    probed: any[],
    provider: string
): ProviderCatalogState {
    const models = new Map((previous?.models || []).filter((model) => model?.id).map((model) => [model.id, model]));
    const strikes = { ...(previous?.strikes || {}) };
    const fixedCatalog = Object.hasOwn(FIXED_CATALOGS, provider.toLowerCase());
    if (fixedCatalog) models.clear();

    for (const model of probed || []) {
        if (!model?.id) continue;
        const id = String(model.id);
        const old = models.get(id);
        if (fixedCatalog) {
            models.set(id, { ...model, available: true, degraded: false });
        } else if (model.availability === 'ok' || model.availability === 'limited') {
            strikes[id] = 0;
            const { degraded: _oldDegraded, ...existing } = old || {};
            models.set(id, {
                ...existing,
                ...model,
                available: true,
                ...(model.availability === 'limited' ? { degraded: true } : {})
            });
        } else if (model.availability === 'dead') {
            const strikeCount = (strikes[id] || 0) + 1;
            strikes[id] = strikeCount;
            if (strikeCount >= 3) {
                models.delete(id);
            } else {
                models.set(id, {
                    ...(old || {}),
                    ...model,
                    available: false,
                    degraded: true
                });
            }
        }
    }

    return { models: [...models.values()], strikes };
}

/**
 * Fetches available models from supported LLM providers with edge-safe fetch calls.
 * Normal reads are memory/persistence/default only. Provider listing and tiny
 * generation probes run only when forceRefresh is explicitly requested.
 */
export async function fetchProviderModels(
    provider: string,
    clientKey?: string,
    env: Record<string, any> = {},
    options?: {
        forceRefresh?: boolean;
        boundedWaitMs?: number;
        deferCatalogPersist?: boolean;
        learningStore?: QdrantLearningStore;
    }
): Promise<any[]> {
    const prov = provider.toLowerCase();
    const apiKey = clientKey || keyFor(prov, env);
    const cacheKey = `${prov}:${apiKey ? apiKey.slice(-6) : 'unkeyed'}`;
    const store = options?.learningStore || getDefaultLearningStore();

    if (!options?.forceRefresh) {
        const cached = catalogCache.get(cacheKey);
        if (cached) return cached.models;
        await loadCatalogState(store);
        const models = catalogWithFallback(prov);
        catalogCache.set(cacheKey, { models, at: Date.now() });
        return models;
    }

    if (inFlightProbes.has(cacheKey)) {
        return inFlightProbes.get(cacheKey)!;
    }

    const probePromise = (async () => {
        try {
            const listed = await listProviderModels(prov, clientKey, env);
            const ranked = await rankModelsForAccount(prov, listed, apiKey, true);
            await loadCatalogState(store);
            const next = applyDailyProbe(catalogState.providers[prov], ranked, prov);
            catalogState.providers[prov] = next;
            const result = next.models.length || Object.keys(next.strikes).length
                ? next.models
                : fallbackCatalog(prov);
            catalogCache.set(cacheKey, { models: result, at: Date.now() });
            if (!options?.deferCatalogPersist) {
                catalogState.lastProbeAt = Date.now();
                await store.saveCatalogState(catalogState);
            }
            return result;
        } finally {
            inFlightProbes.delete(cacheKey);
        }
    })();

    inFlightProbes.set(cacheKey, probePromise);

    if (options?.boundedWaitMs && options.boundedWaitMs > 0) {
        let timer: any;
        const timeoutPromise = new Promise<any[]>((resolve) => {
            timer = setTimeout(() => {
                const existing = catalogCache.get(cacheKey);
                resolve(existing?.models || catalogWithFallback(prov));
            }, options.boundedWaitMs);
        });
        return Promise.race([probePromise, timeoutPromise]).finally(() => clearTimeout(timer));
    }

    return probePromise;
}

const CATALOG_PROVIDERS = ['groq', 'gemini', 'openrouter', 'mistral', 'nvidia', 'cloudflare'];

/**
 * Probe every provider once. The morning and night schedule calls this.
 * A picker open reads the cache this fills and does not probe.
 */
async function runProbeAllProviders(
    env: Record<string, any> = {},
    store: QdrantLearningStore = getDefaultLearningStore()
): Promise<void> {
    await loadCatalogState(store);
    for (const provider of CATALOG_PROVIDERS) {
        try {
            await fetchProviderModels(provider, undefined, env, {
                forceRefresh: true,
                deferCatalogPersist: true,
                learningStore: store
            });
        } catch (err: any) {
            console.warn(`[catalog] scheduled probe failed for ${provider}:`, err?.message || err);
        }
    }
    catalogState.lastProbeAt = Date.now();
    await store.saveCatalogState(catalogState);
}

export function probeAllProviders(
    env: Record<string, any> = {},
    store: QdrantLearningStore = getDefaultLearningStore()
): Promise<void> {
    if (probeAllPromise) return probeAllPromise;
    probeAllPromise = runProbeAllProviders(env, store).finally(() => {
        probeAllPromise = null;
    });
    return probeAllPromise;
}

export function ensureCatalogProbeFresh(
    env: Record<string, any> = {},
    store: QdrantLearningStore = getDefaultLearningStore(),
    now: number = Date.now()
): Promise<void> {
    if (catchUpPromise) return catchUpPromise;
    catchUpPromise = (async () => {
        await loadCatalogState(store);
        const lastProbeAt = catalogState.lastProbeAt;
        if (typeof lastProbeAt === 'number' && now - lastProbeAt <= 24 * 60 * 60 * 1000) return;
        await probeAllProviders(env, store);
    })().finally(() => {
        catchUpPromise = null;
    });
    return catchUpPromise;
}

const NON_CHAT = /tts|whisper|image|embed|ocr|lyria|transcribe|prompt-guard|orpheus|robotics|moderation|computer-use|realtime|speech|safeguard|deep-research|antigravity|nano-banana|clip-preview|omni|customtools/i;

const availabilityCache = new Map<string, { state: 'ok' | 'limited' | 'dead'; at: number }>();
const deadModels = new Set<string>();
const CACHE_MS = 12 * 60 * 60 * 1000;

/** A model the probe proved dead (404 / not found). Seats read this and skip it. */
export function isModelDead(provider: string, modelId: string): boolean {
    return deadModels.has(`${provider.toLowerCase()}:${modelId}`);
}

export function isChatModel(id: string): boolean {
    return Boolean(id) && !NON_CHAT.test(id);
}

export function capabilityScore(id: string): number {
    const s = (id || '').toLowerCase();
    let score = 20;
    const size = s.match(/(\d+(?:\.\d+)?)b/);
    if (size) score += Math.min(70, Math.log2(Number(size[1]) + 1) * 9);
    if (/ultra|550b|large-4|3\.1-pro|-pro\b|pro-preview/.test(s)) score += 28;
    if (/super|120b|70b|medium|magistral/.test(s)) score += 16;
    if (/flash/.test(s)) score += 6;
    if (/lite|mini|nano|8b|3b|2b|small/.test(s)) score -= 14;
    if (/:free|openrouter\/free/.test(s)) score += 2;
    return Math.round(score);
}

// Providers with a tight daily cap are not probed. A probe spends the
// requests a seat needs. Review this fixed catalog periodically.
const FIXED_CATALOGS: Record<string, { id: string; name: string }[]> = {
    openrouter: [
        { id: 'openrouter/free', name: 'OpenRouter Free' },
        { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B' },
        { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning' }
    ],
    mistral: [
        { id: 'ministral-14b-latest', name: 'Ministral 14B' },
        { id: 'mistral-small-latest', name: 'Mistral Small' }
    ]
};
export async function rankModelsForAccount(
    provider: string,
    models: any[],
    apiKey?: string,
    includeUnhealthy = false
): Promise<any[]> {
    const prov = provider.toLowerCase();
    const fixed = FIXED_CATALOGS[prov];
    if (fixed) {
        return fixed.map(m => ({ ...m, capability: capabilityScore(m.id), available: true }));
    }
    const chat = (models || []).filter((m) => {
        if (!m || !isChatModel(m.id)) return false;
        if (prov === 'gemini') return isAllowedFreeTierGeminiModel(m.id);
        return true;
    });
    const defaultModelId = DEFAULT_PROVIDER_MODELS[prov];

    const ranked = chat.map((m) => {
        const isFree = Boolean(m.free || /:free|openrouter\/free/i.test(m.id) || prov === 'gemini');
        const isDefault = defaultModelId && (m.id === defaultModelId || m.id.endsWith(defaultModelId));
        let cap = capabilityScore(m.id);
        // Priority boost: default model and free models must rank highest
        if (prov === 'gemini') {
            const prio = GEMINI_FREE_TIER_PRIORITY.get(String(m.id).toLowerCase());
            if (prio !== undefined) cap = 2000 - prio * 100;
            else if (isDefault) cap += 1000;
            else if (/flash/i.test(m.id)) cap += 400;
        } else if (isDefault) cap += 1000;
        else if (isFree && prov === 'openrouter') cap += 500;
        return {
            ...m,
            free: isFree,
            capability: cap
        };
    });
    ranked.sort((a, b) => b.capability - a.capability);

    if (!apiKey) {
        return ranked.map((m) => {
            const displayCap = capabilityScore(m.id);
            return {
                ...m,
                capability: displayCap,
                name: displayCap ? `${m.name} · c${displayCap}` : m.name,
                available: false
            };
        });
    }

    // S3: Zero-quota Gemini health check.
    // Never loop generateContent probes across Gemini models (burns per-project RPM/RPD quota).
    // Instead, issue ONE cached GET /v1beta/models metadata check (0 generation quota).
    if (prov === 'gemini') {
        try {
            const liveMetadata = await fetchGeminiModelsZeroQuota(apiKey);
            const liveIds = new Set(liveMetadata.map((m: any) => String(m.id).toLowerCase()));
            const sourceList = ranked.length > 0 ? ranked : liveMetadata;
            const evaluated = sourceList.map((m) => {
                const idNorm = String(m.id).toLowerCase();
                const inMetadata = liveIds.size === 0 ? true : liveIds.has(idNorm);
                const cooldownReason = globalProviderLimiter.getSkipReason('gemini', m.id);
                const isDead = !inMetadata || isModelDead('gemini', m.id);
                const isCoolingDown = Boolean(cooldownReason && !isDead);
                const displayCap = capabilityScore(m.id);
                return {
                    ...m,
                    availability: isDead ? 'dead' : (isCoolingDown ? 'limited' : 'ok'),
                    capability: displayCap,
                    name: displayCap ? `${m.name} · c${displayCap}` : m.name,
                    available: !isDead,
                    ...(isCoolingDown ? { degraded: true } : {})
                };
            });
            return includeUnhealthy ? evaluated : evaluated.filter((m) => m.available);
        } catch (err: any) {
            const msg = String(err?.message || err || '');
            const isAuthError = /\b40[13]\b|API_KEY_INVALID|invalid api key|unauthorized|forbidden/i.test(msg);
            return ranked.map((m) => {
                const displayCap = capabilityScore(m.id);
                return {
                    ...m,
                    availability: isAuthError ? 'dead' : 'limited',
                    capability: displayCap,
                    name: displayCap ? `${m.name} · c${displayCap}` : m.name,
                    available: !isAuthError,
                    ...(isAuthError ? {} : { degraded: true })
                };
            });
        }
    }

    // A provider with hundreds of models never finishes a full probe.
    // Probe the top by capability so the catalog returns proved-live models.
    const PROBE_CAP = 20;
    const toProbe = ranked.slice(0, PROBE_CAP);

    // OpenRouter/Mistral free models rate limit fast.
    const paced = prov === 'mistral' || prov === 'openrouter';
    const cap = paced ? 8 : PROBE_CAP;
    const batch = toProbe.slice(0, cap);
    await mapLimit(batch, paced ? 1 : 6, async (m) => {
        m.availability = await probeAvailability(provider, m.id, apiKey);
    });

    // Rate-limited models are not retried here. The retry waited out the
    // provider window and the caller's 20s timeout fired first, so the
    // catalog never arrived. A rate limit is not cached, so the next
    // request probes those models fresh.
    let live = batch.filter((m) => m.availability === 'ok' || m.availability === 'limited');

    // 1. If none returned 'ok', check if previously cached live models exist for this provider
    if (live.length === 0) {
        for (const m of batch) {
            const cached = availabilityCache.get(`${prov}:${m.id}`);
            if (cached && cached.state === 'ok' && Date.now() - cached.at < CACHE_MS) {
                m.availability = 'ok';
                live.push(m);
            }
        }
    }

    // 2. If still empty, check if models in batch were 'limited' (rate limited, NOT dead)
    // Rate-limited models are valid working models that are temporarily throttled.
    if (live.length === 0) {
        const limited = batch.filter((m) => m.availability === 'limited');
        if (limited.length > 0) {
            live = limited;
        }
    }

    // 3. If still empty (e.g. cold start, all network failed), preserve default model or batch models
    // so the catalog is NEVER blank when known models exist.
    if (live.length === 0 && batch.length > 0) {
        const defaultMatch = batch.find((m) => m.id === defaultModelId) || batch[0];
        if (defaultMatch && !isModelDead(prov, defaultMatch.id)) {
            live = [defaultMatch];
        }
    }

    live.sort((a, b) => b.capability - a.capability);
    return (includeUnhealthy ? batch : live).map((m) => {
        const displayCap = capabilityScore(m.id);
        return {
            ...m,
            capability: displayCap,
            name: displayCap ? `${m.name} · c${displayCap}` : m.name,
            available: m.availability !== 'dead',
            ...(m.availability === 'limited' ? { degraded: true } : {})
        };
    });
}

function availabilityRank(state?: string): number {
    if (state === 'ok') return 0;
    if (state === 'limited') return 1;
    if (!state) return 2;
    return 3;
}

function keyFor(provider: string, env: Record<string, any>): string | undefined {
    switch (provider.toLowerCase()) {
        case 'gemini': return env.GEMINI_API_KEY;
        case 'groq': return env.GROQ_API_KEY;
        case 'mistral': return env.MISTRAL_API_KEY;
        case 'cloudflare': {
            const token = env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN;
            const account = env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
            if (token && account && !token.includes(':')) {
                return `${account}:${token}`;
            }
            return token;
        }
        case 'nvidia': return env.NVIDIA_API_KEY;
        case 'openrouter': return env.OPENROUTER_API_KEY;
        default: return undefined;
    }
}

async function probeAvailability(provider: string, modelId: string, apiKey: string): Promise<'ok' | 'limited' | 'dead'> {
    const cacheKey = `${provider.toLowerCase()}:${modelId}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
    const state = await pingModel(provider, modelId, apiKey);
    // A rate limit is transient. Cache only a real answer or a real failure,
    // so a parallel probe burst does not hide a working model for 12 hours.
    if (state !== 'limited') availabilityCache.set(cacheKey, { state, at: Date.now() });
    return state;
}

async function pingModel(provider: string, modelId: string, apiKey: string): Promise<'ok' | 'limited' | 'dead'> {
    const first = await probeOnce(provider, modelId, apiKey);
    if (first !== 'dead') return first;
    // A paced provider already spent its budget. Do not spend it again.
    const prov = provider.toLowerCase();
    if (prov === 'mistral' || prov === 'openrouter' || prov === 'gemini') return first;
    return probeOnce(provider, modelId, apiKey);
}

async function probeOnce(provider: string, modelId: string, apiKey: string): Promise<'ok' | 'limited' | 'dead'> {
    try {
        const adapter = ProviderRegistry.get(provider);
        // A probe never takes a seat's slot or budget. If a seat holds the
        // provider, the probe waits and tries once more, then reports limited.
        if (globalProviderLimiter.isBusy(provider)) {
            await new Promise(r => setTimeout(r, 1500));
            if (globalProviderLimiter.isBusy(provider)) return 'limited';
        }
        const text = await adapter.call({
            modelName: modelId,
            prompt: 'Reply with the single word ok.',
            apiKey,
            timeoutMs: 6000,
            role: 'catalog-probe',
            config: { maxTokens: 64, maxTokensCap: 64, groqMode: 'chat' }
        });
        if (typeof text === 'string' && text.trim().length > 0) return 'ok';
        return 'dead';
    } catch (err: any) {
        const msg = String(err?.message || err);
        // A 404 is a real deprecation. Record it so seats skip the model.
        // A rate limit is not. It never touches the seat circuit.
        if (/\b404\b|model_not_found|NOT_FOUND|deprecated/i.test(msg)) {
            deadModels.add(`${provider.toLowerCase()}:${modelId}`);
            return 'dead';
        }
        if (/429|rate limit|quota|503|502|504|timeout|timed out|abort|high demand|temporarily unavailable/i.test(msg)) {
            return 'limited';
        }
        return 'dead';
    }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = items[index++];
            await fn(current);
        }
    });
    await Promise.all(workers);
}

/**
 * Zero-quota Gemini health & discovery check.
 * Issues ONE `GET /v1beta/models` metadata call (0 generation quota), filtered strictly
 * to active free-tier text models, and caches the result in memory for 20 minutes.
 */
export async function fetchGeminiModelsZeroQuota(apiKey: string, forceRefresh = false): Promise<any[]> {
    const cacheKey = `gemini-meta:${apiKey.slice(-6)}`;
    const cached = geminiMetadataCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.at < GEMINI_METADATA_TTL_MS) {
        return cached.models;
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) {
        throw new Error(`Failed to fetch Gemini models (${res.status})`);
    }
    const data = await res.json();
    const filtered = (data.models || [])
        .filter((m: any) =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent')
        )
        .map((m: any) => ({
            id: String(m.name || '').replace(/^models\//i, ''),
            name: m.displayName || m.name,
            free: true
        }))
        .filter((m: any) => isAllowedFreeTierGeminiModel(m.id));
    filtered.sort((a: any, b: any) => {
        const pa = GEMINI_FREE_TIER_PRIORITY.get(String(a.id).toLowerCase()) ?? 999;
        const pb = GEMINI_FREE_TIER_PRIORITY.get(String(b.id).toLowerCase()) ?? 999;
        return pa - pb;
    });
    geminiMetadataCache.set(cacheKey, { models: filtered, at: Date.now() });
    return filtered;
}

async function listProviderModels(provider: string, clientKey?: string, env: Record<string, any> = {}): Promise<any[]> {
    switch (provider.toLowerCase()) {
        case 'simulated':
            return [{ id: 'simulated-swarm-v1', name: 'Simulated Swarm Model', free: true }];
        case 'openrouter': {
            const res = await fetch('https://openrouter.ai/api/v1/models');
            if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
            const data = await res.json();
            return (data.data || []).map((m: any) => ({
                id: m.id,
                name: m.name || m.id,
                context_length: m.context_length,
                free: Boolean((m.pricing?.prompt === '0' && m.pricing?.completion === '0') || m.id?.endsWith(':free'))
            }));
        }
        case 'groq': {
            const apiKey = clientKey || env.GROQ_API_KEY;
            if (!apiKey) return [];
            const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
            if (!res.ok) throw new Error('Failed to fetch Groq models');
            const data = await res.json();
            return (data.data || []).map((m: any) => ({ id: m.id, name: m.id, free: true }));
        }
        case 'gemini': {
            const apiKey = clientKey || env.GEMINI_API_KEY;
            if (!apiKey) return [];
            return fetchGeminiModelsZeroQuota(apiKey);
        }
        case 'mistral': {
            const apiKey = clientKey || env.MISTRAL_API_KEY;
            if (!apiKey) return [];
            const res = await fetch('https://api.mistral.ai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
            if (!res.ok) throw new Error('Failed to fetch Mistral models');
            const data = await res.json();
            return (data.data || []).map((m: any) => ({ id: m.id, name: m.id, free: true }));
        }
        case 'nvidia': {
            const apiKey = clientKey || env.NVIDIA_API_KEY;
            if (!apiKey) return [];
            const res = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
            if (!res.ok) throw new Error('Failed to fetch NVIDIA models');
            const data = await res.json();
            return (data.data || []).map((m: any) => ({ id: m.id, name: m.id, free: true }));
        }
        case 'cloudflare':
            return [
                { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', free: true },
                { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct', free: true }
            ];
        // 'github' removed: GitHub Models was retired on 2026-07-30 (falls through to []).
        default:
            return [];
    }
}

/**
 * Startup check: compares configured model ids against each provider's raw /models list (only when that provider's key is set).
 * Logs one console.warn per unknown id. Never throws and never exits.
 */
export async function warnUnknownConfiguredModels(
    configured: Record<string, string[]>,
    env: Record<string, any> = {}
): Promise<string[]> {
    const warnings: string[] = [];
    for (const [provider, ids] of Object.entries(configured)) {
        try {
            if (!keyFor(provider, env) && provider !== 'openrouter') continue;
            if (provider === 'openrouter' && !env.OPENROUTER_API_KEY) continue;
            const listed = await listProviderModels(provider, undefined, env);
            if (!Array.isArray(listed) || listed.length === 0) continue;
            const known = new Set(listed.map((m: any) => String(m.id)));
            for (const id of Array.from(new Set(ids.filter(Boolean)))) {
                if (!known.has(id)) {
                    const msg = `WARNING: configured ${provider} model '${id}' is not in the provider's /models list (retired or no access?).`;
                    console.warn(msg);
                    warnings.push(msg);
                }
            }
        } catch {
            // listing failed (network/key): skip silently, never block startup
        }
    }
    return warnings;
}
