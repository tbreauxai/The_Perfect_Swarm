import { describe, it, expect } from 'vitest';
import { validateProviderKey } from './utils.ts';
import type { Provider } from '../types.ts';

describe('validateProviderKey', () => {
    it('should return without throwing for simulated/mock providers even if key is empty', () => {
        expect(() => validateProviderKey('simulated', '')).not.toThrow();
        expect(() => validateProviderKey('mock', '')).not.toThrow();
        expect(() => validateProviderKey('custom-mock', '')).not.toThrow();
    });

    it('should throw an error if the key is missing for non-mock providers', () => {
        expect(() => validateProviderKey('gemini', ''))
            .toThrow('Missing API Key for Agent provider (gemini). Please configure it in settings.');

        // Test with custom role
        expect(() => validateProviderKey('openai', '', 'Coordinator'))
            .toThrow('Missing API Key for Coordinator provider (openai). Please configure it in settings.');
    });

    it('should throw an error for openrouter if the key does not start with sk-or-v1-', () => {
        expect(() => validateProviderKey('openrouter', 'sk-invalid-key'))
            .toThrow("Invalid OpenRouter key format for Agent. OpenRouter keys must begin with 'sk-or-v1-'. If you entered an OpenAI key (sk-...), please obtain a valid OpenRouter key from openrouter.ai/keys.");
    });

    it('should succeed without throwing for valid openrouter key', () => {
        expect(() => validateProviderKey('openrouter', 'sk-or-v1-1234567890abcdef')).not.toThrow();
    });

    it('should succeed without throwing for other providers with valid keys', () => {
        expect(() => validateProviderKey('gemini', 'some-valid-key')).not.toThrow();
        expect(() => validateProviderKey('groq', 'gsk_12345')).not.toThrow();
    });
});
