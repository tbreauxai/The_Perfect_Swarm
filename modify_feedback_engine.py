import sys

def modify():
    with open("src/swarm/feedback/feedbackEngine.ts", "r") as f:
        content = f.read()

    search = """        // 3. Propose & Update Policy
        const proposed = this.policyOptimizer.proposeNextParameters();
        const updateResult = this.policyOptimizer.updateWithFeedback(reward, proposed);"""

    replace = """        // 3. Propose & Update Policy
        const proposed = this.policyOptimizer.proposeNextParameters();
        const parametersUsed = params.parametersUsed || this.policyOptimizer.getCurrentPolicy();
        const updateResult = this.policyOptimizer.updateWithFeedback(reward, parametersUsed, proposed);"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/feedback/feedbackEngine.ts", "w") as f:
            f.write(content)
        print("Success feedbackEngine")
    else:
        print("Search string not found in feedbackEngine")

modify()
