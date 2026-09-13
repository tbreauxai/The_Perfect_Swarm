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

    console.log('\n✓ ALL CLI TESTS PASSED SUCCESSFULLY!\n');
}

testCli().catch(err => {
    console.error('CLI test failed:', err);
    process.exit(1);
});
