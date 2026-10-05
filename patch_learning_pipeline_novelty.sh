cat << 'INNER_EOF' > modify_learning_pipeline_novelty.py
import sys

def modify():
    with open("src/swarm/engine/learningPipeline.ts", "r") as f:
        content = f.read()

    search = """        if (coordinationSettings?.rewardShaping !== false) {
            const noveltyScore = Math.min(1.0, (globalKnowledgeGraph.getStats().totalNodes % 10) / 10 + 0.3);
            const redundancyCount = globalHypothesisLayer.getHypotheses('refuted').length;
            workflowShapedReward = globalShapedRewardPolicy.calculateShapedReward({
                extrinsicReward: extrinsic,
                noveltyScore,
                redundancyCount
            });
        }

        if (coordinationSettings?.adaptiveLearningRates !== false) {
            const targetReward = workflowShapedReward?.shapedReward ?? extrinsic;
            const updatedRates: Record<string, number> = {};
            for (const analyst of analysts) {
                const res = globalLearningRateManager.recordAgentStep(analyst.role, targetReward);
                updatedRates[analyst.role] = res.newRate;
            }
            const mgrRes = globalLearningRateManager.recordAgentStep(managerAgent.role || 'Manager Node', targetReward);
            updatedRates[managerAgent.role || 'Manager Node'] = mgrRes.newRate;

            context.addEvent({
                agentRole: 'Adaptive Learning Coordinator',
                action: 'Agent Learning Rates Updated',
                modelName: 'Local/AgentAdaptiveLearningRateManager',
                prompt: `Adjusted learning rates across ${Object.keys(updatedRates).length} agents based on reward ${targetReward}`,
                output: {
                    reward: targetReward,
                    agentRates: updatedRates
                },
                durationMs: 0
            });
        }"""

    replace = """        if (coordinationSettings?.rewardShaping !== false) {
            const noveltyScore = Math.max(0, 1.0 - (p.workflowTieredCacheHit?.similarity ?? 0));
            const redundancyCount = globalHypothesisLayer.getHypotheses('refuted').length;
            workflowShapedReward = globalShapedRewardPolicy.calculateShapedReward({
                extrinsicReward: extrinsic,
                noveltyScore,
                redundancyCount
            });
        }

        if (coordinationSettings?.adaptiveLearningRates !== false) {
            const targetReward = workflowShapedReward?.shapedReward ?? extrinsic;
            const updatedRates: Record<string, number> = {};
            for (const analyst of analysts) {
                // Rate update logic deleted; leaving explorationFactor logs via rates map
                updatedRates[analyst.role] = globalLearningRateManager.getLearningRate(analyst.role);
            }
            updatedRates[managerAgent.role || 'Manager Node'] = globalLearningRateManager.getLearningRate(managerAgent.role || 'Manager Node');

            context.addEvent({
                agentRole: 'Adaptive Learning Coordinator',
                action: 'Agent Learning Rates Updated',
                modelName: 'Local/AgentAdaptiveLearningRateManager',
                prompt: `Adjusted learning rates across ${Object.keys(updatedRates).length} agents based on reward ${targetReward}`,
                output: {
                    reward: targetReward,
                    agentRates: updatedRates
                },
                durationMs: 0
            });
        }"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/learningPipeline.ts", "w") as f:
            f.write(content)
        print("Success learningPipeline novelty")
    else:
        print("Search not found in learningPipeline novelty")

modify()
INNER_EOF
python3 modify_learning_pipeline_novelty.py
