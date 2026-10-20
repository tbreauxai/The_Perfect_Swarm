import { ProviderRegistry } from '../providers/registry.ts';
import { globalProviderLimiter, PROVIDER_LIMITS } from '../providers/limiter.ts';

/**
 * Fetches available models from supported LLM providers with edge-safe fetch calls.
 * Chat models are kept. A model is live only if the same adapter a seat uses
 * returns generated text for a tiny prompt. Dead ids are dropped.
 */
export async function fetchProviderModels(provider: string, clientKey?: string, env: Record<string, any> = {}): Promise<any[]> {
    const listed = await listProviderModels(provider, clientKey, env);
    const apiKey = clientKey || keyFor(provider, env);
    return rankModelsForAccount(provider, listed, apiKey);
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

const NON_CHAT = /tts|whisper|image|embed|ocr|lyria|transcribe|prompt-guard|orpheus|robotics|moderation|computer-use|realtime|speech|safeguard|deep-research|antigravity|nano-banana|clip-preview/i;

const availabilityCache = new Map<string, { state: 'ok' | 'limited' | 'dead'; at: number }>();
const deadModels = new Set<string>();
const CACHE_MS = 12 * 60 * 60 * 1000;

/** A model the probe proved dead (404 / not found). Seats read this and skip it. */
export function isModelDead(provider: string, modelId: string): boolean {
    return deadModels.has(`${provider}:${modelId}`);
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

export async function rankModelsForAccount(provider: string, models: any[], apiKey?: string): Promise<any[]> {
    const chat = (models || []).filter((m) => m && isChatModel(m.id));
    const ranked = chat.map((m) => ({
        ...m,
        capability: capabilityScore(m.id)
    }));
    ranked.sort((a, b) => b.capability - a.capability);

    if (!apiKey) return ranked.map((m) => ({ ...m, available: false }));

    // A provider with hundreds of models never finishes a full probe.
    // Probe the top by capability so the catalog returns proved-live models.
    const PROBE_CAP = 20;
    const toProbe = ranked.slice(0, PROBE_CAP);

    const paced = provider.toLowerCase() === 'mistral';
    await mapLimit(toProbe, paced ? 1 : 6, async (m) => {
        m.availability = await probeAvailability(provider, m.id, apiKey);
    });

    // Rate-limited models are not retried here. The retry waited out the
    // provider window and the caller's 20s timeout fired first, so the
    // catalog never arrived. A rate limit is not cached, so the next
    // request probes those models fresh.
    const live = toProbe.filter((m) => m.availability === 'ok');
    live.sort((a, b) => b.capability - a.capability);
    return live.map((m) => ({
        ...m,
        name: m.capability ? `${m.name} · c${m.capability}` : m.name,
        available: true
    }));
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
        case 'cloudflare': return env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN;
        case 'nvidia': return env.NVIDIA_API_KEY;
        case 'openrouter': return env.OPENROUTER_API_KEY;
        default: return undefined;
    }
}

async function probeAvailability(provider: string, modelId: string, apiKey: string): Promise<'ok' | 'limited' | 'dead'> {
    const cacheKey = `${provider}:${modelId}`;
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
    if (provider.toLowerCase() === 'mistral') return first;
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
            timeoutMs: 20000,
            role: 'catalog-probe',
            config: { maxTokens: 64, groqMode: 'chat' }
        });
        if (typeof text === 'string' && text.trim().length > 0) return 'ok';
        return 'dead';
    } catch (err: any) {
        const msg = String(err?.message || err);
        // A 404 is a real deprecation. Record it so seats skip the model.
        // A rate limit is not. It never touches the seat circuit.
        if (/\b404\b|model_not_found|NOT_FOUND/i.test(msg)) {
            deadModels.add(`${provider}:${modelId}`);
            return 'dead';
        }
        if (/429|rate limit|quota|503|high demand/i.test(msg)) return 'limited';
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
                free: m.pricing?.prompt === '0' && m.pricing?.completion === '0'
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
