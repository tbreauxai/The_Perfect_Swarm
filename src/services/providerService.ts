/**
 * Client-side provider service for querying available models.
 */

import {
    globalModelHealthChecker,
    TwoTierModelHealthChecker,
    type ModelHealthStatus,
    type HealthCheckOptions,
    type ModelTarget,
    type CircuitState
} from '../swarm/health.ts';

export interface ModelOption {
    id: string;
    name: string;
    context_length?: number;
    free?: boolean;
    health?: ModelHealthStatus;
}

export async function fetchAvailableModels(provider: string, apiKey?: string): Promise<ModelOption[]> {
    try {
        switch (provider) {
            case 'simulated': {
                return [
                    {
                        id: 'simulated-swarm-v1',
                        name: 'Simulated Swarm Model (Zero-API-Key)',
                        free: true
                    }
                ];
            }
            case 'openrouter':
            case 'groq':
            case 'gemini':
            case 'mistral':
            case 'github': {
                const headers: Record<string, string> = {};
                if (apiKey) {
                    headers['x-provider-key'] = apiKey;
                }
                const res = await fetch(`/api/swarm/models?provider=${provider}`, { headers });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `Failed to fetch ${provider} models via backend proxy`);
                }
                return res.json();
            }
            default:
                return [];
        }
    } catch (error) {
        console.error(`Error fetching models for ${provider}:`, error);
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
    
    // If no API key is present on the frontend, assume models are healthy so the UI allows selection
    if (!apiKey && provider !== 'simulated' && provider !== 'openrouter') {
        const mockHealth: Record<string, ModelHealthStatus> = {};
        for (const m of models) {
            mockHealth[`${provider.toLowerCase().trim()}:${m.id.trim()}`] = {
                provider,
                modelId: m.id,
                latencyMs: 0,
                lastChecked: Date.now(),
                healthy: true,
                circuitState: 'CLOSED',
                tier1Success: true,
                tier2Success: true,
                expiresAt: Date.now() + 600000 // 10 minutes
            };
        }
        return mockHealth;
    }

    const targets: ModelTarget[] = models.map(m => ({
        provider,
        modelId: m.id,
        apiKey
    }));
    const map = await globalModelHealthChecker.checkModelsInParallel(targets, options);
    const result: Record<string, ModelHealthStatus> = {};
    for (const [key, status] of map.entries()) {
        result[key] = status;
    }
    return result;
}

export function getModelHealth(provider: string, modelId: string): ModelHealthStatus | undefined {
    return globalModelHealthChecker.cache.get(provider, modelId);
}

export function getModelCircuitState(provider: string, modelId: string): CircuitState {
    return globalModelHealthChecker.circuitBreaker.getState(provider, modelId);
}

