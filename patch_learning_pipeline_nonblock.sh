cat << 'INNER_EOF' > modify_learning_pipeline_nonblock.py
import sys

def modify():
    with open("src/swarm/engine/learningPipeline.ts", "r") as f:
        content = f.read()

    search = """        try {
            const storedId = await memoryCortex.store(content, meta);
            if (params.onMemoryLearned) {
                params.onMemoryLearned({
                    appId: writeOriginApp,
                    content,
                    id: storedId,
                    metadata: meta
                });
            }
        } catch (err: any) {
            console.warn(`[Swarm] Memory storage failed:`, err);
        }"""

    replace = """        try {
            memoryCortex.store(content, meta).then(storedId => {
                if (params.onMemoryLearned && storedId) {
                    params.onMemoryLearned({
                        appId: writeOriginApp,
                        content,
                        id: storedId,
                        metadata: meta
                    });
                }
            }).catch((err: any) => {
                console.warn(`[Swarm] Memory storage failed:`, err);
            });
        } catch (err: any) {
            console.warn(`[Swarm] Memory storage setup failed:`, err);
        }"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/engine/learningPipeline.ts", "w") as f:
            f.write(content)
        print("Success learningPipeline")
    else:
        print("Search not found in learningPipeline")

modify()
INNER_EOF
python3 modify_learning_pipeline_nonblock.py
