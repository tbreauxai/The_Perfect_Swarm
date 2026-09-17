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

    const toolsCjs = require('./dist/swarm/tools.cjs');
    const parserCjs = require('./dist/swarm/parser.cjs');
    const clientCjs = require('./dist/swarm/client.cjs');
    if (!toolsCjs.ToolRegistry || !parserCjs.repairJson || !parserCjs.parseJsonSafe || !clientCjs.createSwarmClient) {
        throw new Error('CommonJS tools, parser, or client exports missing');
    }
    const client = clientCjs.createSwarmClient({ mode: 'embedded', appId: 'cjs-app' });
    if (!client || client.mode !== 'embedded') {
        throw new Error('CommonJS createSwarmClient failed to initialize');
    }
    const repairedCjs = parserCjs.parseJsonSafe('{ status: True, val: 99, }');
    if (!repairedCjs || repairedCjs.status !== true || repairedCjs.val !== 99) {
        throw new Error('CommonJS parser failed safe repair');
    }

    const commCjs = require('./dist/swarm/communication.cjs');
    if (!commCjs.HierarchicalMessageBus || !commCjs.globalHierarchicalMessageBus) {
        throw new Error('CommonJS communication exports missing');
    }
    const bus = new commCjs.HierarchicalMessageBus();
    bus.registerNode({ id: 'n1', role: 'Root', layer: 'root', clusterId: 'c1' });
    if (!bus.getNode('n1')) {
        throw new Error('CommonJS HierarchicalMessageBus registration failed');
    }
    console.log('✓ CJS communication subpath and HierarchicalMessageBus verified');
    console.log('✓ CJS tools, parser, and client subpaths verified');

    console.log('✓ ALL COMMONJS SWARM DISTRIBUTION TESTS PASSED!\n');
}

testCjsImport().catch(err => {
    console.error('CJS test failed:', err);
    process.exit(1);
});
