/**
 * Client-side provider service for querying available models.
 */

import { authHeaders } from './appAuthHeaders';
import { parseHttpError, HttpError } from './httpError';
import {
    globalModelHealthChecker,
    TwoTierModelHealthChecker,
    type ModelHealthStatus,
    type HealthCheckOptions,
    type ModelTarget,
    type CircuitState
} from '../swarm/health.ts';

export { globalModelHealthChecker };

export interface ModelOption {
    id: string;
    name: string;
    context_length?: number;
    free?: boolean;
    health?: ModelHealthStatus;
}

export const QUARANTINED_MODELS_STORAGE_KEY = 'swarm_quarantined_models_v1';
export const MODEL_404_STRIKES_STORAGE_KEY = 'swarm_model_404_strikes_v1';

export function getQuarantinedModels(): string[] {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(QUARANTINED_MODELS_STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        }
    } catch {}
    return [];
}

export function isModelQuarantined(provider: string, modelId: string): boolean {
    const key = `${provider.toLowerCase().trim()}:${modelId.trim()}`;
    return getQuarantinedModels().includes(key);
}

export function recordModel404(provider: string, modelId: string): boolean {
    const key = `${provider.toLowerCase().trim()}:${modelId.trim()}`;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(MODEL_404_STRIKES_STORAGE_KEY);
            const strikes: Record<string, number> = raw ? JSON.parse(raw) : {};
            strikes[key] = (strikes[key] || 0) + 1;
            localStorage.setItem(MODEL_404_STRIKES_STORAGE_KEY, JSON.stringify(strikes));

            if (strikes[key] >= 3) {
                const quarantined = getQuarantinedModels();
                if (!quarantined.includes(key)) {
                    quarantined.push(key);
                    localStorage.setItem(QUARANTINED_MODELS_STORAGE_KEY, JSON.stringify(quarantined));
                }
                return true; // model quarantined
            }
        }
    } catch {}
    return false;
}

export function clearModel404Strikes(provider: string, modelId: string): void {
    const key = `${provider.toLowerCase().trim()}:${modelId.trim()}`;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(MODEL_404_STRIKES_STORAGE_KEY);
            if (raw) {
                const strikes: Record<string, number> = JSON.parse(raw);
                delete strikes[key];
                localStorage.setItem(MODEL_404_STRIKES_STORAGE_KEY, JSON.stringify(strikes));
            }
        }
    } catch {}
}

export function clearAllQuarantinedModels(): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(QUARANTINED_MODELS_STORAGE_KEY);
            localStorage.removeItem(MODEL_404_STRIKES_STORAGE_KEY);
        }
    } catch {}
}

export async function fetchAvailableModels(provider: string, apiKey?: string): Promise<ModelOption[]> {
    try {
        switch (provider) {
            case 'simulated': {
                const models = [
                    {
                        id: 'simulated-swarm-v1',
                        name: 'Simulated Swarm Model (Zero-API-Key)',
                        free: true
                    }
                ];
                return models.filter(m => !isModelQuarantined(provider, m.id));
            }
            case 'openrouter':
            case 'groq':
            case 'gemini':
            case 'mistral':
            case 'github': {
                const headers = authHeaders();
                const res = await fetch(`/api/swarm/models?provider=${provider}`, { headers });
                if (!res.ok) {
                    const parsed = await parseHttpError(res);
                    throw new HttpError(parsed);
                }
                const rawModels: ModelOption[] = await res.json();
                return rawModels.filter(m => !isModelQuarantined(provider, m.id));
            }
            default:
                return [];
        }
    } catch (error) {
        throw error;
    }
}

/**
 * Executes parallel async health checks for provider models, cached for 5-10m with circuit breaking.
 */
export async function checkProviderModelsHealth(
    provider: string,
    models: ModelOption[],
    apiKey?: string,
    options?: HealthCheckOptions
): Promise<Record<string, ModelHealthStatus>> {
    if (!models || models.length === 0) return {};
    
    // For legacy callers explicitly passing an empty string apiKey
    if (apiKey === '' && provider !== 'simulated' && provider !== 'openrouter') {
        const mockHealth: Record<string, ModelHealthStatus> = {};
        for (const m of models) {
            mockHealth[`${provider.toLowerCase().trim()}:${m.id.trim()}`] = {
                provider,
                modelId: m.id,
                latencyMs: null,
                lastChecked: Date.now(),
                healthy: false,
                circuitState: 'UNCHECKED',
                tier1Success: false,
                tier2Success: false,
                note: 'No API key — not checked',
                expiresAt: Date.now() + 600000 // 10 minutes
            };
        }
        return mockHealth;
    }

    const targets: ModelTarget[] = models.map(m => ({
        provider,
        modelId: m.id
    }));
    const map = await globalModelHealthChecker.checkModelsInParallel(targets, options);
    return Object.fromEntries(map);
}

export function getModelHealth(provider: string, modelId: string): ModelHealthStatus | undefined {
    return globalModelHealthChecker.cache.get(provider, modelId);
}

export function getModelCircuitState(provider: string, modelId: string): CircuitState {
    return globalModelHealthChecker.circuitBreaker.getState(provider, modelId);
}

