import { globalFeedbackEngine } from '../../feedback.ts';
import { hydrateFromOutcomeRecords } from '../../feedback/probabilityCalibration.ts';

export const FORBIDDEN_CLIENT_SECRET_KEYS = [
    'geminiApiKey',
    'openRouterApiKey',
    'groqApiKey',
    'mistralApiKey',
    'cloudflareApiToken',
    'nvidiaApiKey',
    'githubToken',
    'qdrantUrl',
    'qdrantApiKey',
    'apiKey'
] as const;

export function sanitizeAgent(agent: any): any {
    if (!agent || typeof agent !== 'object') return agent;
    const forbidden = new Set<string>(FORBIDDEN_CLIENT_SECRET_KEYS);
    const cleanAgent: Record<string, any> = {};
    for (const [k, v] of Object.entries(agent)) {
        if (!forbidden.has(k)) {
            cleanAgent[k] = v;
        }
    }
    return cleanAgent;
}

export function resolveEnvironment(c?: any): Record<string, any> {
    return Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c?.env || {}) as Record<string, any>;
}

export function buildEdgeSettings(env: Record<string, any>): Record<string, any> {
    return {
        geminiApiKey: env.GEMINI_API_KEY,
        groqApiKey: env.GROQ_API_KEY,
        openRouterApiKey: env.OPENROUTER_API_KEY,
        mistralApiKey: env.MISTRAL_API_KEY,
        cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN,
        cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID,
        nvidiaApiKey: env.NVIDIA_API_KEY,
        githubToken: env.GITHUB_TOKEN,
        qdrantUrl: env.QDRANT_URL,
        qdrantApiKey: env.QDRANT_API_KEY
    };
}

export function resolveAppIds(c: any, defaultSettings: Record<string, any> = {}): { callerAppId?: string; originApp: string } {
    const callerAppId = (c as any).get?.('callerAppId') as string | undefined;
    const serverDefaultAppId = defaultSettings.appId || 'perfect-swarm';
    const originApp = callerAppId || serverDefaultAppId;
    return { callerAppId, originApp };
}

export function hydrateAppOutcomes(originApp: string, limit: number = 500): void {
    hydrateFromOutcomeRecords(
        originApp,
        globalFeedbackEngine.getKnowledgeRepository().queryOutcomes({ appId: originApp, limit }) as any
    );
}

export function buildSafeFallback(result: any, serializationErr: any): Record<string, any> {
    return {
        finalAnalysis: result?.finalAnalysis || 'Analysis completed successfully (fallback serialization)',
        events: Array.isArray(result?.events) ? result.events.slice(-10) : [],
        metrics: result?.metrics || null,
        serializationWarning: serializationErr?.message || String(serializationErr)
    };
}

export function serializeSwarmResult(c: any, result: any): Response {
    try {
        if (result.workflowId) {
            result.workflowId = String(result.workflowId);
        } else {
            delete result.workflowId;
        }
        // PS1: partial runs return 200 with status:'partial' (and keep workflowId); degraded = seat ids with no backup left.
        result.status = result.status || 'complete';
        result.degraded = Array.isArray(result.degraded) ? result.degraded : [];

        const seen = new WeakSet();
        const safeReplacer = (_key: string, value: any) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            return value;
        };

        const serialized = JSON.stringify(result, safeReplacer);
        return c.newResponse(serialized, 200, {
            'Content-Type': 'application/json; charset=utf-8'
        });
    } catch (serializationErr: any) {
        console.error('[SwarmServer Analyze Serialization Error]:', serializationErr);
        const safeFallback = buildSafeFallback(result, serializationErr);
        return c.json(safeFallback, 200);
    }
}

export function handleServerError(context: string, err: any, c: any) {
    console.error(`[SwarmServer ${context} Error]:`, err);
    return c.json({ error: err?.message || 'Internal Server Error' }, 500);
}

export function sanitizeClientSettings(
    rawSettings: any,
    edgeSettings: Record<string, any> = {},
    defaultSettings: Record<string, any> = {}
): Record<string, any> {
    const forbidden = new Set<string>(FORBIDDEN_CLIENT_SECRET_KEYS);
    const cleanSettings: Record<string, any> = {};

    if (rawSettings && typeof rawSettings === 'object') {
        for (const [key, value] of Object.entries(rawSettings)) {
            if (!forbidden.has(key) && value !== "" && value !== null && value !== undefined) {
                cleanSettings[key] = value;
            }
        }
    }

    if (Array.isArray(cleanSettings.agents)) {
        cleanSettings.agents = cleanSettings.agents.map(sanitizeAgent);
    }
    if (cleanSettings.critic && typeof cleanSettings.critic === 'object') {
        cleanSettings.critic = sanitizeAgent(cleanSettings.critic);
    }

    const merged = {
        ...defaultSettings,
        ...cleanSettings,
        ...edgeSettings
    };

    for (const key of FORBIDDEN_CLIENT_SECRET_KEYS) {
        if (edgeSettings[key] !== undefined && edgeSettings[key] !== '') {
            merged[key] = edgeSettings[key];
        } else {
            delete merged[key];
        }
    }

    return merged;
}
