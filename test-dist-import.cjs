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

    const expCjs = require('./dist/swarm/experiment.cjs');
    if (!expCjs.AgentExperimentManager || !expCjs.AgentExperiment || !expCjs.StatisticalAnalyzer || !expCjs.globalAgentExperimentManager) {
        throw new Error('CommonJS experiment exports missing');
    }
    const cjsTTest = expCjs.StatisticalAnalyzer.welchTTest([10, 11, 10, 12, 11], [5, 6, 5, 6, 5]);
    if (cjsTTest.pValue >= 0.05) {
        throw new Error('CommonJS StatisticalAnalyzer t-test failed');
    }
    const cjsExpMgr = new expCjs.AgentExperimentManager();
    const cjsExp = cjsExpMgr.createExperiment({
        id: 'cjs-exp',
        name: 'CJS Experiment Test',
        variants: [
            { variantId: 'c1', name: 'Control', trafficWeight: 1, isBaseline: true },
            { variantId: 'c2', name: 'Treatment', trafficWeight: 1 }
        ]
    });
    const cjsAlloc = cjsExp.allocateVariant('key-123');
    if (!cjsAlloc || !['c1', 'c2'].includes(cjsAlloc.variantId)) {
        throw new Error('CommonJS AgentExperiment allocation failed');
    }
    console.log('✓ CJS experiment subpath, StatisticalAnalyzer, and AgentExperimentManager verified');

    const compCjs = require('./dist/swarm/compression.cjs');
    if (!compCjs.TokenAwarePromptCompressor || !compCjs.TokenEstimator || !compCjs.SemanticDeduplicator || !compCjs.globalPromptCompressor) {
        throw new Error('CommonJS compression exports missing');
    }
    const cjsComp = new compCjs.TokenAwarePromptCompressor({ targetReductionRatio: 0.35, similarityThreshold: 0.70 });
    const cjsCompRes = cjsComp.compress('Task: System health check\nAnalyst Reports:\n[DB Specialist]: CPU spiked to 95% on node-2\n[Infra Specialist]: CPU spiked to 95% on node-2 during peak traffic');
    if (cjsCompRes.originalTokens <= 0 || cjsCompRes.compressedTokens <= 0 || cjsCompRes.tokensSaved <= 0) {
        throw new Error('CommonJS TokenAwarePromptCompressor compression failed');
    }
    const cjsSim = compCjs.SemanticDeduplicator.computeSemanticSimilarity('CPU usage was 95%', 'High CPU usage reached 95%');
    if (cjsSim < 0.60) {
        throw new Error('CommonJS SemanticDeduplicator similarity check failed');
    }
    console.log('✓ CJS compression subpath, TokenAwarePromptCompressor, and SemanticDeduplicator verified');

    const schedCjs = require('./dist/swarm/scheduler.cjs');
    if (!schedCjs.AdaptiveTaskScheduler || !schedCjs.PriorityTaskQueue || !schedCjs.TokenBucketRateLimiter || !schedCjs.PredictiveLatencyModel || !schedCjs.WorkStealingPool || !schedCjs.globalTaskScheduler) {
        throw new Error('CommonJS scheduler exports missing');
    }
    const cjsScheduler = new schedCjs.AdaptiveTaskScheduler({ strategy: 'work-stealing', maxConcurrency: 2, enableRateLimiting: false });
    const cjsSchedRes = await cjsScheduler.executeScheduled([
        { id: 'cjs-task-1', assignedWorkerId: 'w1', priority: 'high', execute: async () => 'cjs-res-1' },
        { id: 'cjs-task-2', assignedWorkerId: 'w2', priority: 'normal', execute: async () => 'cjs-res-2' }
    ]);
    if (cjsSchedRes.totalTasks !== 2 || cjsSchedRes.successfulTasks !== 2) {
        throw new Error('CommonJS AdaptiveTaskScheduler execution failed');
    }
    console.log('✓ CJS scheduler subpath, AdaptiveTaskScheduler, and WorkStealingPool verified');

    const hierCjs = require('./dist/swarm/hierarchy.cjs');
    if (!hierCjs.HierarchicalSpecialistTree || !hierCjs.HierarchicalRouter || !hierCjs.globalHierarchicalRouter || !hierCjs.classifyAgentTier) {
        throw new Error('CommonJS hierarchy exports missing');
    }
    const cjsTier = hierCjs.classifyAgentTier('Security Architect');
    if (cjsTier.tier !== 1 || cjsTier.tierRole !== 'cluster_lead') {
        throw new Error('CommonJS classifyAgentTier failed');
    }
    const cjsTree = hierCjs.HierarchicalSpecialistTree.buildFromAgents([
        { id: 'root', role: 'Manager Node', provider: 'mock' },
        { id: 'sec-lead', role: 'Security Architect', provider: 'mock' },
        { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'mock' }
    ]);
    if (cjsTree.getAllNodes().length !== 3 || cjsTree.getTreeDepth() !== 3) {
        throw new Error('CommonJS HierarchicalSpecialistTree buildFromAgents failed');
    }
    const cjsRouter = new hierCjs.HierarchicalRouter();
    const cjsRoute = cjsRouter.routeHierarchical('Audit auth token vulnerability', 'JWT payload', 0, cjsTree);
    if (cjsRoute.targetRole !== 'Vulnerability Specialist' || cjsRoute.delegationChain.length !== 3) {
        throw new Error('CommonJS HierarchicalRouter routeHierarchical failed');
    }
    console.log('✓ CJS hierarchy subpath, HierarchicalSpecialistTree, and HierarchicalRouter verified');

    const tieredCjs = require('./dist/swarm/tieredCache.cjs');
    if (!tieredCjs.TieredCache || !tieredCjs.VectorQuantizer || !tieredCjs.SelectiveSnapshotter || !tieredCjs.globalTieredCache) {
        throw new Error('CommonJS tieredCache exports missing');
    }
    const cjsVec = tieredCjs.VectorQuantizer.generateEmbedding('latency optimization');
    const cjsSq8 = tieredCjs.VectorQuantizer.quantizeSQ8(cjsVec);
    const cjsBq = tieredCjs.VectorQuantizer.quantizeBinary(cjsVec);
    if (!cjsSq8.codes || !cjsBq.bits) {
        throw new Error('CommonJS VectorQuantizer quantization failed');
    }
    const cjsBaseState = { status: 'ok', count: 1 };
    const cjsStep1State = { status: 'ok', count: 2 };
    const cjsBaseSnap = tieredCjs.SelectiveSnapshotter.createBaseSnapshot('cjs-snap-1', cjsBaseState);
    const cjsDeltaSnap = tieredCjs.SelectiveSnapshotter.createDeltaSnapshot(cjsBaseSnap, cjsBaseState, cjsStep1State, 0);
    const cjsHydrated = tieredCjs.SelectiveSnapshotter.hydrateState(cjsBaseSnap, [cjsDeltaSnap]);
    if (cjsHydrated.count !== 2) {
        throw new Error('CommonJS SelectiveSnapshotter hydration failed');
    }
    console.log('✓ CJS tieredCache subpath, VectorQuantizer, SelectiveSnapshotter, and TieredCache verified');

    const profilerCjs = require('./dist/swarm/profiler.cjs');
    if (!profilerCjs.UnifiedSwarmProfiler || !profilerCjs.PerformanceAnomalyDetector || !profilerCjs.runSwarmBenchmark || !profilerCjs.globalUnifiedProfiler) {
        throw new Error('CommonJS profiler exports missing');
    }
    const cjsProfiler = profilerCjs.UnifiedSwarmProfiler.getInstance();
    cjsProfiler.recordWorkflowRun({
        durationMs: 30,
        cache: { l1Hits: 1, savedTokens: 50 }
    });
    const cjsReport = cjsProfiler.getUnifiedBaselineReport();
    if (cjsReport.totalWorkflows <= 0) {
        throw new Error('CommonJS UnifiedSwarmProfiler failed');
    }
    const cjsDetector = new profilerCjs.PerformanceAnomalyDetector();
    cjsDetector.calibrate([10, 20, 30]);
    const cjsAnomaly = cjsDetector.checkLatency('test', 100);
    if (!cjsAnomaly) {
        throw new Error('CommonJS PerformanceAnomalyDetector failed');
    }
    const cjsBench = await profilerCjs.runSwarmBenchmark({ iterations: 2, batchSize: 2 });
    if (!cjsBench || cjsBench.totalIterations !== 2) {
        throw new Error('CommonJS runSwarmBenchmark failed');
    }
    console.log('✓ CJS profiler subpath, UnifiedSwarmProfiler, PerformanceAnomalyDetector, and runSwarmBenchmark verified');

    const feedbackCjs = require('./dist/swarm/feedback.cjs');
    if (!feedbackCjs.ContinuousFeedbackEngine || !feedbackCjs.PolicyOptimizer || !feedbackCjs.ConceptDriftDetector || !feedbackCjs.SwarmKnowledgeRepository || !feedbackCjs.globalFeedbackEngine) {
        throw new Error('CommonJS feedback exports missing');
    }
    const cjsOpt = new feedbackCjs.PolicyOptimizer();
    const cjsRew = cjsOpt.calculateReward({
        workflowId: 'wf-cjs',
        task: 'test',
        appId: 'cjs-app',
        durationMs: 50,
        targetTier: 'instant',
        tokenSavings: 100,
        tokensConsumed: 100,
        qualityScore: 0.90,
        errorCount: 0,
        anomalyCount: 0,
        timestamp: Date.now()
    });
    if (cjsRew.compositeReward <= 0.4) {
        throw new Error('CommonJS PolicyOptimizer reward calculation failed');
    }
    const cjsDrift = new feedbackCjs.ConceptDriftDetector();
    const cjsPayloadVal = cjsDrift.validateDataPayload('payload string');
    if (!cjsPayloadVal.valid) {
        throw new Error('CommonJS ConceptDriftDetector payload validation failed');
    }
    const cjsRepo = new feedbackCjs.SwarmKnowledgeRepository();
    await cjsRepo.recordOutcome({
        id: 'cjs-out-1',
        workflowId: 'wf-cjs',
        task: 'test',
        appId: 'cjs-app',
        finalInsightSnippet: 'snippet',
        metrics: {
            workflowId: 'wf-cjs',
            task: 'test',
            appId: 'cjs-app',
            durationMs: 50,
            targetTier: 'instant',
            tokenSavings: 100,
            tokensConsumed: 100,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        },
        reward: cjsRew,
        parametersUsed: cjsOpt.getCurrentPolicy(),
        driftAlerts: [],
        timestamp: Date.now()
    });
    if (cjsRepo.queryOutcomes({ appId: 'cjs-app' }).length !== 1) {
        throw new Error('CommonJS SwarmKnowledgeRepository failed');
    }
    console.log('✓ CJS feedback subpath, PolicyOptimizer, ConceptDriftDetector, and SwarmKnowledgeRepository verified');

    const kgCjs = require('./dist/swarm/knowledgeGraph.cjs');
    if (!kgCjs.SharedKnowledgeGraph || !kgCjs.globalKnowledgeGraph) {
        throw new Error('CommonJS knowledgeGraph exports missing');
    }
    const cjsGraph = new kgCjs.SharedKnowledgeGraph();
    cjsGraph.addNode({ id: 'c-n1', type: 'entity', label: 'CJS Node' });
    cjsGraph.addNode({ id: 'c-n2', type: 'finding', label: 'CJS Finding' });
    cjsGraph.addEdge({ source: 'c-n1', target: 'c-n2', relation: 'supports' });
    if (cjsGraph.getVersion() !== 3 || cjsGraph.getStats().totalNodes !== 2) {
        throw new Error('CommonJS SharedKnowledgeGraph node operations failed');
    }
    console.log('✓ CJS knowledgeGraph subpath and SharedKnowledgeGraph verified');

    const coordCjs = require('./dist/swarm/coordination.cjs');
    if (!coordCjs.AgentAdaptiveLearningRateManager || !coordCjs.HierarchicalTaskDecomposer || !coordCjs.HypothesisValidationLayer || !coordCjs.ShapedRewardPolicy) {
        throw new Error('CommonJS coordination exports missing');
    }
    const cjsDecomp = new coordCjs.HierarchicalTaskDecomposer();
    const cjsPlan = cjsDecomp.decompose('CJS macro task', ['Security Analyst']);
    if (cjsPlan.subtasks.length < 3) {
        throw new Error('CommonJS HierarchicalTaskDecomposer failed');
    }
    const cjsHypoLayer = new coordCjs.HypothesisValidationLayer(cjsGraph);
    const cjsHypo = cjsHypoLayer.proposeHypothesis({ claim: 'CJS claim test', proposedBy: 'Tester' });
    const cjsVal = cjsHypoLayer.validateHypothesis(cjsHypo.id, { isValid: true, validatedBy: 'Manager' });
    if (!cjsVal || cjsVal.status !== 'validated' || !cjsGraph.getNode(`node-${cjsHypo.id}`)) {
        throw new Error('CommonJS HypothesisValidationLayer failed');
    }
    const cjsLR = new coordCjs.AgentAdaptiveLearningRateManager();
    const cjsRate = cjsLR.recordAgentStep('agent-cjs', 0.9);
    if (!cjsRate.newRate) {
        throw new Error('CommonJS AgentAdaptiveLearningRateManager failed');
    }
    console.log('✓ CJS coordination subpath, HierarchicalTaskDecomposer, and HypothesisValidationLayer verified');

    const healthCjs = require('./dist/swarm/health.cjs');
    if (!healthCjs.TwoTierModelHealthChecker || !healthCjs.ModelCircuitBreaker || !healthCjs.ModelHealthCache || !healthCjs.globalModelHealthChecker) {
        throw new Error('CommonJS health exports missing');
    }
    const cjsChecker = new healthCjs.TwoTierModelHealthChecker();
    const cjsHealth = await cjsChecker.checkModel({ provider: 'simulated', modelId: 'cjs-sim' });
    if (!cjsHealth.healthy || cjsHealth.circuitState !== 'CLOSED') {
        throw new Error('CommonJS TwoTierModelHealthChecker simulation failed');
    }
    console.log('✓ CJS health subpath, TwoTierModelHealthChecker, and ModelCircuitBreaker verified');

    console.log('✓ ALL COMMONJS SWARM DISTRIBUTION TESTS PASSED!\n');
}

testCjsImport().catch(err => {
    console.error('CJS test failed:', err);
    process.exit(1);
});
