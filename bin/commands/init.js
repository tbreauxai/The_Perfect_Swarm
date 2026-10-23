import * as fs from 'node:fs';
import * as path from 'node:path';

export async function runInit(appName, targetDir) {
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
