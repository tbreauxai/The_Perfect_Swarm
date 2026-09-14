import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = process.cwd();
const srcDir = path.join(projectRoot, 'src', 'swarm');
const stagingDir = path.join(projectRoot, '.swarm-dts-staging');
const outDir = path.join(projectRoot, 'dist', 'swarm');

if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

console.log('[build:swarm] 1. Running Vite library build for ESM & CJS bundles...');
execSync('npx vite build --config vite.config.swarm.ts', { stdio: 'inherit' });

console.log('[build:swarm] 2. Generating TypeScript declaration (.d.ts) files...');
if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
}

// Recursively copy src/swarm to staging directory, rewriting .ts imports to extensionless for standard d.ts generation
function copyAndRewrite(source: string, target: string) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(source, entry.name);
        const tgtPath = path.join(target, entry.name);

        if (entry.isDirectory()) {
            copyAndRewrite(srcPath, tgtPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            if (entry.name.includes('.test.')) {
                continue;
            }
            let content = fs.readFileSync(srcPath, 'utf8');
            // Rewrite local relative imports from './foo.ts' or '../foo.ts' to './foo.js' for NodeNext resolution
            content = content.replace(/(from\s+['"])(\.[^'"]*)\.ts(['"])/g, '$1$2.js$3');
            content = content.replace(/(import\s+['"])(\.[^'"]*)\.ts(['"])/g, '$1$2.js$3');
            fs.writeFileSync(tgtPath, content, 'utf8');
        } else {
            fs.copyFileSync(srcPath, tgtPath);
        }
    }
}

copyAndRewrite(srcDir, stagingDir);

// Staging tsconfig
const stagingTsConfig = path.join(projectRoot, 'tsconfig.dts.json');
fs.writeFileSync(stagingTsConfig, JSON.stringify({
    compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        declaration: true,
        emitDeclarationOnly: true,
        outDir: './dist/swarm',
        rootDir: './.swarm-dts-staging',
        skipLibCheck: true,
        strict: false
    },
    include: ['.swarm-dts-staging/**/*'],
    exclude: ['**/*.test.ts', '**/*.test.tsx']
}, null, 2), 'utf8');

try {
    execSync(`npx tsc -p "${stagingTsConfig}"`, { stdio: 'inherit' });
    console.log('[build:swarm] TypeScript declarations (.d.ts) generated successfully in dist/swarm/');
} finally {
    if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    if (fs.existsSync(stagingTsConfig)) {
        fs.rmSync(stagingTsConfig, { force: true });
    }
}

console.log('[build:swarm] Build completed successfully.');
