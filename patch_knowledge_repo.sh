cat << 'INNER_EOF' > modify_knowledge_repo.py
import sys

def modify():
    with open("src/swarm/feedback/knowledgeRepository.ts", "r") as f:
        content = f.read()

    search = """        if (!this.appIndices.has(record.appId)) {
            this.appIndices.set(record.appId, []);
        }
        const ids = this.appIndices.get(record.appId)!;
        if (!ids.includes(record.id)) {
            ids.push(record.id);
        }

        this.persistOutcome(record);
        return record.id;
    }"""

    replace = """        if (!this.appIndices.has(record.appId)) {
            this.appIndices.set(record.appId, []);
        }
        const ids = this.appIndices.get(record.appId)!;
        if (!ids.includes(record.id)) {
            ids.push(record.id);
            if (ids.length > 500) {
                const oldestId = ids.shift();
                if (oldestId) {
                    this.outcomes.delete(oldestId);
                }
            }
        }

        this.persistOutcome(record);
        return record.id;
    }"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/feedback/knowledgeRepository.ts", "w") as f:
            f.write(content)
        print("Success repo")
    else:
        print("Search not found in repo")

modify()
INNER_EOF
python3 modify_knowledge_repo.py
