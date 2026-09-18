import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { AgentConfigurator, getApiKeyForProvider, AgentConfig } from './AgentConfigurator';
import { SettingsModal, AppSettings } from './SettingsModal';

describe('AgentConfigurator & SettingsModal Swarm Agents Tab', () => {
    const mockAgents: AgentConfig[] = [
        { id: '1', role: 'Data Analyst', provider: 'gemini', model: 'gemini-3.5' },
        { id: '2', role: 'Security Specialist', provider: 'groq', model: 'llama-3.3-70b' },
        { id: '3', role: 'Disabled Agent', provider: 'none', model: '' }
    ];

    const mockSettings: AppSettings = {
        geminiApiKey: 'test-gemini-key',
        openRouterApiKey: '',
        groqApiKey: 'test-groq-key',
        mistralApiKey: '',
        qdrantUrl: 'http://localhost:6333',
        qdrantApiKey: 'test-qdrant-key',
        githubToken: '',
        appId: 'test-app',
        agents: mockAgents
    };

    it('getApiKeyForProvider returns correct key and safely handles undefined/partial settings', () => {
        expect(getApiKeyForProvider(mockSettings, 'gemini')).toBe('test-gemini-key');
        expect(getApiKeyForProvider(mockSettings, 'groq')).toBe('test-groq-key');
        expect(getApiKeyForProvider(mockSettings, 'mistral')).toBe('');
        // Safe fallbacks for undefined or empty settings
        expect(getApiKeyForProvider(undefined, 'gemini')).toBe('');
        expect(getApiKeyForProvider({} as any, 'gemini')).toBe('');
    });

    it('renders AgentConfigurator safely even when settings is undefined or empty', () => {
        // Should not throw TypeError: Cannot read properties of undefined
        expect(() => {
            const html = renderToString(
                React.createElement(AgentConfigurator, {
                    agents: mockAgents,
                    onUpdateAgent: () => {},
                    settings: undefined
                })
            );
            expect(html).toContain('Data Analyst');
            expect(html).toContain('Security Specialist');
        }).not.toThrow();
    });

    it('renders SettingsModal Swarm Agents tab without crashing and passes settings', () => {
        expect(() => {
            const html = renderToString(
                React.createElement(SettingsModal, {
                    isOpen: true,
                    onClose: () => {},
                    settings: mockSettings,
                    onUpdateSetting: () => {},
                    onUpdateAgent: () => {},
                    envStatus: {},
                    initialTab: 'swarm'
                })
            );
            expect(html).toContain('Data Analyst');
            expect(html).toContain('Swarm Configuration');
        }).not.toThrow();
    });

    it('displays inline hints and descriptive placeholders when provider API key is not configured', () => {
        const settingsMissingGroq: AppSettings = {
            ...mockSettings,
            groqApiKey: ''
        };
        const html = renderToString(
            React.createElement(AgentConfigurator, {
                agents: mockAgents,
                onUpdateAgent: () => {},
                settings: settingsMissingGroq
            })
        );
        // Expect an inline indicator or hint that groq key is missing
        expect(html).toContain('API Key required');
        expect(html).toContain('Model ID (API Key required to load list)');
    });

    it('renders the Filter Healthy Only dropdown control', () => {
        const html = renderToString(
            React.createElement(AgentConfigurator, {
                agents: mockAgents,
                onUpdateAgent: () => {},
                settings: mockSettings
            })
        );
        expect(html).toContain('Filter Healthy Only (Near Real-Time)');
    });

    it('providerService health checking integrates with circuit breaker and 5-10m TTL cache', async () => {
        const { checkProviderModelsHealth, getModelHealth, getModelCircuitState } = await import('../services/providerService');
        const { globalModelHealthChecker } = await import('../swarm/health');

        const testModels = [
            { id: 'sim-model-1', name: 'Simulated Model 1', free: true },
            { id: 'sim-model-2', name: 'Simulated Model 2', free: true }
        ];

        const results = await checkProviderModelsHealth('simulated', testModels);
        expect(results['simulated:sim-model-1']).toBeDefined();
        expect(results['simulated:sim-model-1'].healthy).toBe(true);
        expect(results['simulated:sim-model-1'].circuitState).toBe('CLOSED');

        // Cached lookup
        const cached = getModelHealth('simulated', 'sim-model-1');
        expect(cached).toBeDefined();
        expect(cached?.healthy).toBe(true);

        const state = getModelCircuitState('simulated', 'sim-model-1');
        expect(state).toBe('CLOSED');

        // Verify circuit breaker tripping reflects in service
        globalModelHealthChecker.circuitBreaker.recordFailure('simulated', 'sim-model-1');
        globalModelHealthChecker.circuitBreaker.recordFailure('simulated', 'sim-model-1');
        globalModelHealthChecker.circuitBreaker.recordFailure('simulated', 'sim-model-1');

        expect(getModelCircuitState('simulated', 'sim-model-1')).toBe('OPEN');

        // Cleanup
        globalModelHealthChecker.circuitBreaker.resetAll();
        globalModelHealthChecker.cache.clear();
    });
});
