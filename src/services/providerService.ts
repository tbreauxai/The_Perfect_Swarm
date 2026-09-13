import { GoogleGenAI } from '@google/genai';
import type { Provider } from '../../swarm.ts';

export interface ProviderResolution {
    key: string;
    client?: GoogleGenAI;
}

/**
 * Sanitizes raw API keys by stripping 'Bearer ', 'Token ', redundant whitespace, quotes, and backticks.
 */
export function sanitizeApiKey(k: string | undefined | null): string {
    if (!k || typeof k !== 'string') return '';
    return k
        .replace(/^(?:Bearer\s*:?|Token\s*:?)+/i, '')
        .replace(/["'`<>]/g, '')
        .trim();
}

/**
 * Validates provider-specific key conventions and throws human-friendly descriptive errors.
 */
export function validateProviderKey(provider: Provider, key: string, role: string = 'Agent'): void {
    if (!key) {
        throw new Error(`Missing API Key for ${role} provider (${provider}). Please configure it in settings.`);
    }

    if (provider === 'openrouter' && !key.startsWith('sk-or-v1-')) {
        throw new Error(`Invalid OpenRouter key format for ${role}. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a valid OpenRouter key from openrouter.ai/keys.`);
    }
}

/**
 * Resolves credentials and SDK clients for supported LLM providers.
 */
export function resolveProvider(
    provider: string,
    settings: any,
    defaultAi?: GoogleGenAI
): ProviderResolution {
    let key = '';
    let client: GoogleGenAI | undefined = undefined;

    switch (provider) {
        case 'gemini': {
            key = sanitizeApiKey(settings?.geminiApiKey || process.env.GEMINI_API_KEY);
            client = key
                ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
                : defaultAi;
            break;
        }
        case 'groq': {
            key = sanitizeApiKey(settings?.groqApiKey || process.env.GROQ_API_KEY);
            break;
        }
        case 'openrouter': {
            key = sanitizeApiKey(settings?.openRouterApiKey || process.env.OPENROUTER_API_KEY);
            break;
        }
        case 'mistral': {
            key = sanitizeApiKey(settings?.mistralApiKey || process.env.MISTRAL_API_KEY);
            break;
        }
        case 'github': {
            key = sanitizeApiKey(settings?.githubToken || process.env.GITHUB_TOKEN);
            break;
        }
        default: {
            break;
        }
    }

    return { key, client };
}
