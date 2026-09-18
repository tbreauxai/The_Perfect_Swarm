import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function testCli() {
    console.log('\n=== Testing Perfect Swarm CLI Utility ===');

    // 1. Test CLI Help
    console.log('\n[CLI Test 1] Testing --help...');
    const helpOutput = execSync('node bin/cli.js --help', { encoding: 'utf8' });
    if (!helpOutput.includes('Usage: perfect-swarm')) {
        throw new Error('CLI --help output mismatch');
    }
    console.log('✓ --help verified.');

    // 2. Test CLI Doctor
    console.log('\n[CLI Test 2] Testing doctor...');
    const doctorOutput = execSync('node bin/cli.js doctor', { encoding: 'utf8' });
    if (!doctorOutput.includes('Perfect Swarm Diagnostic Doctor') || !doctorOutput.includes('Memory Cortex Vector Engine')) {
        throw new Error('CLI doctor output mismatch');
    }
    console.log('✓ doctor verified.');

    // 3. Test CLI Init Scaffolding
    console.log('\n[CLI Test 3] Testing init scaffolding...');
    const testAppDir = path.resolve(process.cwd(), '.test-scaffolded-app');
    if (fs.existsSync(testAppDir)) {
        fs.rmSync(testAppDir, { recursive: true, force: true });
    }

    try {
        const initOutput = execSync(`node bin/cli.js init my-analytics-app .test-scaffolded-app`, { encoding: 'utf8' });
        console.log(initOutput);

        const expectedFiles = ['package.json', 'swarm.config.json', 'index.js', '.env.example'];
        for (const file of expectedFiles) {
            const filePath = path.join(testAppDir, file);
            if (!fs.existsSync(filePath)) {
                throw new Error(`Scaffolded file missing: ${file}`);
            }
            console.log(`✓ Generated ${file}`);
        }

        const config = JSON.parse(fs.readFileSync(path.join(testAppDir, 'swarm.config.json'), 'utf8'));
        if (config.appId !== 'my-analytics-app') {
            throw new Error(`Config appId mismatch: expected 'my-analytics-app', got '${config.appId}'`);
        }
    } finally {
        if (fs.existsSync(testAppDir)) {
            fs.rmSync(testAppDir, { recursive: true, force: true });
            console.log('✓ Cleaned up scaffolded test directory');
        }
    }

    // 4. Test CLI Run (instant fast-path task with --mock)
    console.log('\n[CLI Test 4] Testing run task...');
    const runOutput = execSync('node bin/cli.js run "Check server uptime" --data "uptime=99.99" --app "cli-test" --mock', { encoding: 'utf8' });
    console.log(runOutput);
    if (!runOutput.includes('Fast Analysis: Check server uptime')) {
        throw new Error('CLI run command failed to execute fast-path workflow');
    }
    console.log('✓ CLI run command verified.');

    // 5. Test CLI Memory Export & Import
    console.log('\n[CLI Test 5] Testing memory export and import...');
    const snapshotFile = path.resolve(process.cwd(), '.test-cli-snapshot.jsonl');
    const exportedFile = path.resolve(process.cwd(), '.test-cli-export.json');

    try {
        const dummyMemories = [
            {
                id: 'cli-mem-1',
                content: 'System cache eviction interval configured to 300s.',
                metadata: { domain: 'caching', qualityRating: 0.92, verified: true, appId: 'cli-seed-app' }
            },
            {
                id: 'cli-mem-2',
                content: 'Database connection pool max clients set to 50.',
                metadata: { domain: 'database', qualityRating: 0.88, verified: true, appId: 'cli-seed-app' }
            }
        ];
        fs.writeFileSync(snapshotFile, dummyMemories.map(m => JSON.stringify(m)).join('\n'), 'utf8');

        // Import snapshot into hydrated-cli-app
        const importOutput = execSync(`node bin/cli.js import-memory "${snapshotFile}" --target-app "hydrated-cli-app"`, { encoding: 'utf8' });
        console.log(importOutput);
        if (!importOutput.includes('Import completed') || !importOutput.includes('Imported:        2')) {
            throw new Error('CLI import-memory failed or did not import 2 items');
        }
        console.log('✓ CLI import-memory verified.');

        // Test deduplication on re-import
        const dedupOutput = execSync(`node bin/cli.js import-memory "${snapshotFile}" --target-app "hydrated-cli-app"`, { encoding: 'utf8' });
        console.log(dedupOutput);
        if (!dedupOutput.includes('Skipped (dedup): 2')) {
            throw new Error('CLI import-memory deduplication check failed');
        }
        console.log('✓ CLI deduplication verified.');

        // Export memories from hydrated-cli-app to JSON format
        const exportOutput = execSync(`node bin/cli.js export-memory --app "hydrated-cli-app" --out "${exportedFile}" --format json`, { encoding: 'utf8' });
        console.log(exportOutput);
        if (!fs.existsSync(exportedFile)) {
            throw new Error('CLI export-memory failed to write output file');
        }
        const exportedJson = JSON.parse(fs.readFileSync(exportedFile, 'utf8'));
        if (!exportedJson.memories || exportedJson.memories.length !== 2) {
            throw new Error('CLI exported memories count mismatch');
        }
        console.log('✓ CLI export-memory verified.');
    } finally {
        if (fs.existsSync(snapshotFile)) fs.rmSync(snapshotFile, { force: true });
        if (fs.existsSync(exportedFile)) fs.rmSync(exportedFile, { force: true });
        const localSwarmDir = path.resolve(process.cwd(), '.swarm');
        if (fs.existsSync(localSwarmDir)) fs.rmSync(localSwarmDir, { recursive: true, force: true });
        console.log('✓ Cleaned up CLI snapshot test files');
    }

    // 6. Test CLI Bench & Profile
    console.log('\n[CLI Test 6] Testing bench & profile...');
    const benchOutput = execSync('node bin/cli.js bench --iterations 3 --batch-size 2', { encoding: 'utf8' });
    console.log(benchOutput);
    if (!benchOutput.includes('Baseline Profiling Summary') || !benchOutput.includes('ops/sec') || !benchOutput.includes('Baseline Profiling & Metrics Collection completed successfully')) {
        throw new Error('CLI bench command failed to execute baseline profiler');
    }
    console.log('✓ CLI bench command verified.');

    console.log('\n✓ ALL CLI TESTS PASSED SUCCESSFULLY!\n');
}

testCli().catch(err => {
    console.error('CLI test failed:', err);
    process.exit(1);
});
