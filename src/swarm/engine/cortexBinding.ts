import { GoogleGenAI } from '@google/genai';
import { MemoryCortex } from '../memory.ts';
import type { SwarmWorkflowParams } from './types.ts';
import type { SwarmEngineSettings } from '../types.ts';
import { ToolRegistry, globalToolRegistry } from '../tools/index.ts';
import { sanitizeApiKey } from './utils.ts';
import { getOrCreateDefaultCortex } from './cortex.ts';

const safeEnv = typeof process !== "undefined" ? process.env : {} as Record<string, string | undefined>;

export interface CortexBindingResult {
    memoryCortex: MemoryCortex;
    toolRegistry: ToolRegistry;
}

export function bindCortexAndTools(
    params: SwarmWorkflowParams,
    settings?: SwarmEngineSettings,
    defaultAi?: GoogleGenAI,
    targetAppId: string = 'perfect-swarm'
): CortexBindingResult {
    let memoryCortex: MemoryCortex | undefined = params.memoryCortex || params.cortex;

    if (!memoryCortex) {
        const qdrantUrl = settings?.qdrantUrl;
        const qdrantApiKey = settings?.qdrantApiKey;
        const persistPath = settings?.persistPath;
        const autoSave = settings?.autoSave;

        const cortexGeminiKey = settings?.geminiApiKey ||
            (safeEnv.GEMINI_API_KEY && safeEnv.GEMINI_API_KEY !== 'MISSING_KEY' ? safeEnv.GEMINI_API_KEY : undefined);
        const cortexAiClient = cortexGeminiKey
            ? new GoogleGenAI({ apiKey: sanitizeApiKey(cortexGeminiKey) })
            : defaultAi;

        if (qdrantUrl) {
            try {
                memoryCortex = new MemoryCortex({
                    url: qdrantUrl,
                    apiKey: qdrantApiKey,
                    collectionName: settings?.qdrantCollectionName,
                    aiClient: cortexAiClient,
                    embeddingModel: settings?.qdrantEmbeddingModel,
                    defaultAppId: targetAppId,
                    persistPath,
                    autoSave
                });
            } catch {
                memoryCortex = persistPath
                    ? new MemoryCortex({
                        defaultAppId: targetAppId,
                        collectionName: settings?.qdrantCollectionName,
                        aiClient: cortexAiClient,
                        embeddingModel: settings?.qdrantEmbeddingModel,
                        persistPath,
                        autoSave
                    })
                    : getOrCreateDefaultCortex(targetAppId, cortexAiClient);
            }
        } else {
            memoryCortex = persistPath
                ? new MemoryCortex({
                    defaultAppId: targetAppId,
                    collectionName: settings?.qdrantCollectionName,
                    aiClient: cortexAiClient,
                    embeddingModel: settings?.qdrantEmbeddingModel,
                    persistPath,
                    autoSave
                })
                : getOrCreateDefaultCortex(targetAppId, cortexAiClient);
        }
    }

    const toolRegistry: ToolRegistry = params.tools instanceof ToolRegistry
        ? params.tools
        : (Array.isArray(params.tools)
            ? new ToolRegistry(params.tools)
            : (settings?.tools instanceof ToolRegistry
                ? settings.tools
                : (Array.isArray(settings?.tools)
                    ? new ToolRegistry(settings.tools)
                    : globalToolRegistry)));

    return { memoryCortex, toolRegistry };
}
