/**
 * Fetches available models from supported LLM providers with edge-safe fetch calls.
 */
export async function fetchProviderModels(provider: string, clientKey?: string, env: Record<string, any> = {}): Promise<any[]> {
    switch (provider.toLowerCase()) {
        case 'simulated': {
            return [
                { id: 'simulated-swarm-v1', name: 'Simulated Swarm Model', free: true }
            ];
        }
        case 'openrouter': {
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
            const apiKey = clientKey || env.GROQ_API_KEY;
            if (!apiKey) return [];
            const res = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!res.ok) throw new Error('Failed to fetch Groq models');
            const data = await res.json();
            return (data.data || []).map((m: any) => ({
                id: m.id,
                name: m.id,
                free: true
            }));
        }
        case 'gemini': {
            const apiKey = clientKey || env.GEMINI_API_KEY;
            if (!apiKey) return [];
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            if (!res.ok) throw new Error('Failed to fetch Gemini models');
            const data = await res.json();
            const models = (data.models || [])
                .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                .map((m: any) => ({
                    id: (m.name || '').replace('models/', ''),
                    name: m.displayName || m.name,
                    free: true
                }));
            return models;
        }
        case 'mistral': {
            const apiKey = clientKey || env.MISTRAL_API_KEY;
            if (!apiKey) return [];
            const res = await fetch('https://api.mistral.ai/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!res.ok) throw new Error('Failed to fetch Mistral models');
            const data = await res.json();
            return (data.data || []).map((m: any) => ({
                id: m.id,
                name: m.id,
                free: true
            }));
        }
        case 'github': {
            const apiKey = clientKey || env.GITHUB_TOKEN;
            if (!apiKey) return [];
            const res = await fetch('https://models.inference.ai.azure.com/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!res.ok) throw new Error('Failed to fetch GitHub models');
            const data = await res.json();
            const list = Array.isArray(data) ? data : (data.data || []);
            return list.map((m: any) => ({
                id: m.name,
                name: m.friendly_name || m.name,
                free: true
            }));
        }
        default:
            return [];
    }
}
