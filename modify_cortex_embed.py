import sys

def modify():
    with open("src/swarm/memory/cortex.ts", "r") as f:
        content = f.read()

    search = """    private async safeEmbed(text: string): Promise<number[]> {
        try {
            return await this.embeddingProvider.embed(text);
        } catch (err: any) {
            console.warn(`[MemoryCortex] Primary embedding provider failed (${err.message || String(err)}). Permanently downgrading to DeterministicLocalEmbeddingProvider.`);
            this.embeddingProvider = new DeterministicLocalEmbeddingProvider();
            return await this.embeddingProvider.embed(text);
        }
    }"""

    replace = """    private async safeEmbed(text: string): Promise<number[]> {
        try {
            return await this.embeddingProvider.embed(text);
        } catch (err: any) {
            console.warn(`[MemoryCortex] Primary embedding provider failed (${err.message || String(err)}). Using DeterministicLocalEmbeddingProvider fallback for this request only.`);
            const fallbackEmbedder = new DeterministicLocalEmbeddingProvider();
            return await fallbackEmbedder.embed(text);
        }
    }"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/memory/cortex.ts", "w") as f:
            f.write(content)
        print("Success cortex embed")
    else:
        print("Search not found in cortex embed")

modify()
