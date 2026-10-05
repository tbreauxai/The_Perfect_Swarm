import { checkProviderModelsHealth } from '../../services/providerService';
import { getApiKeyForProvider } from '../AgentConfigurator';
import { authHeaders } from '../../services/appAuthHeaders';

export interface ProviderBackoffState {
    consecutive429: number;
    backoffUntil: number;
}

export const PROVIDER_BACKOFFS = new Map<string, ProviderBackoffState>();

export function getProviderBackoff(provider: string): ProviderBackoffState | undefined {
    return PROVIDER_BACKOFFS.get(provider.toLowerCase());
}

export function parseRetryAfterMs(headerVal: string | null): number | null {
    if (!headerVal) return null;
    const trimmed = headerVal.trim();
    const asSeconds = Number(trimmed);
    if (!isNaN(asSeconds) && asSeconds > 0) {
        return Math.min(30000, Math.max(1000, Math.round(asSeconds * 1000)));
    }
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate)) {
        const diffMs = parsedDate - Date.now();
        if (diffMs > 0) {
            return Math.min(30000, Math.max(1000, diffMs));
        }
    }
    return null;
}

export function calculateBackoffMs(provider: string, retryAfterHeader?: string | null): number {
    const parsed = parseRetryAfterMs(retryAfterHeader ?? null);
    if (parsed !== null) {
        return parsed;
    }
    const current = PROVIDER_BACKOFFS.get(provider.toLowerCase())?.consecutive429 ?? 0;
    // Exponential backoff: 2s -> 4s -> 8s -> 16s -> capped at 30s
    return Math.min(30000, 2000 * Math.pow(2, current));
}

export function recordProvider429(provider: string, retryAfterHeader?: string | null): number {
    const pKey = provider.toLowerCase();
    const backoffMs = calculateBackoffMs(provider, retryAfterHeader);
    const current = PROVIDER_BACKOFFS.get(pKey)?.consecutive429 ?? 0;
    PROVIDER_BACKOFFS.set(pKey, {
        consecutive429: current + 1,
        backoffUntil: Date.now() + backoffMs
    });
    return backoffMs;
}

export function recordProviderSuccess(provider: string): void {
    PROVIDER_BACKOFFS.delete(provider.toLowerCase());
}

export const TIER2_CACHE_KEY = 'swarm_tier2_health_cache';
export const TIER2_TTL = 60 * 60 * 1000; // 60 mins

export async function ensureTier2Health(provider: string, modelId: string, settings: any): Promise<boolean> {
    try {
        const cacheRaw = localStorage.getItem(TIER2_CACHE_KEY);
        const cache = cacheRaw ? JSON.parse(cacheRaw) : {};
        const key = `${provider}:${modelId}`;
        const cached = cache[key];

        if (cached && (Date.now() - cached.at < TIER2_TTL)) {
            return cached.passed;
        }
        const apiKey = getApiKeyForProvider(settings, provider);
        const result = await checkProviderModelsHealth(provider, [{ id: modelId, name: modelId }], apiKey, { skipTier2: false });

        const resultKey = `${provider.toLowerCase().trim()}:${modelId.trim()}`;
        const passed = result[resultKey]?.healthy ?? true;

        cache[key] = { passed, at: Date.now() };
        localStorage.setItem(TIER2_CACHE_KEY, JSON.stringify(cache));

        return passed;
    } catch {
        // fail open on 429s or timeouts
        return true;
    }
}

// One shared failover list, used by BOTH the prompt-generator and the grader.
// Order matters: cheapest verified model first, so grading stays cheap.
export const WORKING_MODELS = [
    { provider: 'gemini', model: 'gemini-3.5-flash-lite' }, // verified live 2026-09-28, cheapest grader pick
    { provider: 'gemini', model: 'gemini-3.5-flash' }, // verified live 2026-09-28
    { provider: 'gemini', model: 'gemini-3.8-flash' }, // verified live 2026-09-28
    { provider: 'mistral', model: 'mistral-small-latest' }, // valid ID
    { provider: 'mistral', model: 'open-mistral-nemo' } // valid ID
];

export let promptGenCursor = 0;
export let graderCursor = 0;

export function getNextPromptGenCursor(): number {
    return promptGenCursor++;
}

export function getNextGraderCursor(): number {
    return graderCursor++;
}

export interface GraderCacheEntry {
    scores: { intelligence: number | null; accuracy: number | null; speed: number };
    timestamp: number;
}

export const GRADER_CACHE_STORAGE_KEY = 'swarm_grader_cache_v1';
export const GRADER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function loadGraderCache(): Map<string, GraderCacheEntry> {
    try {
        if (typeof localStorage === 'undefined') return new Map();
        const raw = localStorage.getItem(GRADER_CACHE_STORAGE_KEY);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        const map = new Map<string, GraderCacheEntry>();
        const now = Date.now();
        for (const [k, v] of Object.entries(parsed)) {
            const entry = v as GraderCacheEntry;
            if (now - entry.timestamp < GRADER_CACHE_TTL_MS) {
                map.set(k, entry);
            }
        }
        return map;
    } catch (e) {
        console.warn('Failed to parse grader cache from localStorage, initializing fresh map:', e);
        return new Map();
    }
}

export function saveGraderCache(cache: Map<string, GraderCacheEntry>): void {
    try {
        if (typeof localStorage === 'undefined') return;
        const obj: Record<string, GraderCacheEntry> = {};
        const entries = Array.from(cache.entries());
        const start = Math.max(0, entries.length - 200);
        for (let i = start; i < entries.length; i++) {
            const [k, v] = entries[i];
            obj[k] = v;
        }
        localStorage.setItem(GRADER_CACHE_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
        console.warn('Failed to save grader cache to localStorage:', e);
    }
}

export const GRADER_CACHE = loadGraderCache();

export const PROMPT_GEN_CACHE_STORAGE_KEY = 'swarm_prompt_gen_cache_v1';

export function getPromptGenCacheKey(analystRole: string, baseTask: string): string {
    return `${analystRole.toLowerCase().trim()}:::${baseTask.trim()}`;
}

export function loadPromptGenCache(): Map<string, string> {
    try {
        if (typeof localStorage === 'undefined') return new Map();
        const raw = localStorage.getItem(PROMPT_GEN_CACHE_STORAGE_KEY);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        const map = new Map<string, string>();
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') {
                map.set(k, v);
            }
        }
        return map;
    } catch (e) {
        console.warn('Failed to parse prompt generation cache from localStorage, initializing fresh map:', e);
        return new Map();
    }
}

export function savePromptGenCache(cache: Map<string, string>): void {
    try {
        if (typeof localStorage === 'undefined') return;
        const obj: Record<string, string> = {};
        const entries = Array.from(cache.entries());
        const start = Math.max(0, entries.length - 100);
        for (let i = start; i < entries.length; i++) {
            const [k, v] = entries[i];
            obj[k] = v;
        }
        localStorage.setItem(PROMPT_GEN_CACHE_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
        console.warn('Failed to save prompt generation cache to localStorage:', e);
    }
}

export const PROMPT_GEN_CACHE = loadPromptGenCache();

// Cache of in-flight analyze calls for deduplication
export const IN_FLIGHT_ANALYZE_CALLS = new Map<string, Promise<Response>>();

export async function fetchAnalyze(body: any, timeoutMs: number): Promise<Response> {
    const serializedBody = JSON.stringify(body);
    let promise = IN_FLIGHT_ANALYZE_CALLS.get(serializedBody);

    if (!promise) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        promise = fetch('/api/swarm/analyze', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: serializedBody,
            signal: controller.signal
        }).finally(() => {
            clearTimeout(timeoutId);
            IN_FLIGHT_ANALYZE_CALLS.delete(serializedBody);
        });

        IN_FLIGHT_ANALYZE_CALLS.set(serializedBody, promise);
    }

    return promise.then(res => res.clone());
}

export function getGraderCacheKey(task: string, output: any, graderModel: string = 'default'): string {
    const serialized = typeof output === 'object' ? JSON.stringify(output) : String(output || '');
    let hash = 0x811c9dc5;
    const str = `${task}:::${serialized}:::${graderModel}:::v2`;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `gc_${(hash >>> 0).toString(16)}`;
}
