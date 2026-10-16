import { GoogleGenAI } from '@google/genai';
import { Agent } from '../agent.ts';
import type { ProviderCredential, Provider, AgentConfig } from '../types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import type { AgentVariantConfig, AgentExperiment } from '../experiment.ts';
import { globalAgentExperimentManager } from '../experiment.ts';
import { SwarmContext } from '../context.ts';
import { sanitizeApiKey, validateProviderKey, resolveProvider } from './utils.ts';
import { buildManagerChain, buildAnalystPool, mergeFallbacks } from './managerChain.ts';

const safeEnv = typeof process !== "undefined" ? process.env : {} as Record<string, string | undefined>;
// 'github' removed: GitHub Models was retired on 2026-07-30, so it can never be a fallback or a pool provider.
const ALL_PROVIDERS: Provider[] = ['gemini', 'openrouter', 'groq', 'mistral'];

export interface ExperimentResolutionResult {
    activeExperiment?: AgentExperiment;
    activeVariant?: AgentVariantConfig;
}

export function resolveExperimentVariant(
    settings: SwarmEngineSettings | undefined,
    targetAppId: string,
    task: string,
    context: SwarmContext
): ExperimentResolutionResult {
    const experimentManager = settings?.experimentSettings?.experimentManager || globalAgentExperimentManager;
    const activeExperiment = settings?.experimentSettings?.experimentId
        ? experimentManager.getExperiment(settings.experimentSettings.experimentId)
        : experimentManager.getActiveExperiment();

    let activeVariant: AgentVariantConfig | undefined;
    const abRoutingKey = settings?.experimentSettings?.routingKey || `${targetAppId}:${task}`;

    if (activeExperiment && activeExperiment.status === 'active' && !settings?.experimentSettings?.disableABTesting) {
        activeVariant = activeExperiment.allocateVariant(abRoutingKey);
        context.addEvent({
            agentRole: 'A/B Testing Engine',
            action: 'Agent A/B Variant Dispatched',
            modelName: 'Local/ExperimentManager',
            prompt: `Allocated variant '${activeVariant.variantId}' (${activeVariant.name}) for experiment '${activeExperiment.name}'`,
            output: {
                experimentId: activeExperiment.id,
                experimentName: activeExperiment.name,
                variantId: activeVariant.variantId,
                variantName: activeVariant.name,
                isBaseline: activeVariant.isBaseline ?? false,
                routingKey: abRoutingKey
            },
            durationMs: 0
        });
    }

    return { activeExperiment, activeVariant };
}

export interface ResolvedSwarmAgents {
    managerAgent: Agent;
    analysts: Agent[];
    dedicatedCriticAgent: Agent | null;
    managerModel: string;
    managerConfig: AgentConfig;
}

export function resolveSwarmAgents(
    settings: SwarmEngineSettings | undefined,
    activeVariant: AgentVariantConfig | undefined,
    defaultAi?: GoogleGenAI
): ResolvedSwarmAgents {
    const rawAgents = (activeVariant?.agents && activeVariant.agents.length > 0)
        ? activeVariant.agents
        : (settings?.agents || []);
    let managerConfig = rawAgents.find((a: AgentConfig) => a.id === 'manager' || a.role === 'Manager Node');
    const dedicatedCriticConfig = rawAgents.find((a: AgentConfig) => a.id === 'critic' || a.role?.toLowerCase().includes('critic') || a.role?.toLowerCase().includes('verifier')) || settings?.critic;
    const analystConfigs = rawAgents.filter((a: AgentConfig) => a.id !== 'manager' && a.provider !== 'none');

    const hasUserGemini = !!settings?.geminiApiKey;
    if (!managerConfig) {
        const defaultProvider = hasUserGemini || safeEnv.GEMINI_API_KEY ? 'gemini' : 'openrouter';
        managerConfig = {
            id: 'manager',
            role: 'Manager Node',
            provider: defaultProvider,
            model: ''
        };
    }
    // PS3: global analyst fallback pool. Any keyed, healthy provider can cover a failed seat,
    // not only providers that already have a seat in this run.
    // Morning runs (morning_judge) do NOT borrow from the global pool: seat-model providers only (pre-PS3 behavior).
    const isMorningRun = (settings as any)?.responseSchema === 'morning_judge';
    const availableFallbacks: ProviderCredential[] = settings?.disableFallback
        ? []
        : buildAnalystPool(ALL_PROVIDERS, settings, rawAgents, defaultAi, { seatModelsOnly: isMorningRun });

    const { key: mKey, client: mClient } = resolveProvider(managerConfig.provider, settings, defaultAi);
    const finalMKey = managerConfig.apiKey ? sanitizeApiKey(managerConfig.apiKey) : mKey;
    validateProviderKey(managerConfig.provider, finalMKey, managerConfig.role || 'Manager Node');
    const managerModel = managerConfig.model || '';
    const managerFallbacks = settings?.disableFallback
        ? []
        : mergeFallbacks(
            buildManagerChain(defaultAi, { provider: managerConfig.provider, model: managerModel }),
            availableFallbacks.filter(f => f.provider !== managerConfig.provider)
        );
    const managerAgent = new Agent('Manager Node', managerModel, managerConfig.provider, finalMKey, mClient, managerFallbacks);
    managerAgent.preserveFallbackOrder = true;
    managerAgent.id = managerConfig.id || managerConfig.role || 'manager';
    managerAgent.maxTokens = managerConfig.maxTokens;

    const analysts: Agent[] = [];
    for (const ac of analystConfigs) {
        const { key: aKey, client: aClient } = resolveProvider(ac.provider, settings, defaultAi);
        const finalAKey = ac.apiKey ? sanitizeApiKey(ac.apiKey) : aKey;
        const isMock = ac.provider === 'simulated' || ac.provider === 'mock' || ac.provider === 'custom-mock' || ac.provider.includes('mock') || ac.provider.includes('simulated');
        if (finalAKey || isMock) {
            const aModel = ac.model || '';
            const aFallbacks = (ac as any).disableFallback || (ac as any).strictProvider
                ? []
                : availableFallbacks.filter(f => f.provider !== ac.provider);
            const analyst = new Agent(ac.role || 'Analyst', aModel, ac.provider, finalAKey, aClient, aFallbacks);
            analyst.id = ac.id || ac.role;
            analyst.maxTokens = ac.maxTokens;
            analysts.push(analyst);
        } else {
            console.warn(`Skipping ${ac.role}: missing API key for ${ac.provider}`);
        }
    }

    let dedicatedCriticAgent: Agent | null = null;
    if (dedicatedCriticConfig) {
        const { key: cKey, client: cClient } = resolveProvider(dedicatedCriticConfig.provider, settings, defaultAi);
        const finalCKey = dedicatedCriticConfig.apiKey ? sanitizeApiKey(dedicatedCriticConfig.apiKey) : cKey;
        const isCriticMock = dedicatedCriticConfig.provider === 'simulated' || dedicatedCriticConfig.provider === 'mock' || dedicatedCriticConfig.provider === 'custom-mock' || dedicatedCriticConfig.provider.includes('mock') || dedicatedCriticConfig.provider.includes('simulated');
        if (finalCKey || isCriticMock) {
            const cModel = dedicatedCriticConfig.model || '';
            const cFallbacks = availableFallbacks.filter(f => f.provider !== dedicatedCriticConfig.provider);
            dedicatedCriticAgent = new Agent(dedicatedCriticConfig.role || 'Verification Critic', cModel, dedicatedCriticConfig.provider, finalCKey, cClient, cFallbacks);
            dedicatedCriticAgent.id = dedicatedCriticConfig.id || dedicatedCriticConfig.role || 'critic';
            dedicatedCriticAgent.maxTokens = dedicatedCriticConfig.maxTokens;
        }
    }

    if (analysts.length === 0) {
        throw new Error('No active Analysts found. Please configure at least one Analyst agent in settings and ensure its API key is provided.');
    }

    return {
        managerAgent,
        analysts,
        dedicatedCriticAgent,
        managerModel,
        managerConfig
    };
}
