cat << 'INNER_EOF' > modify_types.py
import sys

def modify():
    with open("src/swarm/types.ts", "r") as f:
        content = f.read()

    search = """export interface SwarmOptimizationSettings {
    enabled?: boolean;"""

    replace = """export interface SwarmOptimizationSettings {
    enabled?: boolean;
    compressionTargetReductionRatio?: number;"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/types.ts", "w") as f:
            f.write(content)
        print("Success types")
    else:
        print("Search not found in types")

modify()
INNER_EOF
python3 modify_types.py
