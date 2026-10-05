cat << 'INNER_EOF' > modify_learning_pipeline.py
import sys

def modify():
    with open("src/swarm/engine/learningPipeline.ts", "r") as f:
        content = f.read()

    search = """    workflowDeduplicatedCount: number;
    workflowSchedulingResult?: SchedulerExecutionResult;
    workflowHierarchyMetrics?: HierarchyMetrics;
    workflowTieredCacheHit?: TieredLookupResult;
    latestClusterDigests?: Record<string, ClusterDigest>;
    workflowDecompositionPlan?: TaskDecompositionPlan;
}"""

    replace = """    workflowDeduplicatedCount: number;
    workflowSchedulingResult?: SchedulerExecutionResult;
    workflowHierarchyMetrics?: HierarchyMetrics;
    workflowTieredCacheHit?: TieredLookupResult;
    latestClusterDigests?: Record<string, ClusterDigest>;
    workflowDecompositionPlan?: TaskDecompositionPlan;
    parametersUsed?: any;
}"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/learningPipeline.ts", "w") as f:
            f.write(content)
        print("Success params")
    else:
        print("Search params not found")

modify()
INNER_EOF
python3 modify_learning_pipeline.py
