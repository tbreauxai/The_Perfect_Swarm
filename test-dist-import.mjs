import {
    executeSwarmWorkflow,
    SwarmEngine,
    MemoryCortex,
    ModelRouter,
    PayloadCache,
    AdaptiveLoadBalancer,
    ProviderRegistry,
    createSwarmServer,
    handleSwarmSse,
    createSwarmClient,
    HierarchicalMessageBus,
    globalHierarchicalMessageBus,
    ClusterTopologyManager,
    globalClusterTopologyManager,
    VpTreeIndex,
    HnswVectorIndex,
    createVectorIndex,
    DependencyGraph,
    ConflictResolver,
    SpeculativeExecutionCoordinator
} from './dist/swarm/index.js';
import { createSwarmServer as serverFromSubpath } from './dist/swarm/server.js';
import { createSwarmClient as clientFromSubpath } from './dist/swarm/client.js';
import { HierarchicalMessageBus as CommBusFromSubpath, ClusterTopologyManager as CommTopologyFromSubpath } from './dist/swarm/communication.js';
import { VpTreeIndex as VpTreeFromSubpath, HnswVectorIndex as HnswFromSubpath, createVectorIndex as createVectorFromSubpath } from './dist/swarm/vectorIndex.js';
import { DependencyGraph as DepGraphFromSubpath, ConflictResolver as ConflictFromSubpath, SpeculativeExecutionCoordinator as SpecCoordFromSubpath } from './dist/swarm/speculative.js';
import { ToolRegistry, calculatorTool } from './dist/swarm/tools.js';
import { repairJson, parseJsonSafe } from './dist/swarm/parser.js';

async function runDistVerification() {
    console.log('\n=== Distribution Bundle Verification (ESM from dist/swarm/index.js) ===');

    // 1. Verify exports presence
    console.log('Verifying compiled library exports:');
    if (!executeSwarmWorkflow || !SwarmEngine || !MemoryCortex || !ModelRouter || !PayloadCache || !AdaptiveLoadBalancer || !ProviderRegistry || !createSwarmServer || !handleSwarmSse || !serverFromSubpath || !createSwarmClient || !clientFromSubpath) {
        throw new Error('Missing core exports in compiled dist bundle');
    }
    const distClient = clientFromSubpath({ mode: 'embedded', appId: 'dist-client-app' });
    if (!distClient || distClient.mode !== 'embedded') {
        throw new Error('Compiled clientFromSubpath failed to initialize');
    }
    console.log('✓ All core exports and client SDK subpath verified.');

    // 2. Test compiled ModelRouter fast-path inference
    const fastDecision = ModelRouter.evaluateFastPath('ping server', '');
    console.log('✓ Compiled ModelRouter fast-path inference:', fastDecision.targetTier);
    if (fastDecision.targetTier !== 'instant') {
        throw new Error('Compiled ModelRouter failed fast-path evaluation');
    }

    // 3. Test compiled in-memory MemoryCortex
    const cortex = new MemoryCortex({ defaultAppId: 'dist-test-app' });
    const memId = await cortex.store('Compiled bundle memory storage test', {
        domain: 'packaging',
        agentRole: 'Distribution Analyst',
        qualityRating: 0.95
    });
    console.log('✓ Stored memory in compiled cortex:', memId);
    if (!memId) throw new Error('Compiled MemoryCortex store failed');

    const retrieved = await cortex.retrieve('bundle memory test', { appId: 'dist-test-app' });
    console.log('✓ Retrieved from compiled cortex:', retrieved[0]?.content);
    if (!retrieved || retrieved.length === 0) throw new Error('Compiled MemoryCortex retrieval failed');

    // 4. Register mock adapter and test compiled SwarmEngine execution
    ProviderRegistry.register({
        providerName: 'custom-mock',
        async call(options) {
            return JSON.stringify({
                ui_title: 'Fast Analysis: Production worker status',
                components: [
                    { id: '1', type: 'InsightList', props: { title: 'Health', insights: [{ type: 'info', message: 'Nominal' }] } }
                ]
            });
        }
    });

    const engineResult = await executeSwarmWorkflow({
        task: 'Ping production worker status',
        data: 'health=ok',
        settings: {
            agents: [
                { id: 'mgr', role: 'Manager Node', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-mgr' }
            ]
        }
    });
    console.log('✓ Compiled SwarmEngine execution result:', engineResult.finalAnalysis?.ui_title);
    if (!engineResult.finalAnalysis || !engineResult.finalAnalysis.ui_title) {
        throw new Error('Compiled SwarmEngine failed execution');
    }

    // 5. Verify compiled ToolRegistry and Parser subpaths
    const reg = new ToolRegistry();
    reg.register(calculatorTool);
    const toolExec = await reg.execute('calculator', { expression: '15 * 3' });
    console.log('✓ Compiled ToolRegistry execution:', toolExec);
    if (!toolExec.success || toolExec.result?.result !== 45) {
        throw new Error('Compiled ToolRegistry failed calculation');
    }

    const repaired = parseJsonSafe('{ unquoted_key: True, count: 10, }');
    console.log('✓ Compiled parser repair:', repaired);
    if (!repaired || repaired.unquoted_key !== true || repaired.count !== 10) {
        throw new Error('Compiled parser failed repair');
    }

    // 6. Verify compiled HierarchicalMessageBus and Communication subpath
    if (!HierarchicalMessageBus || !globalHierarchicalMessageBus || !CommBusFromSubpath || !ClusterTopologyManager || !globalClusterTopologyManager || !CommTopologyFromSubpath) {
        throw new Error('HierarchicalMessageBus or ClusterTopologyManager exports missing');
    }
    const testBus = new CommBusFromSubpath();
    testBus.registerNode({ id: 'mgr', role: 'Manager', layer: 'root', clusterId: 'root-pod' });
    testBus.registerNode({ id: 'sec', role: 'Security Specialist', layer: 'specialist', clusterId: 'sec-pod' });
    const received = [];
    testBus.subscribe('mgr', (msg) => received.push(msg));
    const dispatchRes = await testBus.dispatch({
        senderId: 'sec',
        senderRole: 'Security Specialist',
        senderLayer: 'specialist',
        clusterId: 'sec-pod',
        scope: 'upward',
        payload: { summary: 'threat detected' }
    });
    if (dispatchRes.deliveredCount === 0 || received.length === 0) {
        throw new Error('Compiled HierarchicalMessageBus dispatch failed');
    }
    console.log('✓ Compiled HierarchicalMessageBus upward routing:', received[0]?.payload?.summary);

    const topMgr = new CommTopologyFromSubpath();
    const topology = topMgr.discoverTopology({
        specialists: [
            { id: 's1', role: 'Security Specialist' },
            { id: 'p1', role: 'Performance Engineer' }
        ],
        task: 'Audit authentication token security'
    });
    if (topology.totalPods !== 2 || !topology.pods['security-pod']) {
        throw new Error('Compiled ClusterTopologyManager discoverTopology failed');
    }
    console.log('✓ Compiled ClusterTopologyManager auto-discovery:', Object.keys(topology.pods));

    // 7. Verify compiled VectorIndex (VpTreeIndex & HnswVectorIndex)
    if (!VpTreeIndex || !HnswVectorIndex || !createVectorIndex || !VpTreeFromSubpath || !HnswFromSubpath || !createVectorFromSubpath) {
        throw new Error('Compiled VectorIndex exports missing');
    }
    const vptree = createVectorFromSubpath('vptree', { metric: 'cosine' });
    vptree.insert('v1', [1, 0, 0], { label: 'vec1' });
    vptree.insert('v2', [0, 1, 0], { label: 'vec2' });
    const searchRes = vptree.search([0.9, 0.1, 0], { k: 1 });
    if (searchRes.length !== 1 || searchRes[0].id !== 'v1') {
        throw new Error('Compiled VpTreeIndex search failed');
    }

    const hnsw = new HnswFromSubpath({ metric: 'cosine', m: 8, efSearch: 16 });
    hnsw.insert('h1', [0, 0, 1], { label: 'hvec1' });
    hnsw.insert('h2', [0, 1, 0], { label: 'hvec2' });
    const hnswRes = hnsw.search([0.05, 0.05, 0.99], { k: 1 });
    if (hnswRes.length !== 1 || hnswRes[0].id !== 'h1') {
        throw new Error('Compiled HnswVectorIndex search failed');
    }
    // 8. Verify compiled Speculative Execution (DependencyGraph, ConflictResolver, SpeculativeExecutionCoordinator)
    if (!DependencyGraph || !ConflictResolver || !SpeculativeExecutionCoordinator || !DepGraphFromSubpath || !ConflictFromSubpath || !SpecCoordFromSubpath) {
        throw new Error('Compiled Speculative module exports missing');
    }
    const depGraph = new DepGraphFromSubpath();
    depGraph.addNode({ id: 'task-a', chunkIndex: 0, dependencies: [], payload: 'Task A' });
    depGraph.addNode({ id: 'task-b', chunkIndex: 1, dependencies: ['task-a'], payload: 'Task B' });
    const batches = depGraph.getExecutionBatches();
    if (batches.length !== 2 || batches[0][0].id !== 'task-a' || batches[1][0].id !== 'task-b') {
        throw new Error('Compiled DependencyGraph batching failed');
    }

    const resolver = new ConflictFromSubpath();
    const mockReports = [
        {
            role: 'Security Specialist',
            insights: ['Auth token leak detected in login service'],
            anomalies: ['Critical authentication token exposed']
        },
        {
            role: 'Performance Engineer',
            insights: ['Auth token nominal in login service'],
            anomalies: []
        }
    ];
    const reconciled = resolver.reconcileReports(mockReports, { strategy: 'conservative_pessimistic' });
    if (reconciled.conflicts.length === 0 || !reconciled.anomalies.some(a => a.includes('Critical authentication'))) {
        throw new Error('Compiled ConflictResolver resolution failed');
    }

    const coord = new SpecCoordFromSubpath(new ConflictFromSubpath());
    const coordRun = await coord.executeSpeculative([
        { id: 'sub-1', chunkIndex: 0, payload: 'p1', execute: async () => ({ role: 'Agent1', insights: ['Insight 1'], anomalies: [] }) },
        { id: 'sub-2', chunkIndex: 1, payload: 'p2', execute: async () => ({ role: 'Agent2', insights: ['Insight 2'], anomalies: [] }) }
    ], { maxConcurrency: 2 });
    if (coordRun.results.length !== 2 || coordRun.totalTasks !== 2) {
        throw new Error('Compiled SpeculativeExecutionCoordinator failed');
    }
    console.log('✓ Compiled Speculative module subpath, DependencyGraph, and ConflictResolver verified');

    console.log('\n✓ ALL COMPILED SWARM DISTRIBUTION BUNDLE TESTS PASSED SUCCESSFULLY!\n');
}

runDistVerification().catch(err => {
    console.error('Dist verification failed:', err);
    process.exit(1);
});
