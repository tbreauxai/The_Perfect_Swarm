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

    // Morning judge already injects steam/calibration; search_lessons → Qdrant hangs CI multi-game runs.
    const isMorningJudge = settings?.responseSchema === 'morning_judge';
    if (memoryCortex && !isMorningJudge) {
        toolRegistry.register({
            name: 'search_lessons',
            description: 'Search graded lessons by sport and market. Returns the top matches.',
            parameters: {
                sport: { type: 'string', description: 'Sport key, for example basketball_nba' },
                market: { type: 'string', description: 'Market, for example spread or total' },
                query: { type: 'string', description: 'Free text, for example unders in close games' }
            },
            execute: async (toolParams: { sport?: string; market?: string; query?: string }) => {
                const scope = params.retrievalScope;
                const trustedAppId = scope?.callerAppId || params.callerAppId || params.originApp || targetAppId;
                const boundSport = scope?.sport || params.sport;
                if (
                    boundSport &&
                    toolParams.sport &&
                    toolParams.sport.trim().toLowerCase() !== boundSport.trim().toLowerCase()
                ) {
                    return { lessons: [], query: '', count: 0, note: 'sport_out_of_scope' };
                }
                const effectiveSport = boundSport || toolParams.sport?.trim() || undefined;
                const q = [effectiveSport, toolParams.market, toolParams.query].filter(Boolean).join(' ');
                if (!q) return { lessons: [], note: 'no query' };
                const results = await memoryCortex.retrieve(q, {
                    appId: trustedAppId,
                    includeShared: false,
                    publicOnly: true,
                    sport: effectiveSport,
                    entityIds: scope?.entityIds?.length ? scope.entityIds : params.entityIds,
                    eventIds: scope?.eventIds?.length ? scope.eventIds : params.eventIds,
                    asOf: scope?.asOf,
                    limit: 5
                });
                const count = Array.isArray(results) ? results.length : 0;
                console.log(`[search_lessons] query="${q}" returned ${count}`);
                return { lessons: results, query: q, count };
            }
        });
    }

    return { memoryCortex, toolRegistry };
}
