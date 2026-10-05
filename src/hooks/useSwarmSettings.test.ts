import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    DEFAULT_SWARM_SETTINGS,
    sanitizeSettingsForStorage,
    cleanSavedSettings
} from './useSwarmSettings.ts';

describe('useSwarmSettings - Client Key Decontamination & Ephemeral Defaults', () => {
    it('initializes new settings with ephemeralKeys: true by default', () => {
        expect(DEFAULT_SWARM_SETTINGS.ephemeralKeys).toBe(true);
        expect(DEFAULT_SWARM_SETTINGS.geminiApiKey).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.openRouterApiKey).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.groqApiKey).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.mistralApiKey).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.qdrantApiKey).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.qdrantUrl).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.githubToken).toBe('');
        expect(DEFAULT_SWARM_SETTINGS.appId).toBe('perfect-swarm');
    });

    it('strips saved provider keys from swarm_settings on load and produces cleaned object', () => {
        const taintedLegacySettings = {
            geminiApiKey: 'legacy-gemini-key',
            openRouterApiKey: 'legacy-openrouter-key',
            groqApiKey: 'legacy-groq-key',
            mistralApiKey: 'legacy-mistral-key',
            githubToken: 'legacy-gh-token',
            qdrantUrl: 'https://legacy-cluster.qdrant.tech',
            qdrantApiKey: 'legacy-qdrant-key',
            appId: 'custom-tenant-app',
            disableFallback: true,
            agents: [
                {
                    id: 'manager',
                    role: 'Manager Node',
                    provider: 'gemini',
                    model: 'gemini-3.5-flash',
                    apiKey: 'tainted-agent-key',
                    geminiApiKey: 'tainted-agent-gemini'
                }
            ]
        };

        const result = cleanSavedSettings(JSON.stringify(taintedLegacySettings));
        expect(result).not.toBeNull();
        const cleaned = result!.cleanedSettings;

        // In-memory state must be stripped of secrets while preserving appId and config
        expect(cleaned.geminiApiKey).toBe('');
        expect(cleaned.openRouterApiKey).toBe('');
        expect(cleaned.groqApiKey).toBe('');
        expect(cleaned.mistralApiKey).toBe('');
        expect(cleaned.qdrantApiKey).toBe('');
        expect(cleaned.qdrantUrl).toBe('');
        expect(cleaned.githubToken).toBe('');
        expect(cleaned.appId).toBe('custom-tenant-app');
        expect(cleaned.ephemeralKeys).toBe(true);
        expect((cleaned.agents as any)[0].apiKey).toBeUndefined();
        expect((cleaned.agents as any)[0].geminiApiKey).toBeUndefined();
    });

    it('ensures app token is extracted from swarm_settings and never stored in swarm_settings', () => {
        const taintedWithAppToken = {
            appId: 'clean-app',
            appToken: 'legacy-bearer-token',
            agents: []
        };

        const result = cleanSavedSettings(JSON.stringify(taintedWithAppToken));
        expect(result).not.toBeNull();
        expect(result!.legacyAppToken).toBe('legacy-bearer-token');

        // swarm_settings cleaned object must not contain appToken
        const cleaned = result!.cleanedSettings;
        expect((cleaned as any).appToken).toBeUndefined();
        expect((cleaned as any).app_token).toBeUndefined();

        // sanitizeSettingsForStorage must also ensure appToken is deleted
        const sanitized = sanitizeSettingsForStorage({
            ...cleaned,
            appToken: 'leak-token'
        } as any);
        expect((sanitized as any).appToken).toBeUndefined();
    });
});
