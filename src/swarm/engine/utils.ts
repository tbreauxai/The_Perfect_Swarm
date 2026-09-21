import { GoogleGenAI } from "@google/genai";
import type { Provider, SwarmEngineSettings } from "../types.ts";
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
 * Validates provider-specific key conventions and throws descriptive errors.
 */
export function validateProviderKey(provider: Provider, key: string, role: string = 'Agent'): void {
    if (provider === 'simulated' || provider === 'mock' || provider === 'custom-mock') {
        return;
    }

    if (!key) {
        throw new Error(`Missing API Key for ${role} provider (${provider}). Please configure it in settings.`);
    }

    if (provider === 'openrouter' && !key.startsWith('sk-or-v1-')) {
        throw new Error(`Invalid OpenRouter key format for ${role}. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a valid OpenRouter key from openrouter.ai/keys.`);
    }
}

const safeEnv = typeof process !== 'undefined' ? process.env : {} as Record<string, string | undefined>;

/**
 * Resolves credentials and SDK clients for supported LLM providers from settings or process.env.
 */
export function resolveProvider(
    provider: string,
    settings: SwarmEngineSettings,
    defaultAi?: GoogleGenAI
): ProviderResolution {
    let key = '';
    let client: GoogleGenAI | undefined = undefined;

    switch (provider) {
        case 'gemini': {
            key = sanitizeApiKey(settings?.geminiApiKey || safeEnv.GEMINI_API_KEY);
            client = key
                ? new GoogleGenAI({ apiKey: key })
                : defaultAi;
            break;
        }
        case 'groq': {
            key = sanitizeApiKey(settings?.groqApiKey || safeEnv.GROQ_API_KEY);
            break;
        }
        case 'openrouter': {
            key = sanitizeApiKey(settings?.openRouterApiKey || safeEnv.OPENROUTER_API_KEY);
            break;
        }
        case 'mistral': {
            key = sanitizeApiKey(settings?.mistralApiKey || safeEnv.MISTRAL_API_KEY);
            break;
        }
        case 'github': {
            key = sanitizeApiKey(settings?.githubToken || safeEnv.GITHUB_TOKEN);
            break;
        }
        default: {
            const dynamicKey = settings?.[`${provider}ApiKey`] || settings?.[provider] || safeEnv[`${provider.toUpperCase()}_API_KEY`];
            key = sanitizeApiKey(dynamicKey);
            break;
        }
    }

    return { key, client };
}
