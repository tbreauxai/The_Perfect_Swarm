import sys

def modify():
    with open("src/swarm/engine/learningPipeline.ts", "r") as f:
        content = f.read()

    search = """            context.addEvent({
                agentRole: 'Adaptive Learning Coordinator',
                action: 'Agent Learning Rates Updated',
                modelName: 'Local/AgentAdaptiveLearningRateManager',
                prompt: `Adjusted learning rates across ${Object.keys(updatedRates).length} agents based on reward ${targetReward}`,
                output: {
                    reward: targetReward,
                    agentRates: updatedRates
                },
                durationMs: 0
            });"""

    replace = """            const bestPolicy = globalFeedbackEngine.getPolicyOptimizer().getBestPolicy();
            for (const key of Object.keys(updatedRates)) {
                updatedRates[key] = bestPolicy.explorationFactor;
            }

            context.addEvent({
                agentRole: 'Adaptive Learning Coordinator',
                action: 'Agent Learning Rates Updated',
                modelName: 'Local/AgentAdaptiveLearningRateManager',
                prompt: `Logged explorationFactor across ${Object.keys(updatedRates).length} agents`,
                output: {
                    reward: targetReward,
                    agentRates: updatedRates
                },
                durationMs: 0
            });"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/learningPipeline.ts", "w") as f:
            f.write(content)
        print("Success learningPipeline novelty2")
    else:
        print("Search not found in learningPipeline novelty2")

modify()
