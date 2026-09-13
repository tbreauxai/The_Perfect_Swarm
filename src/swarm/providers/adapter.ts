import type { ProviderAdapter, ProviderCallOptions } from '../types.ts';

export type { ProviderAdapter, ProviderCallOptions };

/**
 * Strips redundant prefixes ('Bearer ', 'Token '), backticks, quotes, and whitespace from API keys.
 */
export function cleanToken(key: string | undefined | null): string {
    if (!key || typeof key !== 'string') return '';
    return key
        .replace(/^(?:Bearer\s*:?|Token\s*:?)+/i, '')
        .replace(/["'`<>]/g, '')
        .trim();
}
