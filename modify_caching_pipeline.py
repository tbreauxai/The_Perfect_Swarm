import sys

def modify():
    with open("src/swarm/engine/cachingPipeline.ts", "r") as f:
        content = f.read()

    search = """                finalInsightSnippet: typeof lookup.value === 'string' ? lookup.value.slice(0, 150) : (lookup.value?.ui_title || 'Tiered Cache Hit'),
                        inputData: data
                    });"""
    replace = """                finalInsightSnippet: typeof lookup.value === 'string' ? lookup.value.slice(0, 150) : (lookup.value?.ui_title || 'Tiered Cache Hit'),
                        inputData: data,
                        parametersUsed: globalFeedbackEngine.getPolicyOptimizer().getBestPolicy()
                    });"""

    if search in content:
        content = content.replace(search, replace)
        print("Success caching1")

    search2 = """                    finalInsightSnippet: typeof cachedAnalysis === 'string' ? cachedAnalysis.slice(0, 150) : (cachedAnalysis?.ui_title || 'Payload Cache Hit'),
                    inputData: data
                });"""
    replace2 = """                    finalInsightSnippet: typeof cachedAnalysis === 'string' ? cachedAnalysis.slice(0, 150) : (cachedAnalysis?.ui_title || 'Payload Cache Hit'),
                    inputData: data,
                    parametersUsed: globalFeedbackEngine.getPolicyOptimizer().getBestPolicy()
                });"""

    if search2 in content:
        content = content.replace(search2, replace2)
        print("Success caching2")

    search3 = """                    finalInsightSnippet: typeof semanticMatch.entry.payload === 'string' ? semanticMatch.entry.payload.slice(0, 150) : (semanticMatch.entry.payload?.ui_title || 'Semantic Cache Hit'),
                    inputData: data
                });"""
    replace3 = """                    finalInsightSnippet: typeof semanticMatch.entry.payload === 'string' ? semanticMatch.entry.payload.slice(0, 150) : (semanticMatch.entry.payload?.ui_title || 'Semantic Cache Hit'),
                    inputData: data,
                    parametersUsed: globalFeedbackEngine.getPolicyOptimizer().getBestPolicy()
                });"""

    if search3 in content:
        content = content.replace(search3, replace3)
        print("Success caching3")

    with open("src/swarm/engine/cachingPipeline.ts", "w") as f:
        f.write(content)

modify()
