const {
    executeSwarmWorkflow,
    SwarmEngine,
    MemoryCortex,
    ModelRouter,
    ProviderRegistry,
    createSwarmServer,
    handleSwarmSse
} = require('./dist/swarm/index.cjs');
const serverCjs = require('./dist/swarm/server.cjs');

async function testCjsImport() {
    console.log('\n=== CommonJS Distribution Verification (from dist/swarm/index.cjs) ===');

    if (!executeSwarmWorkflow || !SwarmEngine || !MemoryCortex || !ModelRouter || !ProviderRegistry || !createSwarmServer || !handleSwarmSse || !serverCjs.createSwarmServer) {
        throw new Error('CommonJS export validation failed');
    }
    console.log('✓ CJS exports present and verified');

    const cortex = new MemoryCortex({ defaultAppId: 'cjs-app' });
    const id = await cortex.store('CommonJS verification memory', { domain: 'packaging', agentRole: 'CJS Tester', qualityRating: 0.99 });
    console.log('✓ CJS MemoryCortex stored point:', id);
    if (!id) throw new Error('CJS store failed');

    const res = await cortex.retrieve('CommonJS memory', { appId: 'cjs-app' });
    console.log('✓ CJS MemoryCortex retrieved point:', res[0]?.content);
    if (!res || res.length === 0) throw new Error('CJS retrieve failed');

    console.log('✓ ALL COMMONJS SWARM DISTRIBUTION TESTS PASSED!\n');
}

testCjsImport().catch(err => {
    console.error('CJS test failed:', err);
    process.exit(1);
});
