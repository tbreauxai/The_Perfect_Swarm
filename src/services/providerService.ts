/**
 * Client-side provider service for querying available models.
 */

export interface ModelOption {
    id: string;
    name: string;
    context_length?: number;
    free?: boolean;
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
                if (!apiKey) throw new Error('API key required for Groq models');
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
                if (!apiKey) throw new Error('API key required for Gemini models');
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
                if (!apiKey) throw new Error('API key required for Mistral models');
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
                if (!apiKey) throw new Error('API key required for GitHub models');
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
