import { ProviderRegistry } from '../providers/registry.ts';
import { globalProviderLimiter } from '../providers/limiter.ts';

export const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
    gemini: 'gemini-3.5-flash',
    groq: 'openai/gpt-oss-120b',
    openrouter: 'nvidia/nemotron-3-super-120b-a12b:free',
    mistral: 'mistral-small-latest',
    cloudflare: '@cf/meta/llama-3.1-8b-instruct',
    nvidia: 'nvidia/llama-3.3-nemotron-super-49b-v1.5'
};

const catalogCache = new Map<string, { models: any[]; at: number }>();
const inFlightProbes = new Map<string, Promise<any[]>>();
export const CATALOG_CACHE_MS = 60 * 60 * 1000;

export function clearCatalogCache(): void {
    catalogCache.clear();
    availabilityCache.clear();
    deadModels.clear();
    inFlightProbes.clear();
}

/**
 * Fetches available models from supported LLM providers with edge-safe fetch calls.
 * Chat models are kept. A model is live only if the same adapter a seat uses
 * returns generated text for a tiny prompt. Dead ids are dropped.
 */
export async function fetchProviderModels(
    provider: string,
    clientKey?: string,
    env: Record<string, any> = {},
    options?: { forceRefresh?: boolean; boundedWaitMs?: number }
): Promise<any[]> {
    const prov = provider.toLowerCase();
    const apiKey = clientKey || keyFor(prov, env);
    const cacheKey = `${prov}:${apiKey ? apiKey.slice(-6) : 'unkeyed'}`;

    if (!options?.forceRefresh) {
        const cached = catalogCache.get(cacheKey);
        if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) {
            return cached.models;
        }
    }

    if (inFlightProbes.has(cacheKey)) {
        return inFlightProbes.get(cacheKey)!;
    }

    const probePromise = (async () => {
        try {
            const listed = await listProviderModels(prov, clientKey, env);
            const ranked = await rankModelsForAccount(prov, listed, apiKey);
            if (ranked.length > 0) {
                catalogCache.set(cacheKey, { models: ranked, at: Date.now() });
            }
            return ranked;
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
                if (existing) {
                    resolve(existing.models);
                } else {
                    const fallbackModel = DEFAULT_PROVIDER_MODELS[prov];
                    resolve(fallbackModel ? [{ id: fallbackModel, name: fallbackModel, available: true }] : []);
                }
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
export async function probeAllProviders(env: Record<string, any> = {}): Promise<void> {
    for (const provider of CATALOG_PROVIDERS) {
        try {
            await fetchProviderModels(provider, undefined, env);
        } catch (err: any) {
            console.warn(`[catalog] scheduled probe failed for ${provider}:`, err?.message || err);
        }
    }
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
// requests a seat needs. These lists are the known-good models and are
// reviewed on the first of each month.
const FIXED_CATALOGS: Record<string, { id: string; name: string }[]> = {
    openrouter: [
        { id: 'openrouter/free', name: 'OpenRouter Free' },
        { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B' },
        { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B' }
    ],
    mistral: [
        { id: 'ministral-14b-latest', name: 'Ministral 14B' },
        { id: 'mistral-small-latest', name: 'Mistral Small' }
    ]
};
const FIXED_CATALOG_REVIEWED = '2026-10-01';

export async function rankModelsForAccount(provider: string, models: any[], apiKey?: string): Promise<any[]> {
    const prov = provider.toLowerCase();
    const fixed = FIXED_CATALOGS[prov];
    if (fixed) {
        return fixed.map(m => ({ ...m, capability: capabilityScore(m.id), available: true }));
    }
    const chat = (models || []).filter((m) => m && isChatModel(m.id));
    const defaultModelId = DEFAULT_PROVIDER_MODELS[prov];

    const ranked = chat.map((m) => {
        const isFree = Boolean(m.free || /:free|openrouter\/free/i.test(m.id));
        const isDefault = defaultModelId && (m.id === defaultModelId || m.id.endsWith(defaultModelId));
        let cap = capabilityScore(m.id);
        // Priority boost: default model and free models must rank highest for probing
        if (isDefault) cap += 1000;
        else if (isFree && prov === 'openrouter') cap += 500;
        else if (prov === 'gemini' && /flash/i.test(m.id) && !/pro/i.test(m.id)) cap += 400;
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

    // A provider with hundreds of models never finishes a full probe.
    // Probe the top by capability so the catalog returns proved-live models.
    const PROBE_CAP = 20;
    const toProbe = ranked.slice(0, PROBE_CAP);

    // OpenRouter/Gemini free models rate limit fast. Probe fewer so free-tier Flash models answer without hitting Pro 429s.
    const paced = prov === 'mistral' || prov === 'openrouter';
    const cap = paced ? 8 : (prov === 'gemini' ? 8 : PROBE_CAP);
    const batch = toProbe.slice(0, cap);
    await mapLimit(batch, paced ? 1 : (prov === 'gemini' ? 3 : 6), async (m) => {
        m.availability = await probeAvailability(provider, m.id, apiKey);
    });

    // Rate-limited models are not retried here. The retry waited out the
    // provider window and the caller's 20s timeout fired first, so the
    // catalog never arrived. A rate limit is not cached, so the next
    // request probes those models fresh.
    let live = batch.filter((m) => m.availability === 'ok');

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
    return live.map((m) => {
        const displayCap = capabilityScore(m.id);
        return {
            ...m,
            capability: displayCap,
            name: displayCap ? `${m.name} · c${displayCap}` : m.name,
            available: m.availability !== 'dead'
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
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            if (!res.ok) throw new Error('Failed to fetch Gemini models');
            const data = await res.json();
            return (data.models || [])
                .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                .map((m: any) => ({
                    id: (m.name || '').replace('models/', ''),
                    name: m.displayName || m.name,
                    free: true
                }));
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
