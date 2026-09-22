import { MemoryCortex } from './src/swarm/memory.js';

async function run() {
    const memory = new MemoryCortex({});
    memory.isAvailable = false; // test ephemeral fallback for now since qdrant might not be up

    const items = [];
    for (let i = 0; i < 1000; i++) {
        items.push({
            content: "benchmark content " + i,
            metadata: { qualityRating: 0.8 },
            id: "id-" + i,
            denseVector: [0.1, 0.2, 0.3], // avoid safeEmbed network calls
        });
    }

    const start = performance.now();
    await memory.importMemories(items, { deduplicate: false });
    const end = performance.now();

    console.log(`Time taken: ${end - start} ms`);
}

run();
