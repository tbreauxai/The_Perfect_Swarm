import sys

def modify():
    with open("src/swarm/feedback.test.ts", "r") as f:
        content = f.read()

    search = """    it('updates parameters using 1/5th rule on successful generation', () => {"""

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
        // Run N+1 uses proposed1. It gets a better reward.
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

        // Test success case: using the exact proposed policy updates the best policy
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

        // Test failure case: If what we USED doesn't equal what was PROPOSED, mutations have stopped applying correctly
        // and we shouldn't credit the mutation.
        const wrongUsedParams = optimizer.getCurrentPolicy();
        wrongUsedParams.schedulerMaxConcurrency = 999;

        const res2 = optimizer.updateWithFeedback(evenBetterReward, wrongUsedParams, proposed2);
        expect(res2.updated).toBe(false); // Should not update because they don't match
        expect(optimizer.getBestPolicy()).toEqual(proposed1); // Best policy remains the previous one
    });

    it('updates parameters using 1/5th rule on successful generation', () => {"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/feedback.test.ts", "w") as f:
            f.write(content)
        print("Success feedback test 2")
    else:
        print("Search not found in feedback test 2")

modify()
