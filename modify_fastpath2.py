import sys

def modify():
    with open("src/swarm/engine/fastPath.ts", "r") as f:
        content = f.read()

    search = """                    finalInsightSnippet: typeof finalAnalysis === 'string' ? finalAnalysis.slice(0, 150) : (finalAnalysis?.ui_title || JSON.stringify(finalAnalysis).slice(0, 150)),
                    inputData: data
                });"""
    replace = """                    finalInsightSnippet: typeof finalAnalysis === 'string' ? finalAnalysis.slice(0, 150) : (finalAnalysis?.ui_title || JSON.stringify(finalAnalysis).slice(0, 150)),
                    inputData: data,
                    parametersUsed: globalFeedbackEngine.getPolicyOptimizer().getBestPolicy()
                });"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/fastPath.ts", "w") as f:
            f.write(content)
        print("Success fastPath")
    else:
        print("Search not found in fastPath")

modify()
