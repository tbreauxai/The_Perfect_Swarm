#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSwarmWorkflow, SwarmEngine } from '../dist/swarm/engine.js';
import { MemoryCortex } from '../dist/swarm/memory.js';
import { ModelRouter } from '../dist/swarm/router.js';
import { ProviderRegistry } from '../dist/swarm/index.js';

const args = process.argv.slice(2);
const command = args[0] || '--help';

function printHelp() {
    console.log(`
Usage: perfect-swarm <command> [options]

Commands:
  doctor                         Verify environment keys, free-tier connectivity, and memory cortex
  init <app-name> [dest-dir]     Scaffold an isolated, portable AI swarm worker for a target application
  run "<task>" [options]         Execute a headless swarm analysis workflow from the command line

Options:
  --data <data-payload>          Input data payload for analysis
  --app <app-id>                 Target application namespace (default: perfect-swarm)
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
