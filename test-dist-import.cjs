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
    if (!commCjs.HierarchicalMessageBus || !commCjs.globalHierarchicalMessageBus || !commCjs.ClusterTopologyManager || !commCjs.globalClusterTopologyManager) {
        throw new Error('CommonJS communication exports missing');
    }
    const bus = new commCjs.HierarchicalMessageBus();
    bus.registerNode({ id: 'n1', role: 'Root', layer: 'root', clusterId: 'c1' });
    if (!bus.getNode('n1')) {
        throw new Error('CommonJS HierarchicalMessageBus registration failed');
    }
    const cjsTopMgr = new commCjs.ClusterTopologyManager();
    const cjsTop = cjsTopMgr.discoverTopology({
        specialists: [{ id: 's1', role: 'Security Specialist' }]
    });
    if (!cjsTop.pods['security-pod']) {
        throw new Error('CommonJS ClusterTopologyManager auto-discovery failed');
    }
    console.log('✓ CJS communication subpath, HierarchicalMessageBus, and ClusterTopologyManager verified');
    console.log('✓ CJS tools, parser, and client subpaths verified');

    const vecCjs = require('./dist/swarm/vectorIndex.cjs');
    if (!vecCjs.VpTreeIndex || !vecCjs.HnswVectorIndex || !vecCjs.createVectorIndex) {
        throw new Error('CommonJS vectorIndex exports missing');
    }
    const cjsIdx = vecCjs.createVectorIndex('vptree', { metric: 'cosine' });
    cjsIdx.insert('c1', [1, 0, 0], { name: 'cjs-v1' });
    const cjsHits = cjsIdx.search([0.9, 0.1, 0], { k: 1 });
    if (cjsHits.length !== 1 || cjsHits[0].id !== 'c1') {
        throw new Error('CommonJS VpTreeIndex search failed');
    }
    console.log('✓ CJS vectorIndex subpath, VpTreeIndex, and HnswVectorIndex verified');

    const specCjs = require('./dist/swarm/speculative.cjs');
    if (!specCjs.DependencyGraph || !specCjs.ConflictResolver || !specCjs.SpeculativeExecutionCoordinator) {
        throw new Error('CommonJS speculative exports missing');
    }
    const cjsDep = new specCjs.DependencyGraph();
    cjsDep.addNode({ id: 'cjs-task-1', chunkIndex: 0, dependencies: [], payload: 'Task 1' });
    cjsDep.addNode({ id: 'cjs-task-2', chunkIndex: 1, dependencies: [], payload: 'Task 2' });
    const cjsBatches = cjsDep.getExecutionBatches();
    if (cjsBatches.length !== 1 || cjsBatches[0].length !== 2) {
        throw new Error('CommonJS DependencyGraph parallel batching failed');
    }
    const cjsResolver = new specCjs.ConflictResolver();
    const cjsConflicts = cjsResolver.detectConflicts([
        {
            role: 'Analyst 1',
            insights: ['Identical finding on server performance nominal']
        },
        {
            role: 'Analyst 2',
            insights: ['Identical finding on server performance nominal']
        }
    ]);
    if (cjsConflicts.length === 0 || cjsConflicts[0].conflictType !== 'duplicate') {
        throw new Error('CommonJS ConflictResolver duplicate detection failed');
    }
    console.log('✓ CJS speculative subpath, DependencyGraph, and ConflictResolver verified');

    console.log('✓ ALL COMMONJS SWARM DISTRIBUTION TESTS PASSED!\n');
}

testCjsImport().catch(err => {
    console.error('CJS test failed:', err);
    process.exit(1);
});
