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
            case 'openrouter': {
                // OpenRouter public models endpoint (no key required)
                const res = await fetch('https://openrouter.ai/api/v1/models');
                if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
                const data = await res.json();
                return (data.data || []).map((m: any) => ({
                    id: m.id,
                    name: m.name || m.id,
                    context_length: m.context_length,
                    free: m.pricing?.prompt === "0" && m.pricing?.completion === "0"
                }));
            }
            case 'groq': {
                if (!apiKey) {
                    const res = await fetch(`/api/swarm/models?provider=${provider}`);
                    if (!res.ok) throw new Error('Failed to fetch Groq models via backend proxy');
                    return res.json();
                }
                const res = await fetch('https://api.groq.com/openai/v1/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!res.ok) throw new Error('Failed to fetch Groq models');
                const data = await res.json();
                return (data.data || []).map((m: any) => ({
                    id: m.id,
                    name: m.id,
                    free: true // All Groq beta models are currently free
                }));
            }
            case 'gemini': {
                if (!apiKey) {
                    const res = await fetch(`/api/swarm/models?provider=${provider}`);
                    if (!res.ok) throw new Error('Failed to fetch Gemini models via backend proxy');
                    return res.json();
                }
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                if (!res.ok) throw new Error('Failed to fetch Gemini models');
                const data = await res.json();
                // Filter for generateContent supported models
                return (data.models || [])
                    .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                    .map((m: any) => ({
                        id: (m.name || '').replace('models/', ''),
                        name: m.displayName || m.name,
                        free: true // Assumed free tier if key works
                    }));
            }
            case 'mistral': {
                if (!apiKey) {
                    const res = await fetch(`/api/swarm/models?provider=${provider}`);
                    if (!res.ok) throw new Error('Failed to fetch Mistral models via backend proxy');
                    return res.json();
                }
                const res = await fetch('https://api.mistral.ai/v1/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!res.ok) throw new Error('Failed to fetch Mistral models');
                const data = await res.json();
                return (data.data || []).map((m: any) => ({
                    id: m.id,
                    name: m.id,
                    free: typeof m.id === 'string' && (m.id.includes('free') || m.id.includes('open'))
                }));
            }
            case 'github': {
                if (!apiKey) {
                    const res = await fetch(`/api/swarm/models?provider=${provider}`);
                    if (!res.ok) throw new Error('Failed to fetch GitHub models via backend proxy');
                    return res.json();
                }
                const res = await fetch('https://models.inference.ai.azure.com/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!res.ok) throw new Error('Failed to fetch GitHub models');
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data.data || []);
                return list.map((m: any) => ({
                    id: m.name,
                    name: m.friendly_name || m.name,
                    free: true // GitHub models in beta are free
                }));
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
                isHealthy: true,
                circuitState: 'CLOSED'
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

