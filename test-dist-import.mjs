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
    SpeculativeExecutionCoordinator,
    AgentExperimentManager,
    AgentExperiment,
    StatisticalAnalyzer,
    globalAgentExperimentManager,
    TokenAwarePromptCompressor,
    TokenEstimator,
    SemanticDeduplicator,
    globalPromptCompressor,
    AdaptiveTaskScheduler,
    PriorityTaskQueue,
    TokenBucketRateLimiter,
    PredictiveLatencyModel,
    WorkStealingPool,
    globalTaskScheduler,
    HierarchicalSpecialistTree,
    HierarchicalRouter,
    globalHierarchicalRouter,
    classifyAgentTier,
    identifyPrimaryDomain,
    DOMAIN_TAXONOMY,
    TieredCache,
    VectorQuantizer,
    SelectiveSnapshotter,
    globalTieredCache,
    UnifiedSwarmProfiler,
    PerformanceAnomalyDetector,
    runSwarmBenchmark,
    globalUnifiedProfiler,
    ContinuousFeedbackEngine,
    PolicyOptimizer,
    ConceptDriftDetector,
    SwarmKnowledgeRepository,
    globalFeedbackEngine,
    SharedKnowledgeGraph,
    globalKnowledgeGraph,
    AgentAdaptiveLearningRateManager,
    HighBandwidthMessageChannel,
    HierarchicalTaskDecomposer,
    HypothesisValidationLayer,
    ShapedRewardPolicy,
    globalLearningRateManager,
    globalMessageChannel,
    globalTaskDecomposer,
    globalHypothesisLayer,
    globalShapedRewardPolicy,
    TwoTierModelHealthChecker,
    ModelCircuitBreaker,
    ModelHealthCache,
    globalModelHealthChecker,
    DomainSubComputationCache,
    TokenWeightProfiler,
    DomainPreFilter,
    ConfidenceEarlyExitEvaluator,
    PredictionWorkerPool,
    TieredPredictionEngine,
    globalDomainSubComputationCache
} from './dist/swarm/index.js';
import {
    DomainSubComputationCache as DomainCacheFromSubpath,
    TokenWeightProfiler as ProfilerOptFromSubpath,
    DomainPreFilter as PreFilterFromSubpath,
    ConfidenceEarlyExitEvaluator as EarlyExitFromSubpath,
    PredictionWorkerPool as WorkerPoolFromSubpath,
    TieredPredictionEngine as TieredEngineFromSubpath,
    globalDomainSubComputationCache as globalDomainCacheFromSubpath
} from './dist/swarm/optimization.js';
import {
    TwoTierModelHealthChecker as CheckerFromSubpath,
    ModelCircuitBreaker as BreakerFromSubpath,
    ModelHealthCache as CacheFromSubpath,
    globalModelHealthChecker as globalCheckerFromSubpath
} from './dist/swarm/health.js';
import {
    SharedKnowledgeGraph as GraphFromSubpath,
    globalKnowledgeGraph as globalGraphFromSubpath
} from './dist/swarm/knowledgeGraph.js';
import {
    AgentAdaptiveLearningRateManager as LRManagerFromSubpath,
    HighBandwidthMessageChannel as ChannelFromSubpath,
    HierarchicalTaskDecomposer as DecomposerFromSubpath,
    HypothesisValidationLayer as HypoLayerFromSubpath,
    ShapedRewardPolicy as RewardPolicyFromSubpath,
    globalLearningRateManager as globalLRFromSubpath,
    globalMessageChannel as globalChannelFromSubpath,
    globalTaskDecomposer as globalDecomposerFromSubpath,
    globalHypothesisLayer as globalHypoFromSubpath,
    globalShapedRewardPolicy as globalRewardPolicyFromSubpath
} from './dist/swarm/coordination.js';
import {
    ContinuousFeedbackEngine as FeedbackEngineFromSubpath,
    PolicyOptimizer as OptimizerFromSubpath,
    ConceptDriftDetector as DriftDetectorFromSubpath,
    SwarmKnowledgeRepository as RepoFromSubpath,
    globalFeedbackEngine as globalFeedbackFromSubpath
} from './dist/swarm/feedback.js';
import {
    UnifiedSwarmProfiler as ProfilerFromSubpath,
    PerformanceAnomalyDetector as AnomalyDetectorFromSubpath,
    runSwarmBenchmark as runBenchmarkFromSubpath,
    globalUnifiedProfiler as globalProfilerFromSubpath
} from './dist/swarm/profiler.js';
import { createSwarmServer as serverFromSubpath } from './dist/swarm/server.js';
import { createSwarmClient as clientFromSubpath } from './dist/swarm/client.js';
import { HierarchicalMessageBus as CommBusFromSubpath, ClusterTopologyManager as CommTopologyFromSubpath } from './dist/swarm/communication.js';
import { VpTreeIndex as VpTreeFromSubpath, HnswVectorIndex as HnswFromSubpath, createVectorIndex as createVectorFromSubpath } from './dist/swarm/vectorIndex.js';
import { DependencyGraph as DepGraphFromSubpath, ConflictResolver as ConflictFromSubpath, SpeculativeExecutionCoordinator as SpecCoordFromSubpath } from './dist/swarm/speculative.js';
import { AgentExperimentManager as ExpMgrFromSubpath, AgentExperiment as ExpFromSubpath, StatisticalAnalyzer as StatFromSubpath } from './dist/swarm/experiment.js';
import { TokenAwarePromptCompressor as CompressorFromSubpath, TokenEstimator as TokenEstimatorFromSubpath, SemanticDeduplicator as DedupFromSubpath, globalPromptCompressor as globalCompressorFromSubpath } from './dist/swarm/compression.js';
import { AdaptiveTaskScheduler as SchedulerFromSubpath, PriorityTaskQueue as QueueFromSubpath, TokenBucketRateLimiter as LimiterFromSubpath, PredictiveLatencyModel as LatencyFromSubpath, WorkStealingPool as WorkStealingFromSubpath, globalTaskScheduler as globalSchedulerFromSubpath } from './dist/swarm/scheduler.js';
import {
    HierarchicalSpecialistTree as TreeFromSubpath,
    HierarchicalRouter as RouterFromSubpath,
    classifyAgentTier as classifyFromSubpath,
    identifyPrimaryDomain as identifyFromSubpath
} from './dist/swarm/hierarchy.js';
import {
    TieredCache as TieredCacheFromSubpath,
    VectorQuantizer as QuantizerFromSubpath,
    SelectiveSnapshotter as SnapshotterFromSubpath,
    globalTieredCache as globalTieredCacheFromSubpath
} from './dist/swarm/tieredCache.js';
import { ToolRegistry, calculatorTool } from './dist/swarm/tools.js';
import { repairJson, parseJsonSafe } from './dist/swarm/parser.js';

async function runDistVerification() {
    console.log('\n=== Distribution Bundle Verification (ESM from dist/swarm/index.js) ===');

    // 1. Verify exports presence
    console.log('Verifying compiled library exports:');
    const requiredExports = [
        executeSwarmWorkflow, SwarmEngine, MemoryCortex, ModelRouter,
        PayloadCache, AdaptiveLoadBalancer, ProviderRegistry,
        createSwarmServer, handleSwarmSse, serverFromSubpath,
        createSwarmClient, clientFromSubpath
    ];
    if (requiredExports.some(exp => !exp)) {
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

    // 9. Verify compiled A/B Testing & Continuous Learning Engine
    if (!AgentExperimentManager || !AgentExperiment || !StatisticalAnalyzer || !globalAgentExperimentManager || !ExpMgrFromSubpath || !ExpFromSubpath || !StatFromSubpath) {
        throw new Error('Compiled Experiment module exports missing');
    }

    const tTest = StatFromSubpath.welchTTest([10, 11, 10, 12, 11], [5, 6, 5, 6, 5]);
    if (tTest.pValue >= 0.05 || tTest.tStat <= 0) {
        throw new Error('Compiled StatisticalAnalyzer Welch t-test failed');
    }

    const expMgr = new ExpMgrFromSubpath();
    const testExp = expMgr.createExperiment({
        id: 'dist-exp',
        name: 'Distribution Test Experiment',
        variants: [
            { variantId: 'ctrl', name: 'Control', trafficWeight: 1, isBaseline: true },
            { variantId: 'treat', name: 'Treatment', trafficWeight: 1 }
        ]
    });
    const allocated = testExp.allocateVariant('user-123:task-abc');
    if (!allocated || !['ctrl', 'treat'].includes(allocated.variantId)) {
        throw new Error('Compiled AgentExperiment allocateVariant failed');
    }
    const outcome = testExp.recordOutcome(allocated.variantId, { durationMs: 450, rlaifScore: 0.95 });
    if (!outcome || outcome.experimentId !== 'dist-exp') {
        throw new Error('Compiled AgentExperiment recordOutcome failed');
    }
    console.log('✓ Compiled Experiment module subpath, StatisticalAnalyzer, and AgentExperimentManager verified');

    // 10. Verify compiled Token-Aware Prompt Compression & Semantic Deduplication Engine
    if (!TokenAwarePromptCompressor || !TokenEstimator || !SemanticDeduplicator || !globalPromptCompressor || !CompressorFromSubpath || !TokenEstimatorFromSubpath || !DedupFromSubpath) {
        throw new Error('Compiled Compression module exports missing');
    }

    const testPrompt = `Task: System health check\nHistorical Baselines: All systems operational\nAnalyst Reports:\n[DB Specialist]: CPU spiked to 95% on node-2\n[Infra Specialist]: CPU spiked to 95% on node-2 during peak traffic`;
    const comp = new CompressorFromSubpath({ targetReductionRatio: 0.35, similarityThreshold: 0.70 });
    const compResult = comp.compress(testPrompt);
    if (compResult.originalTokens <= 0 || compResult.compressedTokens <= 0 || compResult.tokensSaved <= 0 || compResult.reductionRatio <= 0) {
        throw new Error('Compiled TokenAwarePromptCompressor compression failed');
    }

    const sim = DedupFromSubpath.computeSemanticSimilarity('CPU usage was 95%', 'High CPU usage reached 95%');
    if (sim < 0.60) {
        throw new Error('Compiled SemanticDeduplicator similarity check failed');
    }
    console.log('✓ Compiled Compression module subpath, TokenAwarePromptCompressor, and SemanticDeduplicator verified');

    // 11. Verify compiled Adaptive Task Scheduler & Work Stealing Engine
    if (!AdaptiveTaskScheduler || !PriorityTaskQueue || !TokenBucketRateLimiter || !PredictiveLatencyModel || !WorkStealingPool || !globalTaskScheduler || !SchedulerFromSubpath || !QueueFromSubpath || !LimiterFromSubpath) {
        throw new Error('Compiled Scheduler module exports missing');
    }

    const testScheduler = new SchedulerFromSubpath({
        strategy: 'work-stealing',
        maxConcurrency: 2,
        enableRateLimiting: false
    });

    const schedExecRes = await testScheduler.executeScheduled([
        { id: 'dist-task-1', assignedWorkerId: 'worker-1', priority: 'high', execute: async () => 'result-1' },
        { id: 'dist-task-2', assignedWorkerId: 'worker-2', priority: 'normal', execute: async () => 'result-2' }
    ]);

    if (schedExecRes.totalTasks !== 2 || schedExecRes.successfulTasks !== 2) {
        throw new Error('Compiled AdaptiveTaskScheduler execution failed');
    }

    const testLimiter = new LimiterFromSubpath({
        test: { maxRpm: 60, maxTpm: 10000 }
    });
    if (!testLimiter.canAcquire('test', 100)) {
        throw new Error('Compiled TokenBucketRateLimiter acquisition failed');
    }
    console.log('✓ Compiled Scheduler module subpath, AdaptiveTaskScheduler, and TokenBucketRateLimiter verified');

    // 12. Verify compiled Hierarchical Agent Specialization & Dynamic Routing Engine
    if (!HierarchicalSpecialistTree || !HierarchicalRouter || !globalHierarchicalRouter || !classifyAgentTier || !TreeFromSubpath || !RouterFromSubpath || !classifyFromSubpath) {
        throw new Error('Compiled Hierarchy module exports missing');
    }

    const testTier = classifyFromSubpath('Security Architect');
    if (testTier.tier !== 1 || testTier.tierRole !== 'cluster_lead') {
        throw new Error('Compiled classifyAgentTier failed');
    }

    const testTree = TreeFromSubpath.buildFromAgents([
        { id: 'root', role: 'Manager Node', provider: 'mock' },
        { id: 'sec-lead', role: 'Security Architect', provider: 'mock' },
        { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'mock' }
    ]);
    if (testTree.getAllNodes().length !== 3 || testTree.getTreeDepth() !== 3) {
        throw new Error('Compiled HierarchicalSpecialistTree buildFromAgents failed');
    }

    const testRouter = new RouterFromSubpath();
    const routeDec = testRouter.routeHierarchical('Audit auth token vulnerability', 'JWT payload', 0, testTree);
    if (routeDec.targetRole !== 'Vulnerability Specialist' || routeDec.delegationChain.length !== 3) {
        throw new Error('Compiled HierarchicalRouter routeHierarchical failed');
    }

    const escRec = testRouter.escalate('task-1', 'sec-spec', testTree, 2, 'Anomalies detected');
    if (escRec.toNodeId !== 'sec-lead' || escRec.anomalyCount !== 2) {
        throw new Error('Compiled HierarchicalRouter escalate failed');
    }
    console.log('✓ Compiled Hierarchy module subpath, HierarchicalSpecialistTree, and HierarchicalRouter verified');

    // 13. Verify compiled Tiered Cache, Vector Quantization, and Selective Snapshotting
    if (!TieredCache || !VectorQuantizer || !SelectiveSnapshotter || !globalTieredCache || !TieredCacheFromSubpath || !QuantizerFromSubpath || !SnapshotterFromSubpath || !globalTieredCacheFromSubpath) {
        throw new Error('Compiled TieredCache module exports missing');
    }

    // Vector Quantization verification
    const testVec1 = QuantizerFromSubpath.generateEmbedding('latency optimization and cache hit');
    const testVec2 = QuantizerFromSubpath.generateEmbedding('latency optimization and cache hit query');
    const sq8_1 = QuantizerFromSubpath.quantizeSQ8(testVec1);
    const bq_1 = QuantizerFromSubpath.quantizeBinary(testVec1);
    const adcSim = QuantizerFromSubpath.asymmetricCosineSimilarity(testVec2, sq8_1);
    if (adcSim < 0.70) {
        throw new Error('Compiled VectorQuantizer asymmetricCosineSimilarity failed');
    }

    // Selective Snapshotting verification
    const baseState = { a: 1, b: 2, c: 'hello' };
    const step1State = { a: 1, b: 99, d: 'world' };
    const baseSnap = SnapshotterFromSubpath.createBaseSnapshot('snap-1', baseState);
    const deltaSnap = SnapshotterFromSubpath.createDeltaSnapshot(baseSnap, baseState, step1State, 0);
    const hydrated = SnapshotterFromSubpath.hydrateState(baseSnap, [deltaSnap]);
    if (hydrated.b !== 99 || hydrated.d !== 'world' || hydrated.c !== undefined) {
        throw new Error('Compiled SelectiveSnapshotter delta hydration failed');
    }
    const compressedPayload = SnapshotterFromSubpath.compressPayload('repeat token repeat token repeat token');
    const decompressed = SnapshotterFromSubpath.decompressPayload(compressedPayload);
    if (decompressed !== 'repeat token repeat token repeat token') {
        throw new Error('Compiled SelectiveSnapshotter payload compression failed');
    }

    // TieredCache verification
    const cacheInst = new TieredCacheFromSubpath({
        l1MaxEntries: 10,
        l2SemanticThreshold: 0.75,
        l3MaxSnapshots: 5
    });
    cacheInst.set('test-task', 'test-data', { output: 'result-val' }, { raw: 'state' });
    const l1Hit = cacheInst.get('test-task', 'test-data');
    if (!l1Hit || l1Hit.tier !== 'L1') {
        throw new Error('Compiled TieredCache L1 retrieval failed');
    }
    console.log('✓ Compiled TieredCache module subpath, VectorQuantizer, SelectiveSnapshotter, and TieredCache verified');

    // 14. Verify compiled UnifiedSwarmProfiler, PerformanceAnomalyDetector, and runSwarmBenchmark
    if (!UnifiedSwarmProfiler || !PerformanceAnomalyDetector || !runSwarmBenchmark || !globalUnifiedProfiler || !ProfilerFromSubpath || !AnomalyDetectorFromSubpath || !runBenchmarkFromSubpath || !globalProfilerFromSubpath) {
        throw new Error('Compiled profiler module exports missing');
    }

    const testProfiler = ProfilerFromSubpath.getInstance();
    testProfiler.recordWorkflowRun({
        durationMs: 45,
        cache: { l1Hits: 1, l2Hits: 0, l3Hits: 0, misses: 0, savedTokens: 120, memorySavedBytes: 256 },
        compression: { totalOriginalTokens: 300, totalCompressedTokens: 180, totalTokensSaved: 120 }
    });

    const profilerReport = testProfiler.getUnifiedBaselineReport();
    if (profilerReport.totalWorkflows <= 0 || profilerReport.resourceUtilization.totalTokensSaved < 120) {
        throw new Error('Compiled UnifiedSwarmProfiler baseline report verification failed');
    }

    const anomalyDetector = new AnomalyDetectorFromSubpath();
    anomalyDetector.calibrate([10, 15, 20, 25, 30]);
    const anomaly = anomalyDetector.checkLatency('engine', 150);
    if (!anomaly || anomaly.severity !== 'critical') {
        throw new Error('Compiled PerformanceAnomalyDetector checkLatency failed');
    }

    const benchResult = await runBenchmarkFromSubpath({ iterations: 2, batchSize: 2 });
    if (!benchResult || benchResult.totalIterations !== 2 || benchResult.opsPerSecond <= 0) {
        throw new Error('Compiled runSwarmBenchmark execution failed');
    }
    console.log('✓ Compiled Profiler module subpath, UnifiedSwarmProfiler, PerformanceAnomalyDetector, and runSwarmBenchmark verified');

    // 15. Verify compiled ContinuousFeedbackEngine, PolicyOptimizer, ConceptDriftDetector, and SwarmKnowledgeRepository
    if (!ContinuousFeedbackEngine || !PolicyOptimizer || !ConceptDriftDetector || !SwarmKnowledgeRepository || !globalFeedbackEngine || !FeedbackEngineFromSubpath || !OptimizerFromSubpath || !DriftDetectorFromSubpath || !RepoFromSubpath || !globalFeedbackFromSubpath) {
        throw new Error('Compiled feedback module exports missing');
    }

    const testOptimizer = new OptimizerFromSubpath();
    const testReward = testOptimizer.calculateReward({
        workflowId: 'wf-dist-1',
        task: 'compiled-test',
        appId: 'dist-app',
        durationMs: 60,
        targetTier: 'instant',
        tokenSavings: 300,
        tokensConsumed: 100,
        qualityScore: 0.96,
        accuracyScore: 0.99,
        errorCount: 0,
        anomalyCount: 0,
        timestamp: Date.now()
    });
    if (testReward.compositeReward <= 0.5) {
        throw new Error('Compiled PolicyOptimizer calculateReward failed');
    }
    const mutated = testOptimizer.mutate(testOptimizer.getCurrentPolicy(), 0.1);
    if (!mutated || typeof mutated.cacheL1MaxEntries !== 'number') {
        throw new Error('Compiled PolicyOptimizer mutate failed');
    }

    const testDrift = new DriftDetectorFromSubpath();
    const valRes = testDrift.validateDataPayload('Valid telemetry stream test');
    if (!valRes.valid) {
        throw new Error('Compiled ConceptDriftDetector validateDataPayload failed');
    }

    const testRepo = new RepoFromSubpath();
    await testRepo.recordOutcome({
        id: 'out-dist-1',
        workflowId: 'wf-dist-1',
        task: 'compiled-test',
        appId: 'dist-app',
        finalInsightSnippet: 'Compiled insight nominal',
        metrics: {
            workflowId: 'wf-dist-1',
            task: 'compiled-test',
            appId: 'dist-app',
            durationMs: 60,
            targetTier: 'instant',
            tokenSavings: 300,
            tokensConsumed: 100,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        },
        reward: testReward,
        parametersUsed: testOptimizer.getCurrentPolicy(),
        driftAlerts: [],
        timestamp: Date.now()
    });
    const distOutcomes = testRepo.queryOutcomes({ appId: 'dist-app' });
    if (distOutcomes.length !== 1 || distOutcomes[0].id !== 'out-dist-1') {
        throw new Error('Compiled SwarmKnowledgeRepository queryOutcomes failed');
    }

    const testFeedbackEngine = FeedbackEngineFromSubpath.getInstance();
    const fbRes = await testFeedbackEngine.processFeedback({
        workflowId: 'wf-dist-2',
        task: 'compiled-engine-feedback',
        appId: 'dist-app',
        durationMs: 50,
        targetTier: 'instant',
        qualityScore: 0.95
    });
    if (!fbRes || !fbRes.outcomeId || !fbRes.tunedParameters) {
        throw new Error('Compiled ContinuousFeedbackEngine processFeedback failed');
    }
    console.log('✓ Compiled Feedback module subpath, PolicyOptimizer, ConceptDriftDetector, and SwarmKnowledgeRepository verified');

    // 17. Verify SharedKnowledgeGraph and Coordination Modules
    const distGraph = new GraphFromSubpath();
    const nodeA = distGraph.addNode({ id: 'dist-n1', type: 'entity', label: 'Dist Node A', confidence: 0.9 });
    const nodeB = distGraph.addNode({ id: 'dist-n2', type: 'finding', label: 'Dist Node B', confidence: 0.85 });
    const distEdge = distGraph.addEdge({ source: 'dist-n1', target: 'dist-n2', relation: 'causes', weight: 0.95 });
    if (distGraph.getVersion() !== 3 || distGraph.getNeighbors('dist-n1', 'out').length !== 1) {
        throw new Error('Compiled SharedKnowledgeGraph graph operations failed');
    }
    const distDeltas = distGraph.getDeltasSince(1);
    if (distDeltas.deltas.length !== 2) {
        throw new Error('Compiled SharedKnowledgeGraph delta tracking failed');
    }

    const distDecomposer = new DecomposerFromSubpath();
    const distPlan = distDecomposer.decompose('Audit compiled bundle performance', ['Security Analyst', 'Performance Analyst']);
    if (!distPlan.macroTask || distPlan.subtasks.length < 3 || distPlan.executionWaves.length < 2) {
        throw new Error('Compiled HierarchicalTaskDecomposer decomposition failed');
    }

    const distHypoLayer = new HypoLayerFromSubpath(distGraph);
    const distHypo = distHypoLayer.proposeHypothesis({
        claim: 'Compiled bundle reduces latency by 50%',
        proposedBy: 'PerfAnalyst',
        confidence: 0.75
    });
    const distVal = distHypoLayer.validateHypothesis(distHypo.id, {
        isValid: true,
        validatedBy: 'PrincipalManager'
    });
    if (!distVal || distVal.status !== 'validated' || !distGraph.getNode(`node-${distHypo.id}`)) {
        throw new Error('Compiled HypothesisValidationLayer validation and graph propagation failed');
    }

    const distLR = new LRManagerFromSubpath();
    const rate1 = distLR.getLearningRate('dist-agent');
    const updateRes = distLR.recordAgentStep('dist-agent', 0.95);
    if (rate1 !== 0.10 || !updateRes.newRate) {
        throw new Error('Compiled AgentAdaptiveLearningRateManager step record failed');
    }

    const distRewardPolicy = new RewardPolicyFromSubpath(0.20, 0.15);
    const shapedRes = distRewardPolicy.calculateShapedReward({
        extrinsicReward: 0.85,
        noveltyScore: 0.4,
        redundancyCount: 1
    });
    if (shapedRes.shapedReward <= 0 || !shapedRes.components.noveltyBonus) {
        throw new Error('Compiled ShapedRewardPolicy calculation failed');
    }
    console.log('✓ Compiled KnowledgeGraph & Coordination subpaths, SharedKnowledgeGraph, HypothesisValidationLayer, and AdaptiveLearningRateManager verified');

    const distChecker = new CheckerFromSubpath();
    const distCheckResult = await distChecker.checkModel({
        provider: 'simulated',
        modelId: 'dist-sim-model'
    });
    if (!distCheckResult.healthy || distCheckResult.circuitState !== 'CLOSED') {
        throw new Error('Compiled TwoTierModelHealthChecker simulation check failed');
    }
    const distBreaker = new BreakerFromSubpath({ failureThreshold: 2 });
    distBreaker.recordFailure('p', 'm');
    distBreaker.recordFailure('p', 'm');
    if (distBreaker.getState('p', 'm') !== 'OPEN') {
        throw new Error('Compiled ModelCircuitBreaker tripping failed');
    }
    console.log('✓ Compiled Health subpath, TwoTierModelHealthChecker, ModelCircuitBreaker, and ModelHealthCache verified');

    // 18. Verify compiled Optimization Module (DomainSubComputationCache, TokenWeightProfiler, DomainPreFilter, PredictionWorkerPool, TieredPredictionEngine)
    if (!DomainSubComputationCache || !TokenWeightProfiler || !DomainPreFilter || !ConfidenceEarlyExitEvaluator || !PredictionWorkerPool || !TieredPredictionEngine || !globalDomainSubComputationCache || !DomainCacheFromSubpath || !WorkerPoolFromSubpath || !TieredEngineFromSubpath) {
        throw new Error('Compiled optimization module exports missing');
    }

    const distDomainCache = new DomainCacheFromSubpath({ maxEntries: 10, defaultTtlMs: 10000 });
    distDomainCache.set('team_form', 'team-arsenal', { form: 'WWWDW' });
    const cachedForm = distDomainCache.get('team_form', 'team-arsenal');
    if (!cachedForm || cachedForm.form !== 'WWWDW') {
        throw new Error('Compiled DomainSubComputationCache get/set failed');
    }

    const distProfiler = new ProfilerOptFromSubpath();
    const payloadProfile = distProfiler.profile('{"game":"Arsenal vs Chelsea","odds":{"h":1.9,"d":3.4,"a":4.2}}');
    if (payloadProfile.totalTokens <= 0) {
        throw new Error('Compiled TokenWeightProfiler profile failed');
    }

    const distPreFilter = new PreFilterFromSubpath();
    const pruned = distPreFilter.filter({
        fixture: { home: 'Team A', away: 'Team B', status: 'scheduled' },
        debug_trace: 'trace string',
        internal_telemetry: { log: 'xyz' }
    });
    if (!pruned.filteredData.fixture) {
        throw new Error('Compiled DomainPreFilter filter failed');
    }

    const earlyExitEval = new EarlyExitFromSubpath({ defaultConfidenceThreshold: 0.85, defaultMarginThreshold: 0.20 });
    const evalRes = earlyExitEval.evaluate({
        confidence: 0.88,
        market: 'match_winner',
        predictedOutcome: 'home'
    });
    if (!evalRes.canEarlyExit || evalRes.tier !== 'tier1_approx') {
        throw new Error('Compiled ConfidenceEarlyExitEvaluator failed');
    }

    const distWorkerPool = new WorkerPoolFromSubpath({ maxConcurrency: 2 });
    const workerTask = await distWorkerPool.submit(
        async () => 42,
        { id: 'dist-opt-task', priority: 'high' }
    );
    if (workerTask !== 42) {
        throw new Error('Compiled PredictionWorkerPool submit failed');
    }

    const distTieredEngine = new TieredEngineFromSubpath({
        earlyExitEvaluator: earlyExitEval,
        workerPool: distWorkerPool
    });
    const tieredRes = await distTieredEngine.execute({
        task: 'Predict match',
        data: { game: 'test' },
        tier1Fn: async () => ({
            predictedOutcome: 'Home Win',
            confidence: 0.92,
            tier: 'tier1_approx'
        }),
        tier2Fn: async () => ({
            predictedOutcome: 'Home Win Refined',
            confidence: 0.95
        }),
        options: {
            enableEarlyExit: true,
            confidenceThreshold: 0.80
        }
    });
    if (!tieredRes.earlyExit || tieredRes.tier !== 'tier1_approx') {
        throw new Error('Compiled TieredPredictionEngine failed');
    }
    console.log('✓ Compiled Optimization module subpath, DomainCache, WorkerPool, and TieredEngine verified');

    console.log('\n✓ ALL COMPILED SWARM DISTRIBUTION BUNDLE TESTS PASSED SUCCESSFULLY!\n');
}

runDistVerification().catch(err => {
    console.error('Dist verification failed:', err);
    process.exit(1);
});
