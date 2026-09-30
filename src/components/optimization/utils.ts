import {
    fetchAvailableModels,
    checkProviderModelsHealth,
    ModelOption,
    getModelCircuitState,
    globalModelHealthChecker,
    getQuarantinedModels,
    isModelQuarantined,
    recordModel404,
    clearModel404Strikes,
    clearAllQuarantinedModels
} from '../../services/providerService';
import { getApiKeyForProvider } from '../AgentConfigurator';

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

const TIER2_CACHE_KEY = 'swarm_tier2_health_cache';
const TIER2_TTL = 60 * 60 * 1000; // 60 mins

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
    } catch (e) {
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

let promptGenCursor = 0;
let graderCursor = 0;

export interface GraderCacheEntry {
    scores: { intelligence: number | null; accuracy: number | null; speed: number };
    timestamp: number;
}

export const GRADER_CACHE_STORAGE_KEY = 'swarm_grader_cache_v1';
export const GRADER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function loadGraderCache(): Map<string, GraderCacheEntry> {
    const cache = new Map<string, GraderCacheEntry>();
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(GRADER_CACHE_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                const now = Date.now();
                if (typeof parsed === 'object' && parsed !== null) {
                    for (const [k, v] of Object.entries(parsed)) {
                        const entry = v as GraderCacheEntry;
                        if (entry && typeof entry.timestamp === 'number' && (now - entry.timestamp < GRADER_CACHE_TTL_MS)) {
                            cache.set(k, entry);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Failed to load grader cache from localStorage', e);
    }
    return cache;
}

export function saveGraderCache(cache: Map<string, GraderCacheEntry>): void {
    try {
        if (typeof localStorage !== 'undefined') {
            const obj: Record<string, GraderCacheEntry> = {};
            const now = Date.now();
            for (const [k, v] of cache.entries()) {
                if (now - v.timestamp < GRADER_CACHE_TTL_MS) {
                    obj[k] = v;
                }
            }
            localStorage.setItem(GRADER_CACHE_STORAGE_KEY, JSON.stringify(obj));
        }
    } catch (e) {
        console.warn('Failed to save grader cache to localStorage', e);
    }
}

export const GRADER_CACHE = loadGraderCache();

export const PROMPT_GEN_CACHE_STORAGE_KEY = 'swarm_prompt_gen_cache_v1';

export function getPromptGenCacheKey(analystRole: string, baseTask: string): string {
    return `${analystRole.toLowerCase().trim()}:::${baseTask.trim()}`;
}

export function loadPromptGenCache(): Map<string, string> {
    const cache = new Map<string, string>();
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(PROMPT_GEN_CACHE_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (typeof parsed === 'object' && parsed !== null) {
                    for (const [k, v] of Object.entries(parsed)) {
                        if (typeof v === 'string') cache.set(k, v);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Failed to load prompt gen cache from localStorage', e);
    }
    return cache;
}

export function savePromptGenCache(cache: Map<string, string>): void {
    try {
        if (typeof localStorage !== 'undefined') {
            const obj: Record<string, string> = {};
            for (const [k, v] of cache.entries()) {
                obj[k] = v;
            }
            localStorage.setItem(PROMPT_GEN_CACHE_STORAGE_KEY, JSON.stringify(obj));
        }
    } catch (e) {
        console.warn('Failed to save prompt gen cache to localStorage', e);
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
            headers: { 'Content-Type': 'application/json' },
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

export const scoreOf = (r?: { scores?: { intelligence?: number | null; accuracy?: number | null } } | null): number =>
    (r?.scores?.intelligence || 0) + (r?.scores?.accuracy || 0);

/**
 * Computes the consensus score from multiple test samples:
 * checks for a strict majority (> 50%), and falls back to rounded average.
 */
export function calculateConsensusScore(values: (number | null | undefined)[]): number | null {
    const valid = values.filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (valid.length === 0) return null;

    const counts = new Map<number, number>();
    for (const v of valid) {
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    for (const [v, count] of counts.entries()) {
        if (count > valid.length / 2) {
            return v;
        }
    }

    const sum = valid.reduce((a, b) => a + b, 0);
    return Math.round(sum / valid.length);
}

export interface OptimizationRunnerProps {
    task: string;
    data: string;
    settings: any;
    onApplyModelToSettings?: (role: string, provider: string, model: string) => void;
}

export interface OptimizationResult {
    id: string;
    role: string;
    model: string;
    provider: string;
    durationMs: number;
    output: any;
    scores: {
        intelligence: number | null;
        accuracy: number | null;
        speed: number | null;
    };
    error?: string;
    gradingError?: string;
    fromCache?: boolean;
    isFullSwarm?: boolean;
    testedAt?: string;
    consensusSamples?: number;
}

/**
 * Calculates a deterministic speed score from execution duration.
 * <= 2000ms is 10, >= 10000ms is 1, scaling linearly in between.
 */
export const calculateSpeedScore = (durationMs: number): number => {
    if (durationMs <= 2000) return 10;
    if (durationMs >= 10000) return 1;
    return Math.max(1, Math.min(10, Math.round(10 - ((durationMs - 2000) / 8000) * 9)));
};

/**
 * Evaluates whether a benchmarked model response represents a full, substantive,
 * uncorrupted analysis rather than merely the absence of a network error.
 */
export function isModelResponseValid(result?: { output?: any; error?: string } | null): boolean {
    if (!result) return false;
    if (result.error && typeof result.error === 'string' && result.error.trim().length > 0) {
        return false;
    }
    if (result.output === null || result.output === undefined) return false;

    // String output
    if (typeof result.output === 'string') {
        const trimmed = result.output.trim();
        if (trimmed.length < 20) return false;
        const lower = trimmed.toLowerCase();
        if (
            lower.startsWith('error:') ||
            lower.includes('schema_validation_failed') ||
            lower.includes('execution error') ||
            lower.includes('api key not configured')
        ) {
            return false;
        }
        return true;
    }

    // Object output
    if (typeof result.output === 'object') {
        if (result.output.error) return false;
        const titleLower = typeof result.output.ui_title === 'string' ? result.output.ui_title.toLowerCase() : '';
        if (titleLower.includes('execution error') || titleLower === 'error') {
            return false;
        }

        // Generative UI format (ManagerResponse) with components
        if (Array.isArray(result.output.components) && result.output.components.length > 0) {
            return result.output.components.some((c: any) => {
                if (!c || typeof c !== 'object') return false;
                if (c.type === 'InsightList' && Array.isArray(c.props?.insights) && c.props.insights.length > 0) {
                    return c.props.insights.some((ins: any) => {
                        const msg = typeof ins === 'string' ? ins : ins?.message;
                        if (typeof msg !== 'string') return false;
                        const msgTrimmed = msg.trim();
                        return msgTrimmed.length > 10 && !msgTrimmed.toLowerCase().startsWith('error:');
                    });
                }
                if (c.type === 'MetricCard' && c.props?.title && c.props?.value) return true;
                if (c.type === 'DataTable' && Array.isArray(c.props?.rows) && c.props.rows.length > 0) return true;
                return false;
            });
        }

        // AnalystResponse format with insights / summary
        if (Array.isArray(result.output.insights) && result.output.insights.length > 0) {
            return result.output.insights.some((i: any) => typeof i === 'string' && i.trim().length > 10);
        }
        if (typeof result.output.summary === 'string' && result.output.summary.trim().length > 20) {
            return true;
        }

        // Generic object with message/content
        if (typeof result.output.message === 'string' && result.output.message.trim().length > 20) {
            return true;
        }
    }

    return false;
}

export type ModelExecutionStatus = 'valid' | 'incomplete' | 'error';

export function getModelExecutionStatus(result?: { output?: any; error?: string } | null): ModelExecutionStatus {
    if (!result || (result.error && typeof result.error === 'string' && result.error.trim().length > 0)) {
        return 'error';
    }
    if (isModelResponseValid(result)) {
        return 'valid';
    }
    return 'incomplete';
}

/**
 * Multi-layer robust score extractor that safely extracts intelligence, accuracy,
 * and speed scores from any response structure (flat JSON, Generative UI components, or events).
 */
export function extractGradingScores(
    data: any,
    durationMs: number
): { intelligence: number | null; accuracy: number | null; speed: number } {
    const fallbackSpeed = calculateSpeedScore(durationMs);
    let intVal: number | null = null;
    let accVal: number | null = null;
    let spdVal: number | null = null;

    const parseNum = (v: any): number | null => {
        if (typeof v === 'number' && !isNaN(v)) {
            return Math.min(10, Math.max(1, Math.round(v)));
        }
        if (typeof v === 'string') {
            const m = v.match(/\b([1-9]|10)\b/);
            if (m) return parseInt(m[1], 10);
            const mFloat = v.match(/([0-9]+(?:\.[0-9]+)?)/);
            if (mFloat) return Math.min(10, Math.max(1, Math.round(parseFloat(mFloat[1]))));
        }
        return null;
    };

    const tryInspectObject = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (intVal === null && (obj.intelligence !== undefined || obj.intellect !== undefined || obj.int !== undefined)) {
            intVal = parseNum(obj.intelligence ?? obj.intellect ?? obj.int);
        }
        if (accVal === null && (obj.accuracy !== undefined || obj.acc !== undefined)) {
            accVal = parseNum(obj.accuracy ?? obj.acc);
        }
        if (spdVal === null && (obj.speed !== undefined || obj.spd !== undefined)) {
            spdVal = parseNum(obj.speed ?? obj.spd);
        }
    };

    const tryScanString = (str: any) => {
        if (typeof str !== 'string' || !str.trim()) return;
        const cleaned = str.replace(/```(?:json)?\n?/gi, '').replace(/```/g, '').trim();

        // 1. Try finding JSON block
        try {
            const matches = cleaned.match(/\{[\s\S]*?\}/g);
            if (matches) {
                for (const m of matches) {
                    try {
                        const parsed = JSON.parse(m);
                        tryInspectObject(parsed);
                        if (intVal !== null && accVal !== null) return;
                    } catch {}
                }
            }
        } catch {}

        // 2. Regex matching for "intelligence: X" etc.
        if (intVal === null) {
            const m = cleaned.match(/\b(?:intelligence|intellect|int)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
            if (m) intVal = parseNum(m[1]);
        }
        if (accVal === null) {
            const m = cleaned.match(/\b(?:accuracy|acc)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
            if (m) accVal = parseNum(m[1]);
        }
        if (spdVal === null) {
            const m = cleaned.match(/\b(?:speed|spd)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
            if (m) spdVal = parseNum(m[1]);
        }
    };

    // Layer 1: Check raw data object
    tryInspectObject(data);
    tryInspectObject(data?.finalAnalysis);

    // Layer 2: Check events if present (events contain direct model outputs before guardManagerResponse)
    if (Array.isArray(data?.events)) {
        for (const ev of data.events) {
            tryInspectObject(ev.output);
            if (typeof ev.output === 'string') tryScanString(ev.output);
            if (intVal !== null && accVal !== null) break;
        }
    }

    // Layer 3: Scan components in Generative UI ManagerResponse
    if (data?.finalAnalysis && typeof data.finalAnalysis === 'object') {
        const fa = data.finalAnalysis;
        if (Array.isArray(fa.components)) {
            for (const comp of fa.components) {
                if (comp.props?.insights && Array.isArray(comp.props.insights)) {
                    for (const ins of comp.props.insights) {
                        tryScanString(typeof ins === 'string' ? ins : ins?.message);
                    }
                }
                if (comp.props?.title && comp.props?.value) {
                    const title = String(comp.props.title).toLowerCase();
                    if (title.includes('intel') && intVal === null) intVal = parseNum(comp.props.value);
                    if (title.includes('accur') && accVal === null) accVal = parseNum(comp.props.value);
                    if (title.includes('speed') && spdVal === null) spdVal = parseNum(comp.props.value);
                }
            }
        }
        if (fa.summary) tryScanString(fa.summary);
    }

    // Layer 4: Scan finalAnalysis as string
    if (typeof data?.finalAnalysis === 'string') {
        tryScanString(data.finalAnalysis);
    }

    return {
        intelligence: intVal,
        accuracy: accVal,
        speed: spdVal !== null ? spdVal : fallbackSpeed
    };
}

export interface ModelErrorRecord {
    errorCount: number;
    lastError: string;
    provider: string;
}
