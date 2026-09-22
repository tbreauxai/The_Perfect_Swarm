import { GoogleGenAI } from "@google/genai";
import { MemoryCortex } from "../memory.ts";
export const defaultCortexRegistry = new Map<string, MemoryCortex>();

export function getOrCreateDefaultCortex(appId: string, aiClient?: GoogleGenAI): MemoryCortex {
    if (!defaultCortexRegistry.has(appId)) {
        defaultCortexRegistry.set(appId, new MemoryCortex({
            defaultAppId: appId,
            aiClient
        }));
    }
    return defaultCortexRegistry.get(appId)!;
}

/**
 * Executes the complete autonomous swarm analysis lifecycle:
 * Fast-path pre-filtering -> Zero-drift caching -> Token budgeting -> Qdrant continuous learning retrieval
 * -> Multi-analyst parallel execution -> Manager synthesis & Critic verification -> Memory reinforcement.
 */
