import { GoogleGenAI } from "@google/genai";
import { MemoryCortex } from "../memory.ts";
import type { LearnedMemoryEvent, SwarmEngineSettings } from "../types.ts";
import type { SwarmWorkflowParams, SwarmWorkflowResult } from "./types.ts";
import { executeSwarmWorkflow } from "./index.ts";
export class SwarmEngine {
    private defaultSettings: SwarmEngineSettings;
    private defaultAi?: GoogleGenAI;
    private defaultCortex?: MemoryCortex;
    private defaultOnMemoryLearned?: (event: LearnedMemoryEvent) => void;

    constructor(
        configOrSettings: SwarmEngineSettings = {},
        defaultAi?: GoogleGenAI,
        defaultCortex?: MemoryCortex
    ) {
        if (configOrSettings && typeof configOrSettings === 'object' && ('cortex' in configOrSettings || 'onMemoryLearned' in configOrSettings || 'defaultCortex' in configOrSettings)) {
            this.defaultSettings = configOrSettings.settings || {};
            this.defaultAi = configOrSettings.defaultAi || defaultAi;
            this.defaultCortex = configOrSettings.cortex || configOrSettings.defaultCortex || defaultCortex;
            this.defaultOnMemoryLearned = configOrSettings.onMemoryLearned;
        } else {
            this.defaultSettings = configOrSettings;
            this.defaultAi = defaultAi;
            this.defaultCortex = defaultCortex;
        }
    }

    async execute(params: Omit<SwarmWorkflowParams, 'settings' | 'defaultAi'> & { settings?: SwarmEngineSettings; defaultAi?: GoogleGenAI; cortex?: MemoryCortex; onMemoryLearned?: (event: LearnedMemoryEvent) => void }): Promise<SwarmWorkflowResult> {
        return executeSwarmWorkflow({
            ...params,
            settings: { ...this.defaultSettings, ...params.settings },
            defaultAi: params.defaultAi || this.defaultAi,
            cortex: params.cortex || this.defaultCortex,
            onMemoryLearned: params.onMemoryLearned || this.defaultOnMemoryLearned
        });
    }

    async executeWorkflow(params: Omit<SwarmWorkflowParams, 'settings' | 'defaultAi'> & { settings?: SwarmEngineSettings; defaultAi?: GoogleGenAI; cortex?: MemoryCortex; onMemoryLearned?: (event: LearnedMemoryEvent) => void }): Promise<SwarmWorkflowResult> {
        return this.execute(params);
    }

    static execute(params: SwarmWorkflowParams): Promise<SwarmWorkflowResult> {
        return executeSwarmWorkflow(params);
    }
}
