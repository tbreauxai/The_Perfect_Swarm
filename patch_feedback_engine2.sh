cat << 'INNER_EOF' > modify_feedback_engine2.py
import sys

def modify():
    with open("src/swarm/feedback/feedbackEngine.ts", "r") as f:
        content = f.read()

    search = """        embedding?: number[];
        inputData?: any;
        agentRoles?: string[];"""

    replace = """        embedding?: number[];
        inputData?: any;
        agentRoles?: string[];
        parametersUsed?: TunableParameters;"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/feedback/feedbackEngine.ts", "w") as f:
            f.write(content)
        print("Success feedbackEngine2")
    else:
        print("Search string not found in feedbackEngine2")

modify()
INNER_EOF
python3 modify_feedback_engine2.py
