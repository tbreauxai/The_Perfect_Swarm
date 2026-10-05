import sys

def modify():
    with open("src/swarm/engine/index.ts", "r") as f:
        content = f.read()

    search = """                workflowSchedulingResult: clusterResult.workflowSchedulingResult,
                workflowHierarchyMetrics: clusterResult.workflowHierarchyMetrics,
                latestClusterDigests: clusterResult.latestClusterDigests,
                workflowDecompositionPlan: profilingResult.workflowDecompositionPlan
            });"""

    replace = """                workflowSchedulingResult: clusterResult.workflowSchedulingResult,
                workflowHierarchyMetrics: clusterResult.workflowHierarchyMetrics,
                latestClusterDigests: clusterResult.latestClusterDigests,
                workflowDecompositionPlan: profilingResult.workflowDecompositionPlan,
                parametersUsed: bestPolicy
            });"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/index.ts", "w") as f:
            f.write(content)
        print("Success engine index2")
    else:
        print("Search engine index2 not found")

modify()
