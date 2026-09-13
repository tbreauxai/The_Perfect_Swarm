import React, { useState } from 'react';
import { Settings, X, Database } from 'lucide-react';
import { AgentConfigurator, AgentConfig } from './AgentConfigurator';

export interface AppSettings {
    geminiApiKey: string;
    openRouterApiKey: string;
    groqApiKey: string;
    mistralApiKey: string;
    qdrantUrl: string;
    qdrantApiKey: string;
    githubToken: string;
    appId?: string;
    agents: AgentConfig[];
}

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: AppSettings;
    onUpdateSetting: (key: keyof AppSettings, value: string) => void;
    onUpdateAgent: (id: string, field: string, value: string) => void;
    envStatus: {
        hasGeminiKey?: boolean;
        hasOpenRouterKey?: boolean;
        hasGroqKey?: boolean;
        hasMistralKey?: boolean;
        hasQdrantUrl?: boolean;
        hasQdrantKey?: boolean;
    };
    initialTab?: 'keys' | 'swarm';
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    settings,
    onUpdateSetting,
    onUpdateAgent,
    envStatus,
    initialTab = 'keys'
}) => {
    const [activeTab, setActiveTab] = useState<'keys' | 'swarm'>(initialTab);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
                <div className="p-5 border-b border-neutral-100 flex items-center justify-between bg-neutral-50/50">
                    <h2 className="text-lg font-semibold text-neutral-800 flex items-center gap-2">
                        <Settings className="w-5 h-5 text-neutral-500" />
                        Swarm Configuration
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-neutral-400 hover:text-neutral-800 transition-colors p-1"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex border-b border-neutral-200">
                    <button
                        onClick={() => setActiveTab('keys')}
                        className={`flex-1 py-3 text-sm font-medium ${activeTab === 'keys' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-neutral-500 hover:text-neutral-700'}`}
                    >
                        API Keys
                    </button>
                    <button
                        onClick={() => setActiveTab('swarm')}
                        className={`flex-1 py-3 text-sm font-medium ${activeTab === 'swarm' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-neutral-500 hover:text-neutral-700'}`}
                    >
                        Swarm Agents
                    </button>
                </div>

                <div className="p-5 overflow-y-auto space-y-6 max-h-[60vh]">
                    {activeTab === 'keys' && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-900 font-semibold">Gemini API Key</label>
                                        {envStatus.hasGeminiKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                                    </div>
                                    <input
                                        type="password"
                                        value={settings.geminiApiKey || ''}
                                        onChange={(e) => onUpdateSetting('geminiApiKey', e.target.value)}
                                        placeholder="AIza..."
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                </div>

                                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-900 font-semibold">OpenRouter API Key</label>
                                        {envStatus.hasOpenRouterKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                                    </div>
                                    <input
                                        type="password"
                                        value={settings.openRouterApiKey || ''}
                                        onChange={(e) => onUpdateSetting('openRouterApiKey', e.target.value)}
                                        placeholder="sk-or-v1-..."
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                    {settings.openRouterApiKey && !settings.openRouterApiKey.replace(/^(?:Bearer\s*:?)+/i, '').replace(/["'`<>]/g, '').trim().startsWith('sk-or-v1-') && (
                                        <p className="text-xs text-amber-600 font-medium">⚠️ OpenRouter keys must start with <code className="font-mono bg-amber-50 px-1 py-0.5 rounded">sk-or-v1-</code>. OpenAI keys (<code className="font-mono bg-amber-50 px-1 py-0.5 rounded">sk-...</code>) will result in a 401 error.</p>
                                    )}
                                </div>

                                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-900 font-semibold">Groq API Key</label>
                                        {envStatus.hasGroqKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                                    </div>
                                    <input
                                        type="password"
                                        value={settings.groqApiKey || ''}
                                        onChange={(e) => onUpdateSetting('groqApiKey', e.target.value)}
                                        placeholder="gsk_..."
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                </div>

                                <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-900 font-semibold">Mistral API Key</label>
                                        {envStatus.hasMistralKey && <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                                    </div>
                                    <input
                                        type="password"
                                        value={settings.mistralApiKey || ''}
                                        onChange={(e) => onUpdateSetting('mistralApiKey', e.target.value)}
                                        placeholder="Mistral Key..."
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                </div>
                            </div>

                            <div className="space-y-4 pt-4 border-t border-neutral-100">
                                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                                    <Database className="w-4 h-4" /> Qdrant Vector DB
                                </h3>
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-700">Qdrant URL</label>
                                        {envStatus.hasQdrantUrl && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                                    </div>
                                    <input
                                        type="url"
                                        value={settings.qdrantUrl || ''}
                                        onChange={(e) => onUpdateSetting('qdrantUrl', e.target.value)}
                                        placeholder="https://your-cluster.qdrant.tech"
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                </div>
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-700">Qdrant API Key</label>
                                        {envStatus.hasQdrantKey && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">✅ Loaded from Secrets</span>}
                                    </div>
                                    <input
                                        type="password"
                                        value={settings.qdrantApiKey || ''}
                                        onChange={(e) => onUpdateSetting('qdrantApiKey', e.target.value)}
                                        placeholder="API Key"
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                </div>
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-700">App Namespace (appId)</label>
                                        <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">Learning Cortex</span>
                                    </div>
                                    <input
                                        type="text"
                                        value={settings.appId || ''}
                                        onChange={(e) => onUpdateSetting('appId', e.target.value)}
                                        placeholder="perfect-swarm (or external app ID)"
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'swarm' && (
                        <AgentConfigurator agents={settings.agents} onUpdateAgent={onUpdateAgent} settings={settings} />
                    )}
                </div>

                <div className="p-5 border-t border-neutral-100 bg-neutral-50/50">
                    <button
                        onClick={onClose}
                        className="w-full bg-neutral-900 hover:bg-neutral-800 text-white font-medium py-2.5 rounded-xl transition-colors"
                    >
                        Save & Close
                    </button>
                </div>
            </div>
        </div>
    );
};
