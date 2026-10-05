import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SettingsModal, AppSettings } from './SettingsModal';

describe('SettingsModal - Provider Key Input Removal & Server Status Badges', () => {
    const mockSettings: AppSettings = {
        appId: 'perfect-swarm',
        ephemeralKeys: true,
        agents: [
            { id: '1', role: 'Data Analyst', provider: 'gemini', model: 'gemini-3.5' }
        ]
    };

    const mockEnvStatus = {
        hasGeminiKey: true,
        hasGroqKey: true,
        hasOpenRouterKey: false,
        hasMistralKey: true,
        hasQdrantUrl: true,
        hasQdrantKey: true
    };

    it('renders server secrets status badges and does not render provider key inputs', () => {
        const html = renderToString(
            React.createElement(SettingsModal, {
                isOpen: true,
                onClose: () => {},
                settings: mockSettings,
                onUpdateSetting: () => {},
                onUpdateAgent: () => {},
                envStatus: mockEnvStatus,
                initialTab: 'keys'
            })
        );

        // Status badges should be present
        expect(html).toContain('Server Secrets Status');
        expect(html).toContain('Gemini');
        expect(html).toContain('Groq');
        expect(html).toContain('OpenRouter');
        expect(html).toContain('Mistral');
        expect(html).toContain('Qdrant Vector DB');
        expect(html).toContain('Loaded');

        // Provider key inputs and password fields for providers must NOT be rendered
        expect(html).not.toContain('placeholder="AIza..."');
        expect(html).not.toContain('placeholder="sk-or-v1-..."');
        expect(html).not.toContain('placeholder="gsk_..."');
        expect(html).not.toContain('placeholder="Mistral Key..."');
        expect(html).not.toContain('placeholder="https://your-cluster.qdrant.tech"');
        expect(html).not.toContain('placeholder="API Key"');

        // App namespace and App token inputs MUST be rendered
        expect(html).toContain('App Namespace (appId)');
        expect(html).toContain('App token');
        expect(html).toContain('Bearer token for this dashboard');
    });

    it('renders Swarm Agents tab without crashing', () => {
        const html = renderToString(
            React.createElement(SettingsModal, {
                isOpen: true,
                onClose: () => {},
                settings: mockSettings,
                onUpdateSetting: () => {},
                onUpdateAgent: () => {},
                envStatus: mockEnvStatus,
                initialTab: 'swarm'
            })
        );

        expect(html).toContain('Data Analyst');
        expect(html).toContain('Disable Provider Fallback');
        expect(html).toContain('Override Fast Track');
    });
});
