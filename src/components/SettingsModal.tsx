import React, { useState } from 'react';
import { getAppToken, setAppToken } from '../services/appAuthHeaders';
import { Settings, X, Database } from 'lucide-react';
import { AgentConfigurator, AgentConfig } from './AgentConfigurator';

export interface AppSettings {
    geminiApiKey?: string;
    openRouterApiKey?: string;
    groqApiKey?: string;
    mistralApiKey?: string;
    qdrantUrl?: string;
    qdrantApiKey?: string;
    githubToken?: string;
    appId?: string;
    disableFallback?: boolean;
    forceFullSwarm?: boolean;
    ephemeralKeys?: boolean;
    agents: AgentConfig[];
}

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: AppSettings;
    onUpdateSetting: (key: keyof AppSettings, value: any) => void;
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
    const [appToken, setAppTokenValue] = useState(getAppToken);

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
                            <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-200 space-y-3">
                                <div className="flex items-center justify-between mb-1">
                                    <h3 className="text-sm font-semibold text-neutral-800">Server Secrets Status</h3>
                                    <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">Server-Side Only</span>
                                </div>
                                <p className="text-xs text-neutral-500">
                                    Provider API keys and database credentials are managed exclusively as server secrets. The browser does not collect, store, or forward provider keys.
                                </p>
                                <div className="grid grid-cols-2 gap-2 pt-2">
                                    <div className="p-2.5 bg-white rounded-lg border border-neutral-200 flex items-center justify-between">
                                        <span className="text-xs font-medium text-neutral-700">Gemini</span>
                                        {envStatus.hasGeminiKey ? (
                                            <span className="text-[11px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-medium">✅ Loaded</span>
                                        ) : (
                                            <span className="text-[11px] text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full border border-neutral-200">Not Set</span>
                                        )}
                                    </div>
                                    <div className="p-2.5 bg-white rounded-lg border border-neutral-200 flex items-center justify-between">
                                        <span className="text-xs font-medium text-neutral-700">Groq</span>
                                        {envStatus.hasGroqKey ? (
                                            <span className="text-[11px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-medium">✅ Loaded</span>
                                        ) : (
                                            <span className="text-[11px] text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full border border-neutral-200">Not Set</span>
                                        )}
                                    </div>
                                    <div className="p-2.5 bg-white rounded-lg border border-neutral-200 flex items-center justify-between">
                                        <span className="text-xs font-medium text-neutral-700">OpenRouter</span>
                                        {envStatus.hasOpenRouterKey ? (
                                            <span className="text-[11px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-medium">✅ Loaded</span>
                                        ) : (
                                            <span className="text-[11px] text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full border border-neutral-200">Not Set</span>
                                        )}
                                    </div>
                                    <div className="p-2.5 bg-white rounded-lg border border-neutral-200 flex items-center justify-between">
                                        <span className="text-xs font-medium text-neutral-700">Mistral</span>
                                        {envStatus.hasMistralKey ? (
                                            <span className="text-[11px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-medium">✅ Loaded</span>
                                        ) : (
                                            <span className="text-[11px] text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full border border-neutral-200">Not Set</span>
                                        )}
                                    </div>
                                    <div className="p-2.5 bg-white rounded-lg border border-neutral-200 flex items-center justify-between col-span-2">
                                        <span className="text-xs font-medium text-neutral-700 flex items-center gap-1.5">
                                            <Database className="w-3.5 h-3.5 text-neutral-400" /> Qdrant Vector DB
                                        </span>
                                        {envStatus.hasQdrantUrl && envStatus.hasQdrantKey ? (
                                            <span className="text-[11px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-medium">✅ Loaded</span>
                                        ) : (
                                            <span className="text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">In-Memory (No Secrets)</span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4 pt-2 border-t border-neutral-100">
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
                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-sm font-medium text-neutral-700">App token</label>
                                        <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-200">Caller auth</span>
                                    </div>
                                    <input
                                        type="password"
                                        value={appToken}
                                        onChange={(e) => {
                                            setAppTokenValue(e.target.value);
                                            setAppToken(e.target.value);
                                        }}
                                        placeholder="Bearer token for this dashboard"
                                        className="w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-indigo-500 outline-none text-sm"
                                    />
                                    <p className="text-xs text-neutral-500 mt-1">Identifies this dashboard to the swarm. Stored in swarm_app_token and not sent as a provider key.</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'swarm' && (
                        <div className="space-y-6">
                            <div className="flex items-center justify-between bg-white border border-neutral-200 p-4 rounded-xl shadow-sm">
                                <div>
                                    <h4 className="text-sm font-semibold text-neutral-900">Disable Provider Fallback</h4>
                                    <p className="text-xs text-neutral-500 mt-1">If enabled, agents will strictly use their configured provider and will not failover to others on errors.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        className="sr-only peer"
                                        checked={settings.disableFallback ?? false}
                                        onChange={(e) => onUpdateSetting('disableFallback', e.target.checked as any)}
                                    />
                                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                                </label>
                            </div>
                            <div className="flex items-center justify-between bg-white border border-neutral-200 p-4 rounded-xl shadow-sm">
                                <div>
                                    <h4 className="text-sm font-semibold text-neutral-900">Override Fast Track (Force Full Swarm)</h4>
                                    <p className="text-xs text-neutral-500 mt-1">If enabled, bypasses fast-path short-circuiting and runs the full multi-agent swarm pipeline even on simple tasks.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        className="sr-only peer"
                                        checked={settings.forceFullSwarm ?? false}
                                        onChange={(e) => onUpdateSetting('forceFullSwarm', e.target.checked as any)}
                                    />
                                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                                </label>
                            </div>
                            <AgentConfigurator agents={settings.agents} onUpdateAgent={onUpdateAgent} settings={settings} />
                        </div>
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
