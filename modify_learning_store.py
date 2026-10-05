import sys

def modify():
    with open("src/swarm/learning-persistence.ts", "r") as f:
        content = f.read()

    search = """            await withTimeout(
                this.client.upsert(this.collection, {
                    wait: true,"""
    replace = """            await withTimeout(
                this.client.upsert(this.collection, {
                    wait: false,"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/learning-persistence.ts", "w") as f:
            f.write(content)
        print("Success learning-persistence")
    else:
        print("Search not found in learning-persistence")

modify()
