import React, { useState, useEffect } from 'react';
import { fetchAvailableModels, ModelOption } from '../services/providerService.ts';
import type { AppSettings } from './SettingsModal.tsx';

export interface AgentConfig {
    id: string;
    role: string;
    provider: string;
    model: string;
}

export interface AgentConfiguratorProps {
    agents: AgentConfig[];
    onUpdateAgent: (id: string, field: string, value: string) => void;
    settings?: AppSettings;
}

export const getApiKeyForProvider = (settings?: Partial<AppSettings>, provider?: string): string => {
    if (!settings || !provider) return '';
    switch (provider) {
        case 'gemini': return settings.geminiApiKey || '';
        case 'groq': return settings.groqApiKey || '';
        case 'mistral': return settings.mistralApiKey || '';
        case 'openrouter': return settings.openRouterApiKey || '';
        case 'github': return settings.githubToken || '';
        default: return '';
    }
};

export const AgentConfigurator: React.FC<AgentConfiguratorProps> = ({
    agents = [],
    onUpdateAgent,
    settings = {} as AppSettings
}) => {
    const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelOption[]>>({});
    const [loadingProviders, setLoadingProviders] = useState<Record<string, boolean>>({});

    useEffect(() => {
        const uniqueProviders = Array.from(new Set<string>((agents || []).map(a => a.provider).filter(p => p !== 'none')));
        
        uniqueProviders.forEach(provider => {
            if (!modelsByProvider[provider] && !loadingProviders[provider]) {
                const apiKey = getApiKeyForProvider(settings, provider);
                if (provider === 'openrouter' || apiKey) {
                    setLoadingProviders(prev => ({ ...prev, [provider]: true }));
                    fetchAvailableModels(provider, apiKey)
                        .then(models => {
                            setModelsByProvider(prev => ({ ...prev, [provider]: models }));
                            setLoadingProviders(prev => ({ ...prev, [provider]: false }));
                        })
                        .catch(err => {
                            console.error(`Failed to load models for ${provider}`, err);
                            setLoadingProviders(prev => ({ ...prev, [provider]: false }));
                        });
                }
            }
        });
    }, [agents, settings, modelsByProvider, loadingProviders]);

    return (
        <div className="space-y-4">
            {agents?.map(agent => {
                const providerModels = modelsByProvider[agent.provider] || [];
                const isLoading = loadingProviders[agent.provider];
                const freeModels = providerModels.filter(m => m.free);
                const paidModels = providerModels.filter(m => !m.free);
                const apiKey = getApiKeyForProvider(settings, agent.provider);
                const isKeyRequired = agent.provider !== 'none' && agent.provider !== 'openrouter' && agent.provider !== 'simulated' && !apiKey;

                return (
                    <div key={agent.id} className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-2">
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-sm font-semibold text-neutral-900">{agent.role}</label>
                            {isKeyRequired && (
                                <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 font-medium">
                                    API Key required
                                </span>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <div className="w-1/3">
                                <select
                                    value={agent.provider}
                                    onChange={e => onUpdateAgent(agent.id, 'provider', e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm bg-white focus:border-indigo-500"
                                >
                                    <option value="none">None / Disabled</option>
                                    <option value="simulated">Simulated / Mock</option>
                                    <option value="gemini">Gemini</option>
                                    <option value="groq">Groq</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="mistral">Mistral</option>
                                    <option value="github">GitHub Models</option>
                                </select>
                            </div>
                            <div className="w-2/3 relative">
                                {agent.provider !== 'none' ? (
                                    isLoading ? (
                                        <div className="w-full px-3 py-2 rounded-lg border border-neutral-300 bg-neutral-100 text-sm text-neutral-500 flex items-center gap-2">
                                            <div className="w-3 h-3 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                                            <span className="animate-pulse">Loading models...</span>
                                        </div>
                                    ) : providerModels.length > 0 ? (
                                        <select
                                            value={agent.model}
                                            onChange={e => onUpdateAgent(agent.id, 'model', e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm font-mono focus:border-indigo-500 bg-white"
                                        >
                                            <option value="" disabled>Select a model...</option>
                                            {freeModels.length > 0 && (
                                                <optgroup label="Free Models">
                                                    {freeModels.map(m => (
                                                        <option key={m.id} value={m.id}>{m.name}</option>
                                                    ))}
                                                </optgroup>
                                            )}
                                            {paidModels.length > 0 && (
                                                <optgroup label="Paid / Standard Models">
                                                    {paidModels.map(m => (
                                                        <option key={m.id} value={m.id}>{m.name}</option>
                                                    ))}
                                                </optgroup>
                                            )}
                                        </select>
                                    ) : (
                                        <input
                                            type="text"
                                            value={agent.model}
                                            onChange={e => onUpdateAgent(agent.id, 'model', e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm font-mono focus:border-indigo-500"
                                            placeholder={isKeyRequired ? "Model ID (API Key required to load list)" : "Model ID"}
                                        />
                                    )
                                ) : (
                                    <input
                                        type="text"
                                        value=""
                                        disabled
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm bg-neutral-100"
                                        placeholder="Disabled"
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
            <div className="text-xs text-neutral-500 px-1 pt-2">
                * If an agent's provider is set to "None", it will be skipped during execution. The Manager Node cannot be skipped.
            </div>
        </div>
    );
};
