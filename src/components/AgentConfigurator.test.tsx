// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { AgentConfigurator, getApiKeyForProvider, AgentConfig } from './AgentConfigurator';
import { SettingsModal, AppSettings } from './SettingsModal';

describe('AgentConfigurator & SettingsModal Swarm Agents Tab', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });
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

    it('models load; 401 falls back to text input and app token hint shows + refetches on token change', async () => {
        // The issue specifies: "mock models fetch -> 401, assert text-input fallback... change the app token in the store... assert the list loads without remount".
        const originalFetch = globalThis.fetch;
        try {
            let fetchCallCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(async (url: any) => {
                // Only count model-list fetches; the parallel health check also uses fetch
                if (String(url).includes('/api/swarm/models')) fetchCallCount++;
                return {
                    ok: false,
                    status: 401,
                    json: async () => ({ error: 'Unauthorized' }),
                    headers: new Headers()
                };
            });

            // 1. Initial Render with key, triggering 401
            render(
                <AgentConfigurator 
                    agents={[{ id: '1', role: 'Tester', provider: 'gemini', model: 'gemini-3.5' }]}
                    onUpdateAgent={() => {}}
                    settings={{ ...mockSettings, geminiApiKey: 'test-key-trigger-401' }}
                />
            );

            // Wait for effect to fetch and set state
            await waitFor(() => {
                expect(screen.getByText('Add an app token to load the model list')).toBeDefined();
            });

            // Re-mock to return success
            globalThis.fetch = vi.fn().mockImplementation(async (url: any) => {
                if (String(url).includes('/api/swarm/models')) fetchCallCount++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ([{ id: 'gemini-new', name: 'Gemini New', free: true }]),
                    headers: new Headers()
                };
            });

            const countBeforeEvent = fetchCallCount;

            // Dispatch event to simulate token change
            await act(async () => {
                window.dispatchEvent(new Event('swarm_token_changed'));
            });

            // Wait for refetch logic
            await waitFor(() => {
                expect(fetchCallCount).toBe(countBeforeEvent + 1);
            });
            
            // Wait a little bit to verify no further loops
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(fetchCallCount).toBe(countBeforeEvent + 1);

            // The requested-set must have been cleared by the token-change handler:
            // a stale set would have suppressed the refetch above as a duplicate.
            // And the refetched provider list renders the new models.
            await waitFor(() => {
                expect(screen.getByText(/Gemini New/)).toBeDefined();
            });

        } finally {
            globalThis.fetch = originalFetch;
        }
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

    it('returns UNCHECKED with null latencyMs when apiKey is missing for key-requiring providers', async () => {
        const { checkProviderModelsHealth } = await import('../services/providerService');
        const testModels = [
            { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', free: true }
        ];

        const results = await checkProviderModelsHealth('gemini', testModels, '');
        expect(results['gemini:gemini-3.5-flash']).toBeDefined();
        expect(results['gemini:gemini-3.5-flash'].healthy).toBe(false);
        expect(results['gemini:gemini-3.5-flash'].circuitState).toBe('UNCHECKED');
        expect(results['gemini:gemini-3.5-flash'].latencyMs).toBeNull();
        expect(results['gemini:gemini-3.5-flash'].note).toBe('No API key — not checked');
    });
});
