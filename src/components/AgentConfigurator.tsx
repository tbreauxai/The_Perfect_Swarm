import React, { useState, useEffect, useRef } from 'react';
import {
    fetchAvailableModels,
    checkProviderModelsHealth,
    ModelOption
} from '../services/providerService.ts';
import type { ModelHealthStatus } from '../swarm/health.ts';
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
    const [healthStatusByModel, setHealthStatusByModel] = useState<Record<string, ModelHealthStatus>>({});
    const [checkingHealth, setCheckingHealth] = useState<Record<string, boolean>>({});
    const [onlyHealthyFilter, setOnlyHealthyFilter] = useState<boolean>(false);
    const [authRequiredProviders, setAuthRequiredProviders] = useState<Record<string, boolean>>({});
    const [tokenVersion, setTokenVersion] = useState<number>(0);

    const requestedProvidersRef = useRef<Map<string, string>>(new Map());
    const warnedProvidersRef = useRef<Set<string>>(new Set());

    const uniqueProviders = Array.from(new Set<string>((agents || []).map(a => a.provider).filter(p => p !== 'none')));
    const providersKey = uniqueProviders.sort().join(',');

    useEffect(() => {
        const handleTokenChange = () => {
            requestedProvidersRef.current.clear();
            warnedProvidersRef.current.clear();
            setTokenVersion(v => v + 1);
        };
        window.addEventListener('swarm_token_changed', handleTokenChange);
        return () => window.removeEventListener('swarm_token_changed', handleTokenChange);
    }, []);

    useEffect(() => {
        let isMounted = true;
        const providers = Array.from(new Set<string>((agents || []).map(a => a.provider).filter(p => p !== 'none')));

        providers.forEach(provider => {
            const apiKey = getApiKeyForProvider(settings, provider);
            if (requestedProvidersRef.current.get(provider) === apiKey) {
                return;
            }
            requestedProvidersRef.current.set(provider, apiKey);

            setLoadingProviders(prev => ({ ...prev, [provider]: true }));

            fetchAvailableModels(provider, apiKey)
                .then(models => {
                    if (!isMounted) return;
                    setModelsByProvider(prev => ({ ...prev, [provider]: models }));
                    setLoadingProviders(prev => ({ ...prev, [provider]: false }));

                    // Trigger parallel async 2-tier health check (cached for 5-10 min)
                    setCheckingHealth(prev => ({ ...prev, [provider]: true }));
                    checkProviderModelsHealth(provider, models, apiKey, { skipTier2: true })
                        .then(healthMap => {
                            if (!isMounted) return;
                            setHealthStatusByModel(prev => ({ ...prev, ...healthMap }));
                            setCheckingHealth(prev => ({ ...prev, [provider]: false }));
                        })
                        .catch(() => {
                            if (!isMounted) return;
                            setCheckingHealth(prev => ({ ...prev, [provider]: false }));
                        });
                })
                .catch(err => {
                    if (!isMounted) return;
                    if (!warnedProvidersRef.current.has(provider)) {
                        warnedProvidersRef.current.add(provider);
                        console.warn(`Failed to load models for ${provider}:`, err);
                    }
                    const isAuthError = err?.kind === 'app-auth' || err?.status === 401 || (err?.message && /app token|unauthorized|missing|key/i.test(err.message));
                    if (isAuthError) {
                        setAuthRequiredProviders(prev => ({ ...prev, [provider]: true }));
                        requestedProvidersRef.current.delete(provider);
                    } else {
                        setModelsByProvider(prev => ({ ...prev, [provider]: [] }));
                    }
                    setLoadingProviders(prev => ({ ...prev, [provider]: false }));
                });
        });

        return () => {
            isMounted = false;
        };
    }, [providersKey, settings, tokenVersion]);

    const getModelKey = (provider: string, modelId: string): string => {
        return `${provider.toLowerCase().trim()}:${modelId.trim()}`;
    };
    const handleRetestModel = async (provider: string, modelId: string) => {
        const apiKey = getApiKeyForProvider(settings, provider);
        const singleModelOption: ModelOption = { id: modelId, name: modelId };

        setCheckingHealth(prev => ({ ...prev, [provider]: true }));
        try {
            const result = await checkProviderModelsHealth(provider, [singleModelOption], apiKey, { skipTier2: false });
            setHealthStatusByModel(prev => ({ ...prev, ...result }));

            // Update shared cache
            const TIER2_CACHE_KEY = 'swarm_tier2_health_cache';
            try {
                const cacheRaw = localStorage.getItem(TIER2_CACHE_KEY);
                const cache = cacheRaw ? JSON.parse(cacheRaw) : {};
                cache[`${provider}:${modelId}`] = { passed: result[`${provider.toLowerCase().trim()}:${modelId.trim()}`]?.healthy ?? true, at: Date.now() };
                localStorage.setItem(TIER2_CACHE_KEY, JSON.stringify(cache));
            } catch (e) {}
        } finally {
            setCheckingHealth(prev => ({ ...prev, [provider]: false }));
        }
    };


    const isModelTripped = (provider: string, modelId: string): boolean => {
        const key = getModelKey(provider, modelId);
        return healthStatusByModel[key]?.circuitState === 'OPEN';
    };

    const getModelBadge = (provider: string, modelId: string): string => {
        const key = getModelKey(provider, modelId);
        const health = healthStatusByModel[key];
        if (!health) return '';
        if (health.circuitState === 'OPEN') return ' [⛔ Circuit Tripped]';
        if (health.circuitState === 'UNCHECKED' || (health.latencyMs === null && !health.healthy)) return ' [⚠ unchecked]';
        if (!health.healthy) return ' [⚠ Degraded]';
        return ` [✓ ${health.latencyMs != null ? `${health.latencyMs}ms` : '—'}]`;
    };

    const isModelAllowedUnderFilter = (provider: string, model: ModelOption): boolean => {
        if (!onlyHealthyFilter) return true;
        const key = getModelKey(provider, model.id);
        const health = healthStatusByModel[key];
        if (!health) return true; // not yet checked or pending
        if (health.circuitState === 'UNCHECKED') return true;
        return health.healthy && health.circuitState !== 'OPEN';
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between px-1 pb-1 border-b border-neutral-200">
                <span className="text-xs font-semibold text-neutral-600">Specialist Nodes</span>
                <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={onlyHealthyFilter}
                        onChange={e => setOnlyHealthyFilter(e.target.checked)}
                        className="rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                    />
                    <span>Filter Healthy Only (Near Real-Time)</span>
                </label>
            </div>

            {agents?.map(agent => {
                const allProviderModels = modelsByProvider[agent.provider] || [];
                const providerModels = allProviderModels.filter(m => isModelAllowedUnderFilter(agent.provider, m));
                const isLoading = loadingProviders[agent.provider];
                const isPingingHealth = checkingHealth[agent.provider];
                const freeModels = providerModels.filter(m => m.free);
                const paidModels = providerModels.filter(m => !m.free);
                const apiKey = getApiKeyForProvider(settings, agent.provider);
                const isKeyRequired = agent.provider !== 'none' && agent.provider !== 'openrouter' && agent.provider !== 'simulated' && !apiKey;
                const activeModelKey = getModelKey(agent.provider, agent.model);
                const activeHealth = healthStatusByModel[activeModelKey];

                return (
                    <div key={agent.id} className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-2">
                        <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-semibold text-neutral-900">{agent.role}</label>
                                {isPingingHealth && (
                                    <span className="text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-200 animate-pulse">
                                        Pinging health...
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5">
                                {activeHealth && activeHealth.circuitState === 'OPEN' && (
                                    <span className="text-xs text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200 font-medium">
                                        ⛔ Model Disabled (Circuit Breaker OPEN)
                                    </span>
                                )}
                                {activeHealth && activeHealth.circuitState === 'UNCHECKED' && (
                                    <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 font-medium" title={activeHealth.note || 'No API key — not checked'}>
                                        ⚠ Unchecked (—)
                                    </span>
                                )}
                                {activeHealth && activeHealth.healthy && (
                                    <span className="text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-200 font-medium">
                                        ✓ Healthy ({activeHealth.latencyMs != null ? `${activeHealth.latencyMs}ms` : '—'})
                                    </span>
                                )}
                                {isKeyRequired && (
                                    <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 font-medium">
                                        API Key required
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <div className="w-1/3">
                                <div className="flex items-center w-full">
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
                                    <button
                                        onClick={() => handleRetestModel(agent.provider, agent.model)}
                                        className="ml-2 px-2 py-1 bg-neutral-200 hover:bg-neutral-300 rounded text-xs text-neutral-700 whitespace-nowrap"
                                        title="Force Tier-2 Health Check"
                                    >
                                        Retest
                                    </button>

                                    </div>
                            </div>
                            <div className="w-2/3 relative">
                                {agent.provider !== 'none' ? (
                                    isLoading ? (
                                        <div className="w-full px-3 py-2 rounded-lg border border-neutral-300 bg-neutral-100 text-sm text-neutral-500 flex items-center gap-2">
                                            <div className="w-3 h-3 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                                            <span className="animate-pulse">Loading models...</span>
                                        </div>
                                    ) : providerModels.length > 0 ? (
                                        <div className="flex items-center w-full">
                                        <select
                                            value={agent.model}
                                            onChange={e => onUpdateAgent(agent.id, 'model', e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm font-mono focus:border-indigo-500 bg-white"
                                        >
                                            <option value="" disabled>Select a model...</option>
                                            {freeModels.length > 0 && (
                                                <optgroup label="Free Models">
                                                    {freeModels.map(m => (
                                                        <option
                                                            key={m.id}
                                                            value={m.id}
                                                            disabled={isModelTripped(agent.provider, m.id)}
                                                        >
                                                            {m.name}{getModelBadge(agent.provider, m.id)}
                                                        </option>
                                                    ))}
                                                </optgroup>
                                            )}
                                            {paidModels.length > 0 && (
                                                <optgroup label="Paid / Standard Models">
                                                    {paidModels.map(m => (
                                                        <option
                                                            key={m.id}
                                                            value={m.id}
                                                            disabled={isModelTripped(agent.provider, m.id)}
                                                        >
                                                            {m.name}{getModelBadge(agent.provider, m.id)}
                                                        </option>
                                                    ))}
                                                </optgroup>
                                            )}
                                        </select>
                                    <button
                                        onClick={() => handleRetestModel(agent.provider, agent.model)}
                                        className="ml-2 px-2 py-1 bg-neutral-200 hover:bg-neutral-300 rounded text-xs text-neutral-700 whitespace-nowrap"
                                        title="Force Tier-2 Health Check"
                                    >
                                        Retest
                                    </button>

                                    </div>
                                    ) : (
                                        <div className="space-y-1">
                                            <input
                                                type="text"
                                                value={agent.model}
                                                onChange={e => onUpdateAgent(agent.id, 'model', e.target.value)}
                                                className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm font-mono focus:border-indigo-500"
                                                placeholder={authRequiredProviders[agent.provider] ? "Model ID (Add an app token to load the model list)" : (isKeyRequired ? "Model ID (API Key required to load list)" : "Model ID")}
                                            />
                                            {authRequiredProviders[agent.provider] && (
                                                <p className="text-[11px] text-amber-600">Add an app token to load the model list</p>
                                            )}
                                        </div>
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
