import sys

def modify():
    with open("src/swarm/memory-indexing.test.ts", "r") as f:
        content = f.read()

    search = """    it('scales logarithmically across large memory stores with reduced search comparisons', async () => {"""

    replace = """    it('consolidation does not delete a verified fact', async () => {
        const idFact = await cortex.store('A verified truth', { qualityRating: 0.10, memoryType: 'fact', verified: true, timestamp: Date.now() - 1000000000 });
        const idJunk = await cortex.store('An unverified judgment', { qualityRating: 0.10, memoryType: 'judgment', verified: false, timestamp: Date.now() - 1000000000 });

        const consolidation = await cortex.consolidateMemories({ minRating: 0.50, pruneLowQuality: true, maxAgeDays: 0 });

        // Unverified judgment was pruned, but verified fact was retained despite low quality and age
        expect(consolidation.prunedIds).toContain(idJunk);
        expect(consolidation.prunedIds).not.toContain(idFact);
    });

    it('scales logarithmically across large memory stores with reduced search comparisons', async () => {"""

    if search in content:
        content = content.replace(search, replace)
        with open("src/swarm/memory-indexing.test.ts", "w") as f:
            f.write(content)
        print("Success memory index test")
    else:
        print("Search not found in memory index test")

modify()
