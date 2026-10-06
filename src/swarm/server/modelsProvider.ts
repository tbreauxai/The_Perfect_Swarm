/**
 * Fetches available models from supported LLM providers with edge-safe fetch calls.
 * Chat models are kept, dead ids are dropped after a short probe, and the rest
 * are ordered available-first then most capable.
 */
export async function fetchProviderModels(provider: string, clientKey?: string, env: Record<string, any> = {}): Promise<any[]> {
    const listed = await listProviderModels(provider, clientKey, env);
    const apiKey = clientKey || keyFor(provider, env);
    return rankModelsForAccount(provider, listed, apiKey);
}

const NON_CHAT = /tts|whisper|image|embed|ocr|lyria|transcribe|prompt-guard|orpheus|robotics|moderation|computer-use|realtime|speech|safeguard|deep-research|antigravity|nano-banana|clip-preview/i;

const availabilityCache = new Map<string, { state: 'ok' | 'limited' | 'dead'; at: number }>();
const CACHE_MS = 15 * 60 * 1000;

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

    const probePool = [...ranked].sort((a, b) => Number(b.free) - Number(a.free) || b.capability - a.capability);
    const toProbe = apiKey ? probePool.slice(0, 8) : [];
    await mapLimit(toProbe, 4, async (m) => {
        m.availability = await probeAvailability(provider, m.id, apiKey as string);
    });

    const usable = ranked.filter((m) => m.availability !== 'dead');
    usable.sort((a, b) => availabilityRank(a.availability) - availabilityRank(b.availability) || b.capability - a.capability);
    return usable.map((m) => ({
        ...m,
        name: m.capability ? `${m.name} · c${m.capability}` : m.name,
        available: m.availability === 'ok' || m.availability === 'limited'
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
        case 'openrouter': return env.OPENROUTER_API_KEY;
        case 'github': return env.GITHUB_TOKEN;
        default: return undefined;
    }
}

async function probeAvailability(provider: string, modelId: string, apiKey: string): Promise<'ok' | 'limited' | 'dead'> {
    const cacheKey = `${provider}:${modelId}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
    const state = await pingModel(provider, modelId, apiKey);
    availabilityCache.set(cacheKey, { state, at: Date.now() });
    return state;
}

async function pingModel(provider: string, modelId: string, apiKey: string): Promise<'ok' | 'limited' | 'dead'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
        const res = await fetch(probeUrl(provider, modelId, apiKey), {
            method: 'POST',
            headers: probeHeaders(provider, apiKey),
            body: JSON.stringify(probeBody(provider, modelId)),
            signal: controller.signal
        });
        if (res.ok) return 'ok';
        if (res.status === 404 || res.status === 403 || res.status === 401) return 'dead';
        if (res.status === 429 || res.status === 503) return 'limited';
        const text = await res.text();
        if (/no longer available|does not exist|not available in your/i.test(text)) return 'dead';
        if (/rate limit|high demand|quota/i.test(text)) return 'limited';
        return 'dead';
    } catch {
        return 'limited';
    } finally {
        clearTimeout(timer);
    }
}

function probeUrl(provider: string, modelId: string, apiKey: string): string {
    switch (provider.toLowerCase()) {
        case 'gemini':
            return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        case 'groq':
            return 'https://api.groq.com/openai/v1/chat/completions';
        case 'mistral':
            return 'https://api.mistral.ai/v1/chat/completions';
        case 'openrouter':
            return 'https://openrouter.ai/api/v1/chat/completions';
        case 'github':
            return 'https://models.inference.ai.azure.com/chat/completions';
        default:
            return 'about:blank';
    }
}

function probeHeaders(provider: string, apiKey: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.toLowerCase() !== 'gemini') headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function probeBody(provider: string, modelId: string): Record<string, any> {
    if (provider.toLowerCase() === 'gemini') {
        return { contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 1 } };
    }
    return { model: modelId, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 };
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
        case 'github': {
            const apiKey = clientKey || env.GITHUB_TOKEN;
            if (!apiKey) return [];
            const res = await fetch('https://models.inference.ai.azure.com/models', { headers: { Authorization: `Bearer ${apiKey}` } });
            if (!res.ok) throw new Error('Failed to fetch GitHub models');
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.data || []);
            return list.map((m: any) => ({ id: m.name, name: m.friendly_name || m.name, free: true }));
        }
        default:
            return [];
    }
}
