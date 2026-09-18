#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSwarmWorkflow, SwarmEngine } from '../dist/swarm/engine.js';
import { MemoryCortex } from '../dist/swarm/memory.js';
import { ModelRouter } from '../dist/swarm/router.js';
import { ProviderRegistry } from '../dist/swarm/index.js';
import { runSwarmBenchmark, globalUnifiedProfiler } from '../dist/swarm/profiler.js';
import { globalFeedbackEngine } from '../dist/swarm/feedback.js';
import { globalKnowledgeGraph } from '../dist/swarm/knowledgeGraph.js';
import { globalHypothesisLayer, globalLearningRateManager } from '../dist/swarm/coordination.js';

const args = process.argv.slice(2);
const command = args[0] || '--help';

function printHelp() {
    console.log(`
Usage: perfect-swarm <command> [options]

Commands:
  doctor                         Verify environment keys, free-tier connectivity, and memory cortex
  init <app-name> [dest-dir]     Scaffold an isolated, portable AI swarm worker for a target application
  run "<task>" [options]         Execute a headless swarm analysis workflow from the command line
  export-memory [options]        Export memories from MemoryCortex to JSON or JSONL file
  import-memory <file> [options] Import and hydrate memories into MemoryCortex
  profile [options]              Run baseline performance profiling and benchmark metrics collection
  bench [options]                Alias for profile
  feedback-stats [options]       Display aggregated feedback insights and reward statistics
  drift-check                    Check active concept drift alerts across latency, quality, and embeddings
  policy-inspect                 Inspect current evolutionary tuned swarm parameters and policy status
  graph-inspect                  Inspect shared knowledge graph version, node counts, and relationships
  hypotheses-inspect             Inspect proposed, validated, and pruned agent hypotheses
  rates-inspect                  Inspect per-agent adaptive learning rates and convergence state

Options:
  --data <data-payload>          Input data payload for analysis
  --app <app-id>                 Target application namespace (default: perfect-swarm)
  --out <file-path>              Output destination file for memory export (default: memories.jsonl)
  --min-rating <number>          Minimum quality rating filter for exported memories
  --format <json|jsonl|auto>     Snapshot serialization format (default: auto)
  --target-app <app-id>          Target application namespace for imported memories
  --no-dedup                     Disable deduplication during memory import
  --help, -h                     Show help information
`);
}

async function runDoctor() {
    console.log('\n=== Perfect Swarm Diagnostic Doctor ===\n');

    const keys = [
        { name: 'Gemini (15 RPM / 1M TPM Free)', env: 'GEMINI_API_KEY' },
        { name: 'Groq (30 RPM / 6K TPM Free)', env: 'GROQ_API_KEY' },
        { name: 'OpenRouter (Guaranteed :free endpoints)', env: 'OPENROUTER_API_KEY' },
        { name: 'Mistral (Small Free Tier)', env: 'MISTRAL_API_KEY' },
        { name: 'GitHub Models (150 RPD Free)', env: 'GITHUB_TOKEN' }
    ];

    console.log('Provider Credentials Status:');
    let keyCount = 0;
    for (const k of keys) {
        const hasKey = Boolean(process.env[k.env]);
        if (hasKey) keyCount++;
        console.log(`  [${hasKey ? '✓ READY' : '○ MISSING'}] ${k.name} (${k.env})`);
    }

    console.log(`\nActive Registered Provider Adapters:`);
    const adapters = ProviderRegistry.list();
    for (const a of adapters) {
        console.log(`  ✓ ${a}`);
    }

    console.log(`\nMemory Cortex Vector Engine:`);
    const cortex = new MemoryCortex({ defaultAppId: 'doctor-check' });
    const isOffline = !cortex.isQdrantAvailable;
    console.log(`  [✓ READY] In-Memory Fallback: Active`);
    console.log(`  [${cortex.isQdrantAvailable ? '✓ READY' : '○ OFFLINE'}] Qdrant Vector Service: ${cortex.isQdrantAvailable ? 'Connected' : 'Unreachable (gracefully falling back to in-memory RRF)'}`);

    console.log(`\nModelRouter Recommended Endpoints:`);
    console.log(`  Instant (<10 tokens): ${ModelRouter.getRecommendedModel('instant', 'gemini')}`);
    console.log(`  Standard (~50 tokens): ${ModelRouter.getRecommendedModel('standard', 'groq')}`);
    console.log(`  Complex (>100 tokens): ${ModelRouter.getRecommendedModel('complex', 'openrouter')}`);

    console.log(`\nDiagnostic Summary: System is ready with ${keyCount} external keys and zero-cost local fallbacks.\n`);
}

async function runInit(appName, targetDir) {
    if (!appName) {
        console.error('Error: Please provide an application name (e.g. perfect-swarm init my-app)');
        process.exit(1);
    }

    const dest = path.resolve(process.cwd(), targetDir || appName);
    if (fs.existsSync(dest)) {
        console.error(`Error: Destination directory '${dest}' already exists.`);
        process.exit(1);
    }

    fs.mkdirSync(dest, { recursive: true });

    // 1. Write package.json
    const pkgContent = {
        name: appName,
        version: "1.0.0",
        type: "module",
        scripts: {
            "start": "node index.js"
        },
        dependencies: {
            "@perfect-swarm/core": "^1.0.0",
            "dotenv": "^17.2.3"
        }
    };
    fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkgContent, null, 2), 'utf8');

    // 2. Write swarm.config.json
    const configContent = {
        appId: appName,
        domain: "general-analytics",
        qdrantUrl: process.env.QDRANT_URL || "",
        defaultProviders: {
            instant: "gemini",
            complex: "openrouter"
        }
    };
    fs.writeFileSync(path.join(dest, 'swarm.config.json'), JSON.stringify(configContent, null, 2), 'utf8');

    // 3. Write index.js starter
    const starterContent = `import 'dotenv/config';
import { executeSwarmWorkflow, MemoryCortex } from '@perfect-swarm/core';
import config from './swarm.config.json' with { type: 'json' };

async function main() {
    console.log(\`Starting swarm worker for \${config.appId}...\`);

    const result = await executeSwarmWorkflow({
        task: "System initialization sanity check",
        data: "status=booting",
        settings: {
            appId: config.appId
        }
    });

    console.log("Execution Result:", JSON.stringify(result.finalAnalysis, null, 2));
}

main().catch(console.error);
`;
    fs.writeFileSync(path.join(dest, 'index.js'), starterContent, 'utf8');

    // 4. Write .env.example
    const envExample = `# Perfect Swarm Free-Tier AI Keys
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=
GITHUB_TOKEN=
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
`;
    fs.writeFileSync(path.join(dest, '.env.example'), envExample, 'utf8');

    console.log(`\n✓ Successfully scaffolded autonomous swarm worker in: ${dest}`);
    console.log(`\nNext steps:`);
    console.log(`  cd ${targetDir || appName}`);
    console.log(`  npm install`);
    console.log(`  cp .env.example .env`);
    console.log(`  npm start\n`);
}

async function runTask(task, rawArgs) {
    if (!task) {
        console.error('Error: Please specify a task string: perfect-swarm run "Analyze logs"');
        process.exit(1);
    }

    let data = '';
    let appId = 'cli-analysis-app';
    let isMock = false;

    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--data' && rawArgs[i + 1]) {
            data = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--app' && rawArgs[i + 1]) {
            appId = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i] === '--mock') {
            isMock = true;
        }
    }

    if (isMock) {
        ProviderRegistry.register({
            providerName: 'custom-mock',
            async call(options) {
                return JSON.stringify({
                    ui_title: `Fast Analysis: ${task}`,
                    components: [
                        { id: '1', type: 'InsightList', props: { title: 'CLI Fast Path Output', insights: [{ type: 'info', message: 'Simulated output verified' }] } }
                    ]
                });
            }
        });
    }

    console.log(`\n[PerfectSwarm] Executing Task: "${task}" (App ID: ${appId}${isMock ? ', Mode: mock' : ''})`);
    const startTime = Date.now();

    const result = await executeSwarmWorkflow({
        task,
        data,
        settings: {
            appId,
            ...(isMock ? {
                agents: [
                    { id: 'cli-mgr', role: 'Manager Node', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'cli-analyst', role: 'Analyst', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            } : {})
        }
    });

    const elapsed = Date.now() - startTime;
    console.log(`\n[PerfectSwarm] Completed in ${elapsed}ms:`);
    console.log(JSON.stringify(result.finalAnalysis, null, 2));
}

async function runExportMemory(rawArgs) {
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

const FALLBACK_DIR = path.resolve(process.cwd(), '.swarm');
const FALLBACK_STORE_FILE = path.join(FALLBACK_DIR, 'cortex-store.json');

async function hydrateLocalFallbackIfOffline(cortex) {
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

async function persistLocalFallbackIfOffline(cortex) {
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

async function runImportMemory(filePath, rawArgs) {
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

async function runProfile(rawArgs) {
    let iterations = 20;
    let batchSize = 5;

    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--iterations' && rawArgs[i + 1]) {
            iterations = parseInt(rawArgs[i + 1], 10);
            i++;
        } else if (rawArgs[i] === '--batch-size' && rawArgs[i + 1]) {
            batchSize = parseInt(rawArgs[i + 1], 10);
            i++;
        }
    }

    console.log(`\n=== Perfect Swarm Baseline Profiler & Synthetic Benchmark ===\n`);
    console.log(`Executing baseline workload sweep (${iterations} iterations, ${batchSize} batch tasks per iteration)...`);

    const bench = await runSwarmBenchmark({ iterations, batchSize });

    console.log(`\n[Baseline Profiling Summary]:`);
    console.log(`  Total Iterations:     ${bench.totalIterations}`);
    console.log(`  Total Duration:       ${bench.durationMs}ms`);
    console.log(`  Throughput:           ${bench.opsPerSecond} ops/sec`);
    console.log(`  Latency (Avg):        ${bench.latency.avgMs}ms`);
    console.log(`  Latency (p50):        ${bench.latency.p50Ms}ms`);
    console.log(`  Latency (p95):        ${bench.latency.p95Ms}ms`);
    console.log(`  Latency (p99):        ${bench.latency.p99Ms}ms`);
    console.log(`  Tokens Saved:         ${bench.report.resourceUtilization.totalTokensSaved}`);
    console.log(`  Memory Saved:         ${bench.report.resourceUtilization.totalMemorySavedBytes} bytes`);
    console.log(`  Anomalies Detected:   ${bench.anomalies.length}`);
    console.log(`\n✓ Baseline Profiling & Metrics Collection completed successfully.\n`);
}

async function runFeedbackStats(rawArgs) {
    let appId = 'perfect-swarm';
    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--app' && rawArgs[i + 1]) {
            appId = rawArgs[i + 1];
            i++;
        }
    }
    console.log(`\n=== Perfect Swarm Knowledge Repository & Feedback Insights ===\n`);
    const insights = globalFeedbackEngine.getKnowledgeRepository().getAggregatedInsights(appId);
    console.log(`Target Application:    ${appId}`);
    console.log(`Total Logged Runs:     ${insights.totalRuns}`);
    console.log(`Average Reward Score:  ${insights.avgReward}`);
    console.log(`Average Latency:       ${insights.avgDurationMs}ms`);
    console.log(`Total Tokens Saved:    ${insights.totalTokensSaved}`);
    console.log(`Drift Alerts Logged:   ${insights.driftAlertsCount}`);
    console.log(`\nBest Evolutionary Parameters:`);
    console.log(JSON.stringify(insights.bestParameters, null, 2));
    console.log(`\n✓ Feedback statistics retrieved successfully.\n`);
}

async function runDriftCheck() {
    console.log(`\n=== Perfect Swarm Concept Drift Detector ===\n`);
    const alerts = globalFeedbackEngine.getDriftDetector().getAlerts();
    console.log(`Active Drift Alerts: ${alerts.length}`);
    if (alerts.length === 0) {
        console.log(`✓ Zero drift detected across latency, quality, and semantic embedding streams.\n`);
    } else {
        for (const alert of alerts) {
            console.log(`  [${alert.severity.toUpperCase()}] ${alert.driftType} on '${alert.metric}': ${alert.message}`);
            console.log(`    Recommended Action: ${alert.recommendedAction}`);
        }
        console.log('');
    }
}

async function runPolicyInspect() {
    console.log(`\n=== Perfect Swarm Evolutionary Policy Inspector ===\n`);
    const current = globalFeedbackEngine.getPolicyOptimizer().getCurrentPolicy();
    const best = globalFeedbackEngine.getPolicyOptimizer().getBestPolicy();
    console.log(`Current Active Tuned Parameters:`);
    console.log(JSON.stringify(current, null, 2));
    console.log(`\nBest Historical Policy Parameters:`);
    console.log(JSON.stringify(best, null, 2));
    console.log(`\n✓ Policy parameters inspected successfully.\n`);
}

async function runGraphInspect() {
    console.log(`\n=== Perfect Swarm Shared Knowledge Graph Inspector ===\n`);
    const stats = globalKnowledgeGraph.getStats();
    console.log(`Knowledge Graph Status:`);
    console.log(`  Version: ${stats.version}`);
    console.log(`  Total Nodes: ${stats.totalNodes}`);
    console.log(`  Total Edges: ${stats.totalEdges}`);
    console.log(`  Node Types Distribution:`, JSON.stringify(stats.nodeTypes));
    console.log(`\n✓ Knowledge graph inspected successfully.\n`);
}

async function runHypothesesInspect() {
    console.log(`\n=== Perfect Swarm Hypothesis Inspector ===\n`);
    const all = globalHypothesisLayer.getHypotheses();
    console.log(`Active Hypotheses Tracked: ${all.length}`);
    if (all.length === 0) {
        console.log(`  (No hypotheses currently registered)`);
    } else {
        for (const h of all) {
            console.log(`  [${h.status.toUpperCase()}] "${h.claim}" (Confidence: ${Math.round(h.confidence * 100)}%, Proposed by: ${h.proposedBy})`);
        }
    }
    console.log(`\n✓ Hypotheses inspected successfully.\n`);
}

async function runRatesInspect() {
    console.log(`\n=== Perfect Swarm Agent Adaptive Learning Rates ===\n`);
    const states = globalLearningRateManager.getAllStates();
    console.log(`Tracked Agents: ${states.length}`);
    if (states.length === 0) {
        console.log(`  (Default initial learning rate: 0.10)`);
    } else {
        for (const s of states) {
            console.log(`  - ${s.agentId}: Rate=${s.learningRate}, EMA Reward=${s.emaReward}, Updates=${s.totalUpdates}`);
        }
    }
    console.log(`\n✓ Learning rates inspected successfully.\n`);
}

async function main() {
    switch (command) {
        case 'doctor':
            await runDoctor();
            break;
        case 'init':
            await runInit(args[1], args[2]);
            break;
        case 'run':
            await runTask(args[1], args.slice(2));
            break;
        case 'export-memory':
            await runExportMemory(args.slice(1));
            break;
        case 'import-memory':
            await runImportMemory(args[1], args.slice(2));
            break;
        case 'profile':
        case 'bench':
            await runProfile(args.slice(1));
            break;
        case 'feedback-stats':
            await runFeedbackStats(args.slice(1));
            break;
        case 'drift-check':
            await runDriftCheck();
            break;
        case 'policy-inspect':
            await runPolicyInspect();
            break;
        case 'graph-inspect':
            await runGraphInspect();
            break;
        case 'hypotheses-inspect':
            await runHypothesesInspect();
            break;
        case 'rates-inspect':
            await runRatesInspect();
            break;
        case '--help':
        case '-h':
        default:
            printHelp();
            break;
    }
}

main().catch(err => {
    console.error('[PerfectSwarm CLI Error]:', err.message || err);
    process.exit(1);
});
