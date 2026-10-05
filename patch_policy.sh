cat << 'INNER_EOF' > modify_policy.py
import sys

def modify_policy():
    with open("src/swarm/feedback/policyOptimizer.ts", "r") as f:
        content = f.read()

    search = """    public updateWithFeedback(reward: RewardSignal, proposedParams?: TunableParameters): {
        updated: boolean;
        currentPolicy: TunableParameters;
        generation: number;
        mutationStep: number;
    } {
        const score = reward.compositeReward;
        this.rewardHistory.push(score);
        if (this.rewardHistory.length > 1000) {
            this.rewardHistory.shift();
        }
        this.generation++;
        this.totalMutations++;

        let updated = false;

        if (proposedParams && score > this.bestReward) {
            this.bestReward = score;
            this.bestPolicy = { ...proposedParams };
            this.currentPolicy = { ...proposedParams };
            this.successfulMutations++;
            updated = true;
        } else if (!proposedParams) {
            // Baseline observation
            if (score > this.bestReward || this.bestReward === -Infinity) {
                this.bestReward = score;
                this.bestPolicy = { ...this.currentPolicy };
            }
        }"""

    replace = """    public updateWithFeedback(reward: RewardSignal, parametersUsed: TunableParameters, proposedParams?: TunableParameters): {
        updated: boolean;
        currentPolicy: TunableParameters;
        generation: number;
        mutationStep: number;
    } {
        const score = reward.compositeReward;
        this.rewardHistory.push(score);
        if (this.rewardHistory.length > 1000) {
            this.rewardHistory.shift();
        }
        this.generation++;
        this.totalMutations++;

        let updated = false;

        // Baseline observation / seeding
        if (this.bestReward === -Infinity) {
            // Check if they actually used the default policy on this first run
            const isDefault = Object.keys(DEFAULT_TUNABLE_PARAMETERS).every(k =>
                (parametersUsed as any)[k] === (DEFAULT_TUNABLE_PARAMETERS as any)[k]
            );
            if (isDefault) {
                this.bestReward = score;
                this.bestPolicy = { ...parametersUsed };
            }
        }

        // Check if the proposal was the one used
        const usedMatchesProposal = proposedParams && Object.keys(proposedParams).every(k =>
            (parametersUsed as any)[k] === (proposedParams as any)[k]
        );

        if (usedMatchesProposal && score > this.bestReward) {
            this.bestReward = score;
            this.bestPolicy = { ...proposedParams };
            this.currentPolicy = { ...proposedParams };
            this.successfulMutations++;
            updated = true;
        } else if (!proposedParams) {
             if (score > this.bestReward) {
                 this.bestReward = score;
                 this.bestPolicy = { ...this.currentPolicy };
             }
        }"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/feedback/policyOptimizer.ts", "w") as f:
            f.write(content)
        print("Success")
    else:
        print("Search string not found")

modify_policy()
INNER_EOF
python3 modify_policy.py
