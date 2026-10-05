import sys

def modify():
    with open("src/swarm/feedback.test.ts", "r") as f:
        content = f.read()

    search = """    it('adapts policy when proposed parameters achieve higher reward', () => {"""

    replace = """    it('a policy value set on run N is the value used on run N+1, or mutations no longer happen', () => {
        const baselineReward = optimizer.calculateReward({
            workflowId: 'wf-base',
            task: 'T1',
            appId: 'test-app',
            durationMs: 1000,
            targetTier: 'instant',
            tokenSavings: 0,
            tokensConsumed: 1000,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        optimizer.updateWithFeedback(baselineReward, optimizer.getCurrentPolicy());

        const proposed1 = optimizer.proposeNextParameters();
        const betterReward = optimizer.calculateReward({
            workflowId: 'wf-better',
            task: 'T2',
            appId: 'test-app',
            durationMs: 500,
            targetTier: 'instant',
            tokenSavings: 500,
            tokensConsumed: 800,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // Using exactly proposed policy
        const res1 = optimizer.updateWithFeedback(betterReward, proposed1, proposed1);
        expect(res1.updated).toBe(true);
        expect(optimizer.getBestPolicy()).toEqual(proposed1);

        const proposed2 = optimizer.proposeNextParameters();
        const evenBetterReward = optimizer.calculateReward({
            workflowId: 'wf-even-better',
            task: 'T3',
            appId: 'test-app',
            durationMs: 200,
            targetTier: 'instant',
            tokenSavings: 600,
            tokensConsumed: 400,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // Passing a different used policy prevents mutations from updating
        const wrongUsedParams = optimizer.getCurrentPolicy();
        wrongUsedParams.schedulerMaxConcurrency = 999;

        const res2 = optimizer.updateWithFeedback(evenBetterReward, wrongUsedParams, proposed2);
        expect(res2.updated).toBe(false);
        expect(optimizer.getBestPolicy()).toEqual(proposed1);
    });

    it('adapts policy when proposed parameters achieve higher reward', () => {"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/feedback.test.ts", "w") as f:
            f.write(content)
        print("Success feedback test 3")
    else:
        print("Search not found in feedback test 3")

modify()
