import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryCortex } from '../../dist/swarm/memory.js';

const FALLBACK_DIR = path.resolve(process.cwd(), '.swarm');
const FALLBACK_STORE_FILE = path.join(FALLBACK_DIR, 'cortex-store.json');

export async function hydrateLocalFallbackIfOffline(cortex) {
    if (!cortex.isQdrantAvailable && fs.existsSync(FALLBACK_STORE_FILE)) {
        try {
            const raw = fs.readFileSync(FALLBACK_STORE_FILE, 'utf8');
            if (raw.trim().length > 0) {
                await cortex.importMemories(raw, { deduplicate: false });
            }
        } catch {
            // Ignore corrupted local fallback
        }
    }
}

export async function persistLocalFallbackIfOffline(cortex) {
    if (!cortex.isQdrantAvailable) {
        try {
            const snapshotJson = await cortex.exportJson();
            if (!fs.existsSync(FALLBACK_DIR)) {
                fs.mkdirSync(FALLBACK_DIR, { recursive: true });
            }
            fs.writeFileSync(FALLBACK_STORE_FILE, snapshotJson, 'utf8');
        } catch {
            // Ignore write errors
        }
    }
}

export async function runExportMemory(rawArgs) {
    let appId = undefined;
    let outPath = 'memories.jsonl';
    let minRating = undefined;
    let format = undefined;
    let qdrantUrl = undefined;
    let qdrantKey = undefined;

    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--app' && rawArgs[i + 1]) {
            appId = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--out' && rawArgs[i + 1]) {
            outPath = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--min-rating' && rawArgs[i + 1]) {
            minRating = parseFloat(rawArgs[i + 1]);
            i++;
        } else if (rawArgs[i] === '--format' && rawArgs[i + 1]) {
            format = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--qdrant-url' && rawArgs[i + 1]) {
            qdrantUrl = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--qdrant-key' && rawArgs[i + 1]) {
            qdrantKey = rawArgs[i + 1];
            i++;
        }
    }

    if (!format) {
        format = outPath.endsWith('.json') ? 'json' : 'jsonl';
    }

    console.log(`\n[PerfectSwarm Memory] Exporting memories (app: ${appId || 'all'}, minRating: ${minRating ?? 'none'}, format: ${format})...`);

    const cortex = new MemoryCortex({
        defaultAppId: appId || 'perfect-swarm',
        qdrantUrl: qdrantUrl || process.env.QDRANT_URL,
        apiKey: qdrantKey || process.env.QDRANT_API_KEY
    });
    await hydrateLocalFallbackIfOffline(cortex);

    const serialized = format === 'json'
        ? await cortex.exportJson({ appId, minRating })
        : await cortex.exportJsonl({ appId, minRating });

    const resolvedOut = path.resolve(process.cwd(), outPath);
    const outDir = path.dirname(resolvedOut);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(resolvedOut, serialized, 'utf8');

    let recordCount = 0;
    if (format === 'json') {
        try {
            const parsed = JSON.parse(serialized);
            recordCount = parsed.memories && Array.isArray(parsed.memories) ? parsed.memories.length : (Array.isArray(parsed) ? parsed.length : 0);
        } catch {
            recordCount = 0;
        }
    } else {
        recordCount = serialized.trim().length > 0 ? serialized.trim().split('\n').length : 0;
    }

    console.log(`[PerfectSwarm Memory] ✓ Exported ${recordCount} memory records to ${resolvedOut} (${serialized.length} bytes)\n`);
}

export async function runImportMemory(filePath, rawArgs) {
    if (!filePath) {
        console.error('Error: Please specify the snapshot file path: perfect-swarm import-memory <file.jsonl>');
        process.exit(1);
    }

    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
        console.error(`Error: Memory snapshot file not found: ${resolvedPath}`);
        process.exit(1);
    }

    let targetAppId = undefined;
    let deduplicate = true;
    let format = 'auto';
    let qdrantUrl = undefined;
    let qdrantKey = undefined;

    for (let i = 0; i < rawArgs.length; i++) {
        if ((rawArgs[i] === '--app' || rawArgs[i] === '--target-app') && rawArgs[i + 1]) {
            targetAppId = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--no-dedup') {
            deduplicate = false;
        } else if (rawArgs[i] === '--format' && rawArgs[i + 1]) {
            format = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--qdrant-url' && rawArgs[i + 1]) {
            qdrantUrl = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--qdrant-key' && rawArgs[i + 1]) {
            qdrantKey = rawArgs[i + 1];
            i++;
        }
    }

    const rawData = fs.readFileSync(resolvedPath, 'utf8');
    console.log(`\n[PerfectSwarm Memory] Importing snapshot from ${resolvedPath} (${rawData.length} bytes, targetApp: ${targetAppId || 'original'}, deduplicate: ${deduplicate})...`);

    const cortex = new MemoryCortex({
        defaultAppId: targetAppId || 'perfect-swarm',
        qdrantUrl: qdrantUrl || process.env.QDRANT_URL,
        apiKey: qdrantKey || process.env.QDRANT_API_KEY
    });
    await hydrateLocalFallbackIfOffline(cortex);

    const stats = await cortex.importMemories(rawData, {
        targetAppId,
        deduplicate,
        format
    });
    await persistLocalFallbackIfOffline(cortex);

    const total = stats.imported + stats.skipped + stats.deduplicated;
    console.log(`[PerfectSwarm Memory] ✓ Import completed:`);
    console.log(`  - Total Processed: ${total}`);
    console.log(`  - Imported:        ${stats.imported}`);
    console.log(`  - Skipped (dedup): ${stats.deduplicated}`);
    if (stats.skipped > 0) {
        console.log(`  - Invalid/Ignored: ${stats.skipped}`);
    }
    console.log('');
}
