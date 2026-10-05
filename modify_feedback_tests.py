import sys

def modify():
    with open("src/swarm/feedback.test.ts", "r") as f:
        content = f.read()

    search1 = """        optimizer.updateWithFeedback(baselineReward);"""
    replace1 = """        optimizer.updateWithFeedback(baselineReward, optimizer.getCurrentPolicy());"""

    search2 = """        const res = optimizer.updateWithFeedback(superiorReward, superiorParams);"""
    replace2 = """        const res = optimizer.updateWithFeedback(superiorReward, superiorParams, superiorParams);"""

    content = content.replace(search1, replace1)
    content = content.replace(search2, replace2)

    with open("src/swarm/feedback.test.ts", "w") as f:
        f.write(content)
    print("Success feedback tests")

modify()
