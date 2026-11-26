export const LIVE_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const LIVE_MODEL_PROVIDERS = [
    'gemini',
    'nvidia',
    'groq',
    'mistral',
    'openrouter',
    'cloudflare'
] as const;

export type LiveModelProvider = (typeof LIVE_MODEL_PROVIDERS)[number];

export interface LiveModelEntry {
    id: string;
    label: string;
    freeTierVerified: boolean;
    supportsThinking?: boolean;
    inputTokenLimit?: number;
}

export interface LiveModelsResponse {
    provider: LiveModelProvider;
    keyConfigured: boolean;
    source: string;
    verifiedAt: string;
    models: LiveModelEntry[];
}

export class LiveModelsError extends Error {
    readonly status: number;
    constructor(message: string, status = 500) {
        super(message);
        this.name = 'LiveModelsError';
        this.status = status;
    }
}

const GEMINI_PRICING_MD_URL = 'https://ai.google.dev/gemini-api/docs/pricing.md.txt';
const GEMINI_MODELS_EXCLUDE_RE = /embedding|imagen|veo|lyria|tts|native-audio|robotics|aqa/i;
const NVIDIA_MODELS_EXCLUDE_RE = /embed|rerank|parse|ocr|guard|shield|cosmos|sdxl|flux|canary|parakeet|riva|deplot|paligemma|vila|neva/i;
const GROQ_MODELS_EXCLUDE_RE = /whisper|tts|playai|guard|safeguard|embed/i;
const MISTRAL_MODELS_EXCLUDE_RE = /embed|ocr|moderation|voxtral/i;

const SECRET_ENV_KEYS = [
    'GEMINI_API_KEY',
    'NVIDIA_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'OPENROUTER_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_WORKERS_AI_TOKEN'
] as const;

const CLOUDFLARE_FALLBACK_MODELS: LiveModelEntry[] = [
    {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        label: 'Llama 3.3 70B Instruct FP8 Fast',
        freeTierVerified: true
    },
    {
        id: '@cf/meta/llama-3.1-8b-instruct',
        label: 'Llama 3.1 8B Instruct',
        freeTierVerified: true
    },
    {
        id: '@cf/qwen/qwen2.5-72b-instruct',
        label: 'Qwen 2.5 72B Instruct',
        freeTierVerified: true
    }
];

interface CachedLiveModelsEntry {
    expiresAt: number;
    data: LiveModelsResponse;
}

const liveModelsCache = new Map<string, CachedLiveModelsEntry>();

export function clearLiveModelsCache(): void {
    liveModelsCache.clear();
}

export function redactSecretValues(text: unknown, env: Record<string, any> = {}): string {
    let out = String(text ?? '');
    for (const k of SECRET_ENV_KEYS) {
        const val = typeof env?.[k] === 'string' ? env[k].trim() : '';
        if (val && val.length >= 4) {
            out = out.split(val).join('[REDACTED]');
        }
    }
    return out
        .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
}

function humanizeModelId(id: string): string {
    return id
        .replace(/^models\//i, '')
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => (/^\d+(?:\.\d+)?$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join(' ');
}

export interface ParsedGeminiPricingMd {
    freeModels: Map<string, { id: string; label: string }>;
    paidOnlyIds: Set<string>;
}

/**
 * Parses `https://ai.google.dev/gemini-api/docs/pricing.md.txt` to identify Gemini/Gemma models
 * whose Free Tier pricing states `Free of charge` (and NOT `Not available`).
 */
export function parseGeminiPricingMdFreeModels(markdown: string): ParsedGeminiPricingMd {
    const freeModels = new Map<string, { id: string; label: string }>();
    const paidOnlyIds = new Set<string>();
    if (!markdown || typeof markdown !== 'string') {
        return { freeModels, paidOnlyIds };
    }

    const lines = markdown.split(/\r?\n/);
    let currentSectionHeading = '';
    let currentSectionIds: string[] = [];
    let currentSectionHasFree = false;
    let currentSectionHasNotAvailable = false;

    const flushSection = () => {
        if (currentSectionIds.length === 0) return;
        for (const id of currentSectionIds) {
            if (GEMINI_MODELS_EXCLUDE_RE.test(id)) continue;
            if (currentSectionHasFree && !currentSectionHasNotAvailable) {
                freeModels.set(id, { id, label: currentSectionHeading || humanizeModelId(id) });
                paidOnlyIds.delete(id);
            } else if (currentSectionHasNotAvailable && !currentSectionHasFree) {
                if (!freeModels.has(id)) {
                    paidOnlyIds.add(id);
                }
            }
        }
    };

    const modelIdRegex = /\b((?:gemini|gemma)-[a-z0-9.-]+)\b/gi;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // 1. Table row containing a model ID AND pricing verdict on the same line
        if (line.startsWith('|')) {
            const rowIds = Array.from(line.matchAll(modelIdRegex), (m) => m[1].toLowerCase());
            const hasFree = /\bfree of charge\b/i.test(line);
            const hasNotAvail = /\bnot available\b/i.test(line);
            if (rowIds.length > 0 && (hasFree || hasNotAvail)) {
                for (const id of rowIds) {
                    if (GEMINI_MODELS_EXCLUDE_RE.test(id)) continue;
                    if (hasFree && !hasNotAvail) {
                        freeModels.set(id, { id, label: humanizeModelId(id) });
                        paidOnlyIds.delete(id);
                    } else if (hasNotAvail && !hasFree && !freeModels.has(id)) {
                        paidOnlyIds.add(id);
                    }
                }
                continue;
            }
        }

        // 2. Markdown heading starting a new model section
        const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
        if (headingMatch) {
            flushSection();
            currentSectionHeading = headingMatch[1].replace(/[`*]/g, '').trim();
            currentSectionIds = Array.from(currentSectionHeading.matchAll(modelIdRegex), (m) => m[1].toLowerCase());
            currentSectionHasFree = false;
            currentSectionHasNotAvailable = false;
            continue;
        }

        // 3. Collect model IDs and Free Tier status inside current section
        const lineIds = Array.from(line.matchAll(modelIdRegex), (m) => m[1].toLowerCase());
        for (const id of lineIds) {
            if (!currentSectionIds.includes(id)) {
                currentSectionIds.push(id);
            }
        }
        if (/\bfree of charge\b/i.test(line)) {
            currentSectionHasFree = true;
        }
        if (/\bfree\s*tier\b.*\bnot available\b|\bnot available\b.*\bfree\s*tier\b/i.test(line) || (line.startsWith('|') && /\bnot available\b/i.test(line))) {
            currentSectionHasNotAvailable = true;
        }
    }

    flushSection();
    return { freeModels, paidOnlyIds };
}

async function fetchJsonSafe(
    fetchFn: typeof fetch,
    url: string,
    init: RequestInit | undefined,
    env: Record<string, any>,
    providerLabel: string
): Promise<any> {
    const res = await fetchFn(url, init);
    if (!res.ok) {
        let bodySnippet = '';
        try {
            bodySnippet = (await res.text()).slice(0, 200);
        } catch {
            // ignore body read error
        }
        throw new LiveModelsError(
            redactSecretValues(
                `Failed to fetch ${providerLabel} models (${res.status})${bodySnippet ? `: ${bodySnippet}` : ''}`,
                env
            ),
            502
        );
    }
    return res.json();
}

async function discoverGeminiLiveModels(
    env: Record<string, any>,
    fetchFn: typeof fetch,
    probe: boolean
): Promise<LiveModelsResponse> {
    const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
    const keyConfigured = apiKey.length > 0;
    const verifiedAt = new Date().toISOString();

    let pricingParsed: ParsedGeminiPricingMd = { freeModels: new Map(), paidOnlyIds: new Set() };
    let pricingLoaded = false;
    try {
        const pricingRes = await fetchFn(GEMINI_PRICING_MD_URL);
        if (pricingRes.ok) {
            const md = await pricingRes.text();
            pricingParsed = parseGeminiPricingMdFreeModels(md);
            pricingLoaded = pricingParsed.freeModels.size > 0 || pricingParsed.paidOnlyIds.size > 0;
        }
    } catch {
        // Non-fatal: fall back to live API alone if docs fetch is unavailable
    }

    if (!keyConfigured) {
        const models: LiveModelEntry[] = Array.from(pricingParsed.freeModels.values()).map((m) => ({
            id: m.id,
            label: m.label,
            freeTierVerified: true,
            supportsThinking: /^gemini-(?:2\.5|3|4)/i.test(m.id)
        }));
        return {
            provider: 'gemini',
            keyConfigured: false,
            source: 'official_pricing_md',
            verifiedAt,
            models
        };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
    const data = await fetchJsonSafe(fetchFn, url, undefined, env, 'Gemini');
    const rawModels: any[] = Array.isArray(data?.models) ? data.models : [];

    const chatModels = rawModels.filter((m: any) => {
        const id = String(m?.name || '').replace(/^models\//i, '').trim();
        const methods: string[] = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        if (!id || !methods.includes('generateContent')) return false;
        if (GEMINI_MODELS_EXCLUDE_RE.test(id)) return false;
        return true;
    });

    const models: LiveModelEntry[] = [];
    for (const m of chatModels) {
        const id = String(m.name || '').replace(/^models\//i, '').trim();
        const lowerId = id.toLowerCase();
        const inFreeSet = pricingParsed.freeModels.has(lowerId);
        const inPaidOnlySet = pricingParsed.paidOnlyIds.has(lowerId);

        if (pricingLoaded) {
            if (inPaidOnlySet) continue;
            if (!inFreeSet && !probe) continue;
        }

        let freeTierVerified = inFreeSet;
        if (probe && !inFreeSet) {
            try {
                const probeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent?key=${encodeURIComponent(apiKey)}`;
                const probeRes = await fetchFn(probeUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: 'ok' }] }],
                        generationConfig: { maxOutputTokens: 1 }
                    })
                });
                if (probeRes.ok) {
                    freeTierVerified = true;
                } else {
                    const errBody = await probeRes.text().catch(() => '');
                    if (probeRes.status === 429 && /free_tier/i.test(errBody) && /\blimit\s*:\s*0\b/i.test(errBody)) {
                        freeTierVerified = false;
                        continue;
                    }
                }
            } catch {
                // Keep unclassified as unverified if probe fails transiently
            }
        }

        models.push({
            id,
            label: String(m.displayName || '').trim() || humanizeModelId(id),
            freeTierVerified,
            supportsThinking: Boolean(m.thinking) || /^gemini-(?:2\.5|3|4)/i.test(lowerId),
            ...(typeof m.inputTokenLimit === 'number' ? { inputTokenLimit: m.inputTokenLimit } : {})
        });
    }

    return {
        provider: 'gemini',
        keyConfigured: true,
        source: pricingLoaded ? 'live_api+official_pricing_md' : 'live_api',
        verifiedAt,
        models
    };
}

async function fetchNvidiaModelsDevFallback(fetchFn: typeof fetch, env: Record<string, any>): Promise<LiveModelEntry[]> {
    const data = await fetchJsonSafe(fetchFn, 'https://models.dev/api.json', undefined, env, 'NVIDIA models.dev');
    const nvidiaModels = data?.nvidia?.models && typeof data.nvidia.models === 'object' ? data.nvidia.models : {};
    const out: LiveModelEntry[] = [];
    for (const [key, val] of Object.entries<any>(nvidiaModels)) {
        const id = String(val?.id || key || '').trim();
        if (!id || NVIDIA_MODELS_EXCLUDE_RE.test(id)) continue;
        const outputModalities: string[] | undefined = Array.isArray(val?.modalities?.output) ? val.modalities.output : undefined;
        if (outputModalities && !outputModalities.includes('text')) continue;
        out.push({
            id,
            label: String(val?.name || '').trim() || id,
            freeTierVerified: true,
            ...(typeof val?.reasoning === 'boolean' ? { supportsThinking: val.reasoning } : {}),
            ...(typeof val?.limit?.context === 'number' ? { inputTokenLimit: val.limit.context } : {})
        });
    }
    return out;
}

async function discoverNvidiaLiveModels(env: Record<string, any>, fetchFn: typeof fetch): Promise<LiveModelsResponse> {
    const apiKey = typeof env.NVIDIA_API_KEY === 'string' ? env.NVIDIA_API_KEY.trim() : '';
    const keyConfigured = apiKey.length > 0;
    const verifiedAt = new Date().toISOString();

    if (keyConfigured) {
        try {
            const data = await fetchJsonSafe(
                fetchFn,
                'https://integrate.api.nvidia.com/v1/models',
                { headers: { Authorization: `Bearer ${apiKey}` } },
                env,
                'NVIDIA'
            );
            const raw: any[] = Array.isArray(data?.data) ? data.data : [];
            const models: LiveModelEntry[] = raw
                .map((m) => String(m?.id || '').trim())
                .filter((id) => id.length > 0 && !NVIDIA_MODELS_EXCLUDE_RE.test(id))
                .map((id) => ({
                    id,
                    label: id,
                    freeTierVerified: true
                }));
            return {
                provider: 'nvidia',
                keyConfigured: true,
                source: 'live_api',
                verifiedAt,
                models
            };
        } catch {
            // Fall through to models.dev fallback on upstream error
        }
    }

    const models = await fetchNvidiaModelsDevFallback(fetchFn, env);
    return {
        provider: 'nvidia',
        keyConfigured,
        source: 'models_dev_fallback',
        verifiedAt,
        models
    };
}

async function discoverGroqLiveModels(env: Record<string, any>, fetchFn: typeof fetch): Promise<LiveModelsResponse> {
    const apiKey = typeof env.GROQ_API_KEY === 'string' ? env.GROQ_API_KEY.trim() : '';
    const verifiedAt = new Date().toISOString();
    if (!apiKey) {
        return { provider: 'groq', keyConfigured: false, source: 'unconfigured', verifiedAt, models: [] };
    }
    const data = await fetchJsonSafe(
        fetchFn,
        'https://api.groq.com/openai/v1/models',
        { headers: { Authorization: `Bearer ${apiKey}` } },
        env,
        'Groq'
    );
    const raw: any[] = Array.isArray(data?.data) ? data.data : [];
    const models: LiveModelEntry[] = raw
        .map((m) => String(m?.id || '').trim())
        .filter((id) => id.length > 0 && !GROQ_MODELS_EXCLUDE_RE.test(id))
        .map((id) => ({
            id,
            label: id,
            freeTierVerified: true
        }));
    return {
        provider: 'groq',
        keyConfigured: true,
        source: 'live_api',
        verifiedAt,
        models
    };
}

async function discoverMistralLiveModels(env: Record<string, any>, fetchFn: typeof fetch): Promise<LiveModelsResponse> {
    const apiKey = typeof env.MISTRAL_API_KEY === 'string' ? env.MISTRAL_API_KEY.trim() : '';
    const verifiedAt = new Date().toISOString();
    if (!apiKey) {
        return { provider: 'mistral', keyConfigured: false, source: 'unconfigured', verifiedAt, models: [] };
    }
    const data = await fetchJsonSafe(
        fetchFn,
        'https://api.mistral.ai/v1/models',
        { headers: { Authorization: `Bearer ${apiKey}` } },
        env,
        'Mistral'
    );
    const raw: any[] = Array.isArray(data?.data) ? data.data : [];
    const models: LiveModelEntry[] = raw
        .filter((m) => {
            const id = String(m?.id || '').trim();
            return id.length > 0 && !MISTRAL_MODELS_EXCLUDE_RE.test(id);
        })
        .map((m) => {
            const id = String(m.id).trim();
            return {
                id,
                label: String(m.name || '').trim() || id,
                freeTierVerified: true,
                ...(typeof m.max_context_length === 'number' ? { inputTokenLimit: m.max_context_length } : {})
            };
        });
    return {
        provider: 'mistral',
        keyConfigured: true,
        source: 'live_api',
        verifiedAt,
        models
    };
}

async function discoverOpenRouterLiveModels(env: Record<string, any>, fetchFn: typeof fetch): Promise<LiveModelsResponse> {
    const apiKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
    const verifiedAt = new Date().toISOString();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    const data = await fetchJsonSafe(
        fetchFn,
        'https://openrouter.ai/api/v1/models',
        headers ? { headers } : undefined,
        env,
        'OpenRouter'
    );
    const raw: any[] = Array.isArray(data?.data) ? data.data : [];
    const models: LiveModelEntry[] = raw
        .filter((m) => {
            const id = String(m?.id || '').trim();
            if (!id) return false;
            const hasZeroPricing =
                m?.pricing?.prompt !== undefined &&
                m?.pricing?.prompt !== null &&
                m?.pricing?.completion !== undefined &&
                m?.pricing?.completion !== null &&
                Number(m.pricing.prompt) === 0 &&
                Number(m.pricing.completion) === 0;
            return hasZeroPricing || id.endsWith(':free');
        })
        .map((m) => {
            const id = String(m.id).trim();
            return {
                id,
                label: String(m.name || '').trim() || id,
                freeTierVerified: true,
                ...(typeof m.context_length === 'number' ? { inputTokenLimit: m.context_length } : {})
            };
        });
    return {
        provider: 'openrouter',
        keyConfigured: apiKey.length > 0,
        source: 'live_api',
        verifiedAt,
        models
    };
}

async function discoverCloudflareLiveModels(env: Record<string, any>, fetchFn: typeof fetch): Promise<LiveModelsResponse> {
    const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || '').trim();
    const apiToken = String(env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN || '').trim();
    const keyConfigured = accountId.length > 0 && apiToken.length > 0;
    const verifiedAt = new Date().toISOString();

    if (keyConfigured) {
        try {
            const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text%20Generation`;
            const data = await fetchJsonSafe(
                fetchFn,
                url,
                { headers: { Authorization: `Bearer ${apiToken}` } },
                env,
                'Cloudflare'
            );
            const raw: any[] = Array.isArray(data?.result) ? data.result : [];
            const models: LiveModelEntry[] = raw
                .map((m) => ({
                    id: String(m?.name || m?.id || '').trim(),
                    label: String(m?.description || m?.name || '').trim() || String(m?.name || m?.id || '').trim(),
                    freeTierVerified: true
                }))
                .filter((m) => m.id.length > 0);
            if (models.length > 0) {
                return {
                    provider: 'cloudflare',
                    keyConfigured: true,
                    source: 'live_api',
                    verifiedAt,
                    models
                };
            }
        } catch {
            // Fall back to curated Workers AI text-gen list
        }
    }

    return {
        provider: 'cloudflare',
        keyConfigured,
        source: 'workers_ai_catalog',
        verifiedAt,
        models: CLOUDFLARE_FALLBACK_MODELS.map((m) => ({ ...m }))
    };
}

export async function discoverLiveModels(
    providerRaw: string,
    env: Record<string, any> = {},
    options: { refresh?: boolean; probe?: boolean; fetchFn?: typeof fetch } = {}
): Promise<LiveModelsResponse> {
    const provider = String(providerRaw || '').trim().toLowerCase() as LiveModelProvider;
    if (!(LIVE_MODEL_PROVIDERS as readonly string[]).includes(provider)) {
        throw new LiveModelsError(
            `Unsupported provider "${redactSecretValues(providerRaw, env)}". Expected one of: ${LIVE_MODEL_PROVIDERS.join(', ')}`,
            400
        );
    }

    const probe = options.probe === true;
    const refresh = options.refresh === true;
    const cacheKey = `${provider}:${probe ? 'probe' : 'std'}`;

    if (!refresh) {
        const cached = liveModelsCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.data;
        }
    }

    const fetchFn = options.fetchFn || fetch;
    let result: LiveModelsResponse;
    switch (provider) {
        case 'gemini':
            result = await discoverGeminiLiveModels(env, fetchFn, probe);
            break;
        case 'nvidia':
            result = await discoverNvidiaLiveModels(env, fetchFn);
            break;
        case 'groq':
            result = await discoverGroqLiveModels(env, fetchFn);
            break;
        case 'mistral':
            result = await discoverMistralLiveModels(env, fetchFn);
            break;
        case 'openrouter':
            result = await discoverOpenRouterLiveModels(env, fetchFn);
            break;
        case 'cloudflare':
            result = await discoverCloudflareLiveModels(env, fetchFn);
            break;
    }

    liveModelsCache.set(cacheKey, {
        expiresAt: Date.now() + LIVE_MODEL_CACHE_TTL_MS,
        data: result
    });
    return result;
}
