import sys

def modify():
    with open("src/swarm/engine/index.ts", "r") as f:
        content = f.read()

    # Need to add import for globalFeedbackEngine
    search_import = """import { globalTieredCache } from '../tieredCache.ts';"""
    replace_import = """import { globalTieredCache } from '../tieredCache.ts';
import { globalFeedbackEngine } from '../feedback.ts';"""

    if search_import in content:
        content = content.replace(search_import, replace_import)
    else:
        print("Import search not found")

    search_settings = """        const includeShared = settings?.includeSharedMemory !== false;
        const qdrantUrl = settings?.qdrantUrl;
        const { memoryCortex, toolRegistry } = bindCortexAndTools(params, settings, defaultAi, targetAppId);"""

    replace_settings = """        const includeShared = settings?.includeSharedMemory !== false;
        const qdrantUrl = settings?.qdrantUrl;

        // 0. Apply dynamic RL default policy
        const bestPolicy = globalFeedbackEngine.getPolicyOptimizer().getBestPolicy();
        if (settings) {
            if (settings.cacheSettings) {
                settings.cacheSettings.semanticThreshold = settings.cacheSettings.semanticThreshold ?? bestPolicy.cacheSemanticThreshold;
            } else {
                settings.cacheSettings = { semanticThreshold: bestPolicy.cacheSemanticThreshold };
            }

            if (settings.optimizationSettings) {
                settings.optimizationSettings.compressionTargetReductionRatio = settings.optimizationSettings.compressionTargetReductionRatio ?? bestPolicy.compressionTargetReductionRatio;
            } else {
                settings.optimizationSettings = { compressionTargetReductionRatio: bestPolicy.compressionTargetReductionRatio };
            }

            if (settings.clusterSettings) {
                settings.clusterSettings.schedulerMaxConcurrency = settings.clusterSettings.schedulerMaxConcurrency ?? bestPolicy.schedulerMaxConcurrency;
            } else {
                settings.clusterSettings = { schedulerMaxConcurrency: bestPolicy.schedulerMaxConcurrency };
            }
        } else {
            (params as any).settings = {
                cacheSettings: { semanticThreshold: bestPolicy.cacheSemanticThreshold },
                optimizationSettings: { compressionTargetReductionRatio: bestPolicy.compressionTargetReductionRatio },
                clusterSettings: { schedulerMaxConcurrency: bestPolicy.schedulerMaxConcurrency }
            };
        }

        const { memoryCortex, toolRegistry } = bindCortexAndTools(params, params.settings || settings, defaultAi, targetAppId);"""

    if search_settings in content:
        content = content.replace(search_settings, replace_settings)
        with open("src/swarm/engine/index.ts", "w") as f:
            f.write(content)
        print("Success engine index")
    else:
        print("Search settings not found")

modify()
