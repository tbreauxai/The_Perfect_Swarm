import sys

def modify():
    with open("src/swarm/engine/learningPipeline.ts", "r") as f:
        content = f.read()

    search = """        workflowSchedulingResult,
        workflowHierarchyMetrics,
        workflowTieredCacheHit,
        latestClusterDigests
    } = p;"""

    replace = """        workflowSchedulingResult,
        workflowHierarchyMetrics,
        workflowTieredCacheHit,
        latestClusterDigests,
        parametersUsed
    } = p;"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/learningPipeline.ts", "w") as f:
            f.write(content)
        print("Success params2")
    else:
        print("Search params2 not found")

    search_fb = """                finalInsightSnippet: typeof finalAnalysis === 'string' ? finalAnalysis.slice(0, 150) : (finalAnalysis?.ui_title || JSON.stringify(finalAnalysis).slice(0, 150)),
                inputData: data
            });"""

    replace_fb = """                finalInsightSnippet: typeof finalAnalysis === 'string' ? finalAnalysis.slice(0, 150) : (finalAnalysis?.ui_title || JSON.stringify(finalAnalysis).slice(0, 150)),
                inputData: data,
                parametersUsed: parametersUsed
            });"""

    if search_fb in content:
        content = content.replace(search_fb, replace_fb)
        with open("src/swarm/engine/learningPipeline.ts", "w") as f:
            f.write(content)
        print("Success fb")
    else:
        print("Search fb not found")

modify()
