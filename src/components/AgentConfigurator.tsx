import React from 'react';

export interface AgentConfig {
    id: string;
    role: string;
    provider: string;
    model: string;
}

interface AgentConfiguratorProps {
    agents: AgentConfig[];
    onUpdateAgent: (id: string, field: string, value: string) => void;
}

export const AgentConfigurator: React.FC<AgentConfiguratorProps> = ({ agents, onUpdateAgent }) => {
    return (
        <div className="space-y-4">
            {agents?.map(agent => (
                <div key={agent.id} className="p-3 bg-neutral-50 rounded-xl border border-neutral-200 space-y-2">
                    <div className="flex items-center justify-between mb-1">
                        <label className="text-sm font-semibold text-neutral-900">{agent.role}</label>
                    </div>
                    <div className="flex gap-2">
                        <div className="w-1/3">
                            <select
                                value={agent.provider}
                                onChange={e => onUpdateAgent(agent.id, 'provider', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm bg-white focus:border-indigo-500"
                            >
                                <option value="none">None / Disabled</option>
                                <option value="gemini">Gemini</option>
                                <option value="groq">Groq</option>
                                <option value="openrouter">OpenRouter</option>
                                <option value="mistral">Mistral</option>
                            </select>
                        </div>
                        <div className="w-2/3">
                            <input
                                type="text"
                                value={agent.model}
                                onChange={e => onUpdateAgent(agent.id, 'model', e.target.value)}
                                disabled={agent.provider === 'none'}
                                className="w-full px-3 py-2 rounded-lg border border-neutral-300 outline-none text-sm font-mono focus:border-indigo-500 disabled:opacity-50 disabled:bg-neutral-100"
                                placeholder="Model Name..."
                            />
                        </div>
                    </div>
                </div>
            ))}
            <div className="text-xs text-neutral-500 px-1 pt-2">
                * If an agent's provider is set to &quot;None&quot;, it will be skipped during execution. The Manager Node cannot be skipped.
            </div>
        </div>
    );
};
