import {
    Agent,
    SwarmContext,
    ProviderRegistry,
    ModelRouter,
    MemoryCortex,
    DeterministicLocalEmbeddingProvider,
    SparseTokenizer,
    AnalysisLifecycle,
    PayloadCache,
    AdaptiveLoadBalancer,
    globalLoadBalancer,
    SwarmEngine,
    executeSwarmWorkflow,
    OpenRouterAdapter,
    getOrCreateDefaultCortex,
    ToolRegistry,
    globalToolRegistry,
    calculatorTool,
    statsSummaryTool,
    regexMatchTool,
    jsonExtractTool,
    dataFilterTool,
    stringSimilarityTool,
    dateMathTool,
    repairJson,
    parseJsonSafe,
    guardAnalystResponse,
    guardManagerResponse,
    guardVerificationResult,
    repairAndValidate,
    createSwarmClient,
    SwarmClient,
    RRF_PRESETS
} from './swarm.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function runPortableValidation() {
    console.log('=== Step 1: Provider Registry Verification ===');
    const providers = ProviderRegistry.list();
    console.log('Registered Providers:', providers);
    if (!providers.includes('gemini') || !providers.includes('openrouter') || !providers.includes('groq')) {
        throw new Error('Core providers missing from registry');
    }

    console.log('\n=== Step 2: Custom Provider Extension Test ===');
    ProviderRegistry.register({
        providerName: 'custom-mock',
        async call(opts) {
            if (opts.prompt.includes('Evaluate this proposal')) {
                return JSON.stringify({ pass: true, feedback: 'Verified successfully against all criteria.' });
            }
            if (opts.systemInstruction?.includes('Swarm Orchestrator') || opts.prompt.includes('Analyst Reports:')) {
                return JSON.stringify({
                    ui_title: 'Cluster Security Dashboard',
                    components: [
                        { id: 'c1', type: 'InsightList', props: { title: 'Insights', insights: [{ type: 'info', message: 'Policy enforced' }] } }
                    ]
                });
            }
            if (opts.systemInstruction?.includes('Specialized Analyst') || opts.prompt.includes('Data Chunk')) {
                return JSON.stringify({
                    insights: ['Endpoint authenticated', 'Policy verified'],
                    anomalies: [],
                    summary: 'Policy enforcement check completed.'
                });
            }
            return JSON.stringify({ title: 'Synthesized proposal', metric: 42, summary: `Processed: ${opts.prompt.substring(0, 30)}...` });
        }
    });
    console.log('Registered custom-mock provider. All providers:', ProviderRegistry.list());

    console.log('\n=== Step 3: Swarm Context & Event Subscriptions ===');
    const context = new SwarmContext();
    const recordedEvents: string[] = [];
    context.subscribe(event => {
        recordedEvents.push(`[${event.agentRole}] ${event.action}`);
    });

    console.log('\n=== Step 4: ModelRouter Task Inference & Fast-Path Pre-Filtering ===');
    const fastDecision = ModelRouter.evaluateFastPath('What is 2 + 2?');
    const fastDecisionWithSmallData = ModelRouter.evaluateFastPath('Lookup user id', 'id=42');
    const deepNegative = ModelRouter.evaluateFastPath('Perform root cause audit of latency spikes');
    const largeDataNegative = ModelRouter.evaluateFastPath('Quick summary', 'x'.repeat(300));
    const deepAnalysisFlagNegative = ModelRouter.evaluateFastPath('Quick summary', '', true);

    const simpleComplexity = ModelRouter.inferComplexity('Summarize this receipt in 2 bullets', 1000);
    const complexComplexity = ModelRouter.inferComplexity('Deep audit and root cause security verification of memory leaks');
    const instantComplexity = ModelRouter.inferComplexity('Hello world');

    console.log('Fast-path decision for trivial query:', fastDecision);
    console.log('Fast-path decision for small data query:', fastDecisionWithSmallData);
    console.log('Fast-path decision for audit query:', deepNegative);
    console.log('Inferred instant task complexity:', instantComplexity);

    if (!fastDecision.eligible || fastDecision.targetTier !== 'instant') {
        throw new Error('Fast-path failed to identify low-complexity intent');
    }
    if (!fastDecisionWithSmallData.eligible) {
        throw new Error('Fast-path failed to accept small data query (<256 chars)');
    }
    if (deepNegative.eligible || largeDataNegative.eligible || deepAnalysisFlagNegative.eligible) {
        throw new Error('Fast-path falsely accepted complex or deep query');
    }
    if (instantComplexity !== 'instant' || simpleComplexity !== 'simple' || complexComplexity !== 'complex') {
        throw new Error('ModelRouter complexity tier mapping failure');
    }

    const forceFullSwarmDecision = ModelRouter.evaluateFastPath('What is 2 + 2?', '', false, true);
    const forceFullSwarmComplexity = ModelRouter.inferComplexity('Hello world', 0, 1, true);
    if (forceFullSwarmDecision.eligible || forceFullSwarmDecision.targetTier === 'instant') {
        throw new Error('Fast-path override failed to disable fast-path eligibility when forceFullSwarm=true');
    }
    if (forceFullSwarmComplexity === 'instant') {
        throw new Error('ModelRouter complexity tier failed to upgrade instant when forceFullSwarm=true');
    }

    /*
    console.log('\n=== Step 4b: Guaranteed Free-Tier Model Routing & OpenRouter :free Resolution ===');
    const orComplex = ModelRouter.getRecommendedModel('openrouter', 'complex');
    const orInstant = ModelRouter.getRecommendedModel('openrouter', 'instant');
    const geminiComplex = ModelRouter.getRecommendedModel('gemini', 'complex');
    const mistralComplex = ModelRouter.getRecommendedModel('mistral', 'complex');
    const resolvedFree = OpenRouterAdapter.resolveFreeModel('deepseek/deepseek-r1');
    const alreadyFree = OpenRouterAdapter.resolveFreeModel('meta-llama/llama-3.3-70b-instruct:free');
    const customFree = OpenRouterAdapter.resolveFreeModel('qwen/qwen-2.5-coder-32b-instruct');

    console.log('OpenRouter Complex Model:', orComplex);
    console.log('OpenRouter Instant Model:', orInstant);
    console.log('Gemini Complex Model (free tier):', geminiComplex);
    console.log('Mistral Complex Model (free tier):', mistralComplex);
    console.log('Resolved free model (from deepseek/deepseek-r1):', resolvedFree);

    if (!orComplex.endsWith(':free') || !orInstant.endsWith(':free')) {
        throw new Error('OpenRouter recommended model missing guaranteed :free suffix');
    }
    if (geminiComplex !== 'gemini-2.5-flash') {
        throw new Error('Gemini complex model should default to gemini-2.5-flash for high quota free tier');
    }
    if (mistralComplex !== 'mistral-small-latest') {
        throw new Error('Mistral complex model should default to mistral-small-latest');
    }
    if (resolvedFree !== 'deepseek/deepseek-r1:free' || alreadyFree !== 'meta-llama/llama-3.3-70b-instruct:free' || customFree !== 'qwen/qwen-2.5-coder-32b-instruct:free') {
        throw new Error('OpenRouterAdapter.resolveFreeModel resolution failure');
    }
    */

    console.log('\n=== Step 5: Agent Execution via Custom Adapter ===');
    const agent = new Agent('Mock Analyst', 'mock-v1', 'custom-mock', 'fake-key');
    const output = await agent.run('Hello swarm world', context);
    console.log('Agent run output:', output);

    console.log('\n=== Step 6: AnalysisLifecycle Verification Loop ===');
    const critic = new Agent('Critic Analyst', 'mock-v1', 'custom-mock', 'fake-key');
    const lifecycle = new AnalysisLifecycle(agent, critic, 2);
    const lifecycleResult = await lifecycle.executeAndVerify(
        { sample: 'data' },
        context,
        'Propose an analysis',
        'Verify this analysis'
    );
    console.log('Lifecycle success:', lifecycleResult.success);
    console.log('Lifecycle computed RLAIF score:', lifecycleResult.computedRating);
    console.log('Lifecycle critic feedback:', lifecycleResult.criticFeedback);
    if (lifecycleResult.computedRating !== 0.98) {
        throw new Error(`Expected first attempt pass RLAIF score to be 0.98, got ${lifecycleResult.computedRating}`);
    }

    const attempt2Score = AnalysisLifecycle.computeReinforcementScore(true, 2, 3);
    const failureScore = AnalysisLifecycle.computeReinforcementScore(false, 3, 3);
    console.log('Computed attempt 2 RLAIF score:', attempt2Score);
    console.log('Computed failure RLAIF score:', failureScore);
    if (attempt2Score !== 0.88 || failureScore > 0.40) {
        throw new Error('AnalysisLifecycle.computeReinforcementScore calibration error');
    }

    console.log('\n=== Step 7: Zero-cost Deterministic Dense Embeddings ===');
    const embeddingProvider = new DeterministicLocalEmbeddingProvider();
    const vec1 = await embeddingProvider.embed('Anomalous memory spike in worker pool');
    const vec2 = await embeddingProvider.embed('Anomalous memory spike in worker pool');
    const vec3 = await embeddingProvider.embed('Completely unrelated cooking recipe for pasta');

    console.log(`Vector dimensions: ${vec1.length}`);
    if (vec1.length !== 768) throw new Error(`Expected 768 dimensions, got ${vec1.length}`);
    const norm = Math.sqrt(vec1.reduce((sum, v) => sum + v * v, 0));
    if (Math.abs(norm - 1.0) > 0.001) throw new Error(`Expected L2 normalized vector (1.0), got ${norm}`);

    const cosIdentical = vec1.reduce((sum, v, i) => sum + v * vec2[i], 0);
    const cosDivergent = vec1.reduce((sum, v, i) => sum + v * vec3[i], 0);
    console.log(`Deterministic cosine identical: ${cosIdentical.toFixed(4)}, divergent: ${cosDivergent.toFixed(4)}`);
    if (Math.abs(cosIdentical - 1.0) > 0.0001) throw new Error('Identical texts must produce cosine similarity 1.0');
    if (cosDivergent >= cosIdentical) throw new Error('Divergent texts must produce lower cosine similarity');

    console.log('\n=== Step 8: Lexical BM25 Sparse Vector Tokenizer ===');
    const sparse = SparseTokenizer.encode('Rate limit 429 quota exceeded error on model router');
    console.log(`Sparse vector indices: ${sparse.indices.length}, values: ${sparse.values.length}`);
    if (sparse.indices.length === 0 || sparse.values.length !== sparse.indices.length) {
        throw new Error('SparseTokenizer generated invalid sparse vector payload');
    }

    console.log('\n=== Step 9: Free-Tier AI Failover Cascade Verification ===');
    ProviderRegistry.register({
        providerName: 'mock-failing-rate-limit',
        async call() {
            throw new Error('[RATE_LIMIT_429] Mock quota exceeded: 429 Too Many Requests');
        }
    });

    ProviderRegistry.register({
        providerName: 'mock-backup-success',
        async call(opts) {
            return JSON.stringify({ recovered: true, source: 'backup-provider', task: opts.prompt });
        }
    });

    const resilientAgent = new Agent(
        'Resilient Worker',
        'rate-limited-v1',
        'mock-failing-rate-limit',
        'key1',
        undefined,
        [{ provider: 'mock-backup-success', apiKey: 'key2', modelName: 'backup-v1' }]
    );

    const failoverResult = await resilientAgent.run('Critical task', context, { responseMimeType: 'application/json' });
    console.log('Failover recovered output:', failoverResult);
    if (!failoverResult.recovered || failoverResult.source !== 'backup-provider') {
        throw new Error('Failover cascade failed to recover execution');
    }

    console.log('\n=== Step 10: Reasoning Model (<think>) Tag Sanitization ===');
    ProviderRegistry.register({
        providerName: 'mock-reasoning-model',
        async call() {
            return `<think>\nInternal chain of thought reasoning...\nExamining parameters...\nFinal decision reached.\n</think>\n\`\`\`json\n{\n  "status": "success",\n  "cleanParsed": true\n}\n\`\`\``;
        }
    });

    const reasoningAgent = new Agent('Reasoning Worker', 'deepseek-r1', 'mock-reasoning-model', 'fake-key');
    const sanitizedOutput = await reasoningAgent.run('Analyze', context, { responseMimeType: 'application/json' });
    console.log('Sanitized reasoning output:', sanitizedOutput);
    if (!sanitizedOutput.cleanParsed) {
        throw new Error('Failed to sanitize reasoning model <think> tags');
    }

    console.log('\n=== Step 11: Continuous Learning Cortex & Multi-App Namespacing ===');
    const mockStore: any[] = [];
    const mockPayloadUpdates: any[] = [];
    const mockQueries: any[] = [];
    const mockCreatedIndexes: any[] = [];

    const mockQdrantClient: any = {
        async getCollections() {
            return { collections: [{ name: 'test_collection' }] };
        },
        async createPayloadIndex(col: string, params: any) {
            mockCreatedIndexes.push(params);
            return { status: 'ok' };
        },
        async scroll(col: string, params: any) {
            const appId = params?.filter?.must?.find((m: any) => m.key === 'appId')?.match?.value;
            let points = mockStore;
            if (appId) {
                points = mockStore.filter(p => p.payload.appId === appId);
            }
            return { points: points.map(p => ({ id: p.id, payload: p.payload })) };
        },
        async delete(col: string, params: any) {
            if (params.points) {
                for (const pid of params.points) {
                    const idx = mockStore.findIndex(p => p.id === pid);
                    if (idx !== -1) mockStore.splice(idx, 1);
                }
            }
            return { status: 'ok' };
        },
        async query(col: string, queryParams: any) {
            mockQueries.push(queryParams);
            if (queryParams.score_threshold === 0.92) {
                const appId = queryParams.filter?.must?.find((m: any) => m.key === 'appId')?.match?.value;
                const queryVector = queryParams.query;
                for (const pt of mockStore) {
                    if (pt.payload.appId === appId && pt.vector?.dense && queryVector) {
                        let dot = 0;
                        for (let i = 0; i < queryVector.length; i++) dot += queryVector[i] * pt.vector.dense[i];
                        if (dot >= 0.92) {
                            return { points: [{ id: pt.id, score: dot, payload: pt.payload }] };
                        }
                    }
                }
                return { points: [] };
            }
            const appId = queryParams.prefetch?.[0]?.filter?.must?.find((m: any) => m.key === 'appId')?.match?.value;
            let matchingPoints = mockStore;
            if (appId) {
                matchingPoints = mockStore.filter(p => p.payload.appId === appId);
            }
            return {
                points: matchingPoints.map(p => ({
                    id: p.id,
                    score: 0.88,
                    payload: p.payload
                }))
            };
        },
        async upsert(col: string, upsertParams: any) {
            mockStore.push(...upsertParams.points);
            return { status: 'ok' };
        },
        async setPayload(col: string, payloadParams: any) {
            mockPayloadUpdates.push(payloadParams);
            for (const ptId of payloadParams.points) {
                const found = mockStore.find(p => p.id === ptId);
                if (found) {
                    found.payload = { ...found.payload, ...payloadParams.payload };
                }
            }
            return { status: 'ok' };
        }
    };

    const learningCortex = new MemoryCortex({
        url: 'http://localhost:6333',
        collectionName: 'test_collection',
        defaultAppId: 'app-analytics-core',
        embeddingProvider: new DeterministicLocalEmbeddingProvider()
    });
    (learningCortex as any).qdrant = mockQdrantClient;
    (learningCortex as any).isAvailable = true;

    // 11a: Verify Multi-App Namespacing & Initial Store
    const mem1Id = await learningCortex.store(
        'Anomalous memory spike detected in worker pool during batch processing',
        { domain: 'infrastructure', agentRole: 'Manager Node', appId: 'app-analytics-core', qualityRating: 0.8 }
    );
    console.log('Stored initial memory in app-analytics-core:', mem1Id);
    if (!mem1Id || (mockStore as any[]).length !== 1) throw new Error('Failed to store initial memory');
    if (mockStore[0].payload.appId !== 'app-analytics-core') throw new Error('appId namespace mismatch');

    // 11b: Verify Deduplication (>0.92 threshold updates frequency instead of new point)
    const mem1DuplicateId = await learningCortex.store(
        'Anomalous memory spike detected in worker pool during batch processing',
        { domain: 'infrastructure', agentRole: 'Manager Node', appId: 'app-analytics-core', qualityRating: 0.9 }
    );
    console.log('Deduplication result ID:', mem1DuplicateId, 'Total points:', (mockStore as any[]).length);
    if (mem1DuplicateId !== mem1Id || (mockStore as any[]).length !== 1) {
        throw new Error('Deduplication failed: expected point update, not duplicate creation');
    }
    if (mockStore[0].payload.frequency !== 2) {
        throw new Error(`Expected frequency 2 after deduplication, got ${mockStore[0].payload.frequency}`);
    }

    // 11c: Verify Multi-Tenant Isolation (same text in different appId creates separate point)
    const mem2Id = await learningCortex.store(
        'Anomalous memory spike detected in worker pool during batch processing',
        { domain: 'infrastructure', agentRole: 'Manager Node', appId: 'app-finance-reporting', qualityRating: 0.85 }
    );
    console.log('Stored in different namespace (app-finance-reporting):', mem2Id, 'Total points:', (mockStore as any[]).length);
    if ((mockStore as any[]).length !== 2) {
        throw new Error('Multi-tenant isolation failed: separate appId should store discrete vector');
    }

    // 11d: Verify Continuous Reinforcement Feedback (rateMemory)
    const rated = await learningCortex.rateMemory(mem1Id, 0.98, 'Confirmed critical root cause finding');
    console.log('Rated memory success:', rated);
    if (!rated || mockStore[0].payload.qualityRating !== 0.98 || !mockStore[0].payload.verified) {
        throw new Error('rateMemory failed to reinforce qualityRating and verified flag');
    }

    // 11e: Verify Few-Shot Exemplar Distillation (retrieveExemplars)
    const exemplars = await learningCortex.retrieveExemplars('worker memory issues', {
        appId: 'app-analytics-core',
        minRating: 0.7,
        limit: 2
    });
    console.log('Generated few-shot learning exemplars:\n', exemplars);
    if (!exemplars.includes('[Learning Exemplar 1]') || !exemplars.includes('Quality Rating: 98%')) {
        throw new Error('retrieveExemplars failed to distill high-quality past experiences');
    }

    // 11f: Verify Verified Payload Index Creation
    const verifiedIndex = mockCreatedIndexes.find(i => i.field_name === 'verified' && i.field_schema === 'bool');
    console.log('Verified payload index registered:', verifiedIndex);
    if (!verifiedIndex) {
        throw new Error('ensurePayloadIndex failed to create verified (bool) index');
    }

    console.log('\n=== Step 12: Deterministic Structured Payload Caching & Drift Prevention ===');
    const cache = new PayloadCache({ maxEntries: 2, defaultTtlMs: 1000 });

    const fp1 = PayloadCache.computeFingerprint('Analyze server latency', 'metric=cpu_idle', { appId: 'app-1' });
    const fp2 = PayloadCache.computeFingerprint('Analyze server latency', 'metric=cpu_idle', { appId: 'app-1' });
    const fp3 = PayloadCache.computeFingerprint('Analyze server latency', 'metric=cpu_idle', { appId: 'app-2' });

    console.log('Deterministic fingerprint 1:', fp1);
    console.log('Deterministic fingerprint 2 (identical parameters):', fp2);
    if (fp1 !== fp2) {
        throw new Error('PayloadCache fingerprints must be strictly deterministic');
    }
    if (fp1 === fp3) {
        throw new Error('PayloadCache fingerprints must isolate by appId');
    }

    // Set cache entry
    cache.set(fp1, { status: 'success', diagnosis: 'CPU idle anomaly' });
    const hit1 = cache.get(fp1);
    console.log('Cache hit output:', hit1);
    if (!hit1 || hit1.diagnosis !== 'CPU idle anomaly') {
        throw new Error('PayloadCache get failed to retrieve cached payload');
    }

    // Test LRU eviction (maxEntries = 2)
    cache.set('key-a', { id: 'a' });
    cache.set('key-b', { id: 'b' });
    if (cache.has(fp1)) {
        throw new Error('PayloadCache failed to evict least recently used entry');
    }
    if (!cache.has('key-a') || !cache.has('key-b')) {
        throw new Error('PayloadCache failed to preserve recent entries under LRU bound');
    }

    const stats = cache.getStats();
    console.log('PayloadCache stats:', stats);
    if (stats.evictions !== 1 || stats.hits < 1) {
        throw new Error('PayloadCache stats tracking failure');
    }



    console.log('\n=== Step 14: Real-Time Adaptive Load Balancer with Latency EMA & 429 Cooldown ===');
    const lb = new AdaptiveLoadBalancer({ emaAlpha: 0.5, rateLimitCooldownMs: 5000 });

    // 14a: Telemetry recording and EMA tracking
    lb.recordStart('provider-fast');
    lb.recordSuccess('provider-fast', 100);
    lb.recordStart('provider-fast');
    lb.recordSuccess('provider-fast', 200);

    lb.recordStart('provider-slow');
    lb.recordSuccess('provider-slow', 1500);

    const fastTel = lb.getTelemetry('provider-fast');
    const slowTel = lb.getTelemetry('provider-slow');
    console.log('Fast provider telemetry:', fastTel);
    console.log('Slow provider telemetry:', slowTel);

    if (fastTel.latencyEmaMs >= slowTel.latencyEmaMs) {
        throw new Error('Latency EMA calculation failure: fast provider EMA should be lower');
    }

    // 14b: Provider candidate scoring and selection
    const candidateA = { provider: 'provider-fast', apiKey: 'k1' };
    const candidateB = { provider: 'provider-slow', apiKey: 'k2' };
    const selected1 = lb.selectOptimalProvider([candidateA, candidateB]);
    console.log('Optimal provider selected (expecting provider-fast):', selected1.provider);
    if (selected1.provider !== 'provider-fast') {
        throw new Error('AdaptiveLoadBalancer failed to select lower latency provider');
    }

    // 14c: Rate Limit 429 Cooldown & Dynamic Downweighting
    lb.recordStart('provider-fast');
    lb.recordFailure('provider-fast', new Error('[RATE_LIMIT_429] 429 Too Many Requests: TPM limit exceeded'));

    const fastAfter429 = lb.getTelemetry('provider-fast');
    console.log('Provider-fast telemetry after 429:', fastAfter429);
    if (fastAfter429.status !== 'cooldown' || !fastAfter429.cooldownUntil) {
        throw new Error('AdaptiveLoadBalancer failed to enter cooldown on 429 error');
    }

    const selected2 = lb.selectOptimalProvider([candidateA, candidateB]);
    console.log('Optimal provider selected after 429 (expecting provider-slow):', selected2.provider);
    if (selected2.provider !== 'provider-slow') {
        throw new Error('AdaptiveLoadBalancer failed to route away from provider in 429 cooldown');
    }

    // 14d: Execute With Telemetry wrapper
    let callExecuted = false;
    const telemetryResult = await lb.executeWithTelemetry('provider-wrapped', async () => {
        callExecuted = true;
        return { ok: true, data: 42 };
    });
    if (!callExecuted || !telemetryResult.ok) {
        throw new Error('executeWithTelemetry wrapper failed');
    }

    console.log('\n=== Step 15: Headless SwarmEngine Execution Verification ===');
    const engineResult = await executeSwarmWorkflow({
        task: 'Trivial health ping',
        data: 'system=online',
        settings: {
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-mgr' },
                { id: 'analyst-1', role: 'Analyst', provider: 'custom-mock', model: 'mock-v1', apiKey: 'k-an1' }
            ]
        }
    });
    console.log('Engine workflow fast-path execution title:', engineResult.finalAnalysis?.ui_title);
    if (!engineResult.finalAnalysis || !engineResult.finalAnalysis.ui_title) {
        throw new Error('SwarmEngine headless execution failed to produce valid final analysis');
    }

    console.log('\n=== Step 17: Qdrant Cortex Optimization, Memory Pruning & Ephemeral In-Memory Fallback ===');
    
    // 17a: Consolidate / Prune low-quality memories in Qdrant-backed mode
    const lowQualityMemId = await learningCortex.store(
        'Flaky transient timeout that failed verification',
        { domain: 'infrastructure', agentRole: 'Analyst', appId: 'app-analytics-core', qualityRating: 0.25 }
    );
    console.log('Stored low-quality point for pruning test:', lowQualityMemId);
    const prePruneCount = mockStore.length;
    
    const pruneResult = await learningCortex.consolidateMemories({
        appId: 'app-analytics-core',
        minRating: 0.40,
        pruneLowQuality: true
    });
    console.log('Qdrant-backed consolidation result:', pruneResult);
    if (pruneResult.pruned !== 1 || !pruneResult.prunedIds.includes(lowQualityMemId!)) {
        throw new Error('consolidateMemories failed to prune low-quality point in Qdrant-backed mode');
    }
    if (mockStore.length !== prePruneCount - 1) {
        throw new Error('mockStore did not decrease by pruned point count');
    }

    // 17b: Ephemeral In-Memory Vector Fallback (Zero-Qdrant Offline Operation)
    const offlineCortex = new MemoryCortex({
        defaultAppId: 'offline-tenant-app',
        isolatedStore: true,
        embeddingProvider: new DeterministicLocalEmbeddingProvider()
    });
    console.log('Offline cortex ready state:', offlineCortex.ready);
    if (!offlineCortex.ready) {
        throw new Error('Offline MemoryCortex should be immediately ready with fallbackStore');
    }

    // Store memories into in-memory fallback
    const off1 = await offlineCortex.store(
        'Critical cache invalidation deadlock on Redis cluster',
        { domain: 'infrastructure', agentRole: 'Cache Specialist', qualityRating: 0.95, verified: true }
    );
    // Deduplication in fallbackStore
    const off1Dup = await offlineCortex.store(
        'Critical cache invalidation deadlock on Redis cluster',
        { domain: 'infrastructure', agentRole: 'Cache Specialist', qualityRating: 0.98 }
    );
    if (off1 !== off1Dup || (offlineCortex.fallbackCount as number) !== 1) {
        throw new Error('FallbackStore deduplication failed');
    }

    // Store low quality point
    const offLow = await offlineCortex.store(
        'Sporadic unverified jitter in connection handshake',
        { domain: 'network', agentRole: 'Network Analyst', qualityRating: 0.30 }
    );

    // Store shared global point
    const offShared = await offlineCortex.store(
        'Enterprise auth token standard schema and lifetime',
        { domain: 'security', agentRole: 'Security Architect', appId: 'global', qualityRating: 0.92, verified: true }
    );

    console.log(`Stored ${offlineCortex.fallbackCount} memories in ephemeral fallbackStore`);
    if ((offlineCortex.fallbackCount as number) !== 3) {
        throw new Error(`Expected 3 fallbackStore items, found ${offlineCortex.fallbackCount}`);
    }

    // 17c: Dense + Sparse Hybrid RRF Retrieval in Fallback Mode
    const retrievedOffline = await offlineCortex.retrieve('cache deadlock on Redis', {
        appId: 'offline-tenant-app',
        limit: 2
    });
    console.log('Retrieved from in-memory fallback:', retrievedOffline.map(m => m.content));
    if (retrievedOffline.length === 0 || !retrievedOffline[0].content.includes('Redis')) {
        throw new Error('In-memory hybrid retrieval failed to return relevant experience');
    }

    // 17d: Cross-App Shared Learning Baseline Retrieval
    const sharedRetrieved = await offlineCortex.retrieve('auth token standard', {
        appId: 'offline-tenant-app',
        includeShared: true,
        limit: 2
    });
    console.log('Cross-app shared retrieval result:', sharedRetrieved.map(m => ({ appId: m.appId, content: m.content })));
    if (!sharedRetrieved.some(m => m.appId === 'global')) {
        throw new Error('includeShared retrieval failed to return global learning baseline');
    }

    // 17e: Few-Shot Exemplar Distillation in Fallback Mode
    const offlineExemplars = await offlineCortex.retrieveExemplars('Redis cache deadlock', {
        appId: 'offline-tenant-app',
        minRating: 0.8
    });
    console.log('Generated offline exemplars:\n', offlineExemplars);
    if (!offlineExemplars.includes('[Learning Exemplar 1]') || !offlineExemplars.includes('Quality Rating: 98%')) {
        throw new Error('retrieveExemplars failed in ephemeral in-memory mode');
    }

    // 17f: In-Memory Consolidation / Pruning (< 0.40)
    const offlinePrune = await offlineCortex.consolidateMemories({
        appId: 'offline-tenant-app',
        minRating: 0.40,
        pruneLowQuality: true
    });
    console.log('Offline consolidation result:', offlinePrune);
    if (offlinePrune.pruned !== 1 || !offlinePrune.prunedIds.includes(offLow!)) {
        throw new Error('Offline consolidateMemories failed to prune low quality memory');
    }
    if ((offlineCortex.fallbackCount as number) !== 2) {
        throw new Error(`Expected 2 remaining points in fallbackStore after pruning, found ${offlineCortex.fallbackCount}`);
    }

    console.log('\n=== Step 18: Unconditional Engine Cortex Binding & Multi-Run In-Memory Learning ===');
    const multiRunAppId = 'test-unconditional-learning-app';

    // Seed a global shared learning baseline into the default cortex for this session
    const globalCortex = getOrCreateDefaultCortex('shared');
    await globalCortex.store('Shared Security Baseline: All API endpoints must enforce Bearer token validation and rate limiting.', {
        domain: 'security',
        agentRole: 'Global Policy Analyst',
        qualityRating: 0.99,
        verified: true,
        appId: 'shared'
    });

    // Run 1: Run headless workflow without QDRANT_URL. It should retrieve the shared baseline!
    const run1Result = await executeSwarmWorkflow({
        task: 'Enforce security policy on customer portal API',
        data: 'endpoint=/api/customers, auth=none',
        settings: {
            appId: multiRunAppId,
            includeShared: true,
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Security Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const retrievalEvent = run1Result.events.find(e => e.action === 'Cortex Retrieval Complete');
    if (!retrievalEvent) {
        throw new Error('Step 18: executeSwarmWorkflow failed to perform Cortex Retrieval in offline mode');
    }
    console.log('✓ Cortex Retrieval succeeded in offline mode:', retrievalEvent.output);

    // Verify Run 1 persisted its result to the in-memory cortex
    const appCortex = getOrCreateDefaultCortex(multiRunAppId);
    const learnedMemories = await appCortex.retrieve('customer portal API', { appId: multiRunAppId });
    console.log('✓ Learned memory persisted to appCortex:', learnedMemories.map(m => m.content));
    if (learnedMemories.length === 0) {
        throw new Error('Step 18: executeSwarmWorkflow failed to persist execution into in-memory cortex');
    }

    // Run 2: Injected custom cortex verification
    const isolatedCustomCortex = new MemoryCortex({ defaultAppId: 'custom-injected-app' });
    await isolatedCustomCortex.store('Custom injected knowledge: P99 latency SLA is 20ms.', {
        domain: 'performance',
        agentRole: 'Performance Architect',
        qualityRating: 0.95,
        verified: true,
        appId: 'custom-injected-app'
    });

    const run2Result = await executeSwarmWorkflow({
        task: 'Audit latency SLAs across all microservices and database tiers',
        enableDeepAnalysis: true,
        cortex: isolatedCustomCortex,
        settings: {
            appId: 'custom-injected-app',
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Performance Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });
    const run2Retrieval = run2Result.events.find(e => e.action === 'Cortex Retrieval Complete');
    console.log('Run 2 retrieval event output:', run2Retrieval?.output);
    console.log('Run 2 all event actions:', run2Result.events.map(e => e.action));
    if (!run2Retrieval || !run2Retrieval.output?.message.includes('Custom injected knowledge')) {
        throw new Error('Step 18: Injected custom cortex was not utilized in executeSwarmWorkflow');
    }
    console.log('✓ Injected custom cortex verified in Run 2');

    console.log('\n=== Step 19: Dedicated Critic Routing, Cross-Provider Critic & Fast-Path Learning Capture ===');

    // 19a: Fast-path execution records into MemoryCortex with heuristic feedback
    const fastAppId = 'app-fast-path-learning';
    const fastCortex = getOrCreateDefaultCortex(fastAppId);

    await executeSwarmWorkflow({
        task: 'Ping database connection',
        settings: {
            appId: fastAppId,
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Database Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const fastMemories = await fastCortex.retrieve('Ping database connection', { appId: fastAppId });
    console.log('Fast-path recorded memories:', fastMemories.map(m => ({ content: m.content, feedback: m.feedback })));
    if (fastMemories.length === 0 || !fastMemories[0].feedback?.includes('Fast-path short-circuit')) {
        throw new Error('Step 19a: Fast-path execution failed to record into MemoryCortex with heuristic feedback');
    }
    console.log('✓ Fast-path execution learning capture verified');

    // 19b: Cross-provider Critic selection (Manager on custom-mock, Analyst 1 on custom-mock, Analyst 2 on backup-mock)
    ProviderRegistry.register({
        providerName: 'backup-mock',
        async call(opts) {
            if (opts.prompt.includes('Evaluate this proposal') || opts.systemInstruction?.includes('Verification Critic')) {
                return JSON.stringify({ pass: true, feedback: 'Cross-provider verification passed with zero discrepancies.' });
            }
            return JSON.stringify({ insights: ['Backup analyst insight'], anomalies: [], summary: 'Done' });
        }
    });

    const crossProviderResult = await executeSwarmWorkflow({
        task: 'Deep security audit of API token rotation',
        enableDeepAnalysis: true,
        settings: {
            appId: 'cross-provider-test',
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Primary Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a2', role: 'Secondary Analyst', provider: 'backup-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const crossCriticEvent = crossProviderResult.events.find(e => e.action === 'Deep Analysis Verification Loop Started');
    console.log('Cross-provider Critic modelName:', crossCriticEvent?.modelName);
    if (!crossCriticEvent || !crossCriticEvent.modelName.includes('backup-mock')) {
        throw new Error('Step 19b: Failed to select cross-provider analyst as Critic');
    }
    console.log('✓ Cross-provider critic selection verified');

    // 19c: Explicit Dedicated Critic Agent Configuration
    const dedicatedCriticResult = await executeSwarmWorkflow({
        task: 'Deep compliance audit of PII storage',
        enableDeepAnalysis: true,
        settings: {
            appId: 'dedicated-critic-test',
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Compliance Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'critic', role: 'Chief Compliance Auditor', provider: 'backup-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const dedicatedCriticEvent = dedicatedCriticResult.events.find(e => e.action === 'Deep Analysis Verification Loop Started');
    console.log('Dedicated Critic modelName:', dedicatedCriticEvent?.modelName);
    if (!dedicatedCriticEvent || !dedicatedCriticEvent.modelName.includes('backup-mock')) {
        throw new Error('Step 19c: Failed to utilize explicit dedicated Critic agent');
    }
    console.log('\n=== Step 20: Automated Memory Consolidation & Weighted Hybrid RRF Scoring ===');

    // 20a: Automated Consolidation Threshold Trigger
    const autoConsolidateCortex = new MemoryCortex({
        defaultAppId: 'auto-prune-app',
        isolatedStore: true,
        autoConsolidateThreshold: 3,
        autoConsolidationOptions: { minRating: 0.5, pruneLowQuality: true }
    });

    await autoConsolidateCortex.store('Transient flaky socket disconnect', {
        domain: 'network',
        agentRole: 'Analyst',
        qualityRating: 0.20
    });
    await autoConsolidateCortex.store('Definitive zero-trust IAM policy blueprint', {
        domain: 'security',
        agentRole: 'Architect',
        qualityRating: 0.95
    });

    console.log('Pending stores before threshold:', autoConsolidateCortex.getPendingConsolidationCount());
    console.log('Fallback count before threshold:', autoConsolidateCortex.fallbackCount);
    if (autoConsolidateCortex.getPendingConsolidationCount() !== 2 || autoConsolidateCortex.fallbackCount !== 2) {
        throw new Error('Step 20a: Pending count or fallback count mismatch before threshold trigger');
    }

    // 3rd store reaches threshold (3) -> auto-consolidates!
    await autoConsolidateCortex.store('Optimized database connection pooling configuration', {
        domain: 'database',
        agentRole: 'DBA',
        qualityRating: 0.88
    });

    console.log('Pending stores after threshold:', autoConsolidateCortex.getPendingConsolidationCount());
    console.log('Fallback count after auto-prune:', autoConsolidateCortex.fallbackCount);
    if (autoConsolidateCortex.getPendingConsolidationCount() !== 0) {
        throw new Error('Step 20a: pendingConsolidationCount was not reset after auto-consolidation');
    }
    if (autoConsolidateCortex.fallbackCount !== 2) {
        throw new Error(`Step 20a: Expected 2 points retained after auto-pruning, found ${autoConsolidateCortex.fallbackCount}`);
    }

    const remainingMemories = await autoConsolidateCortex.retrieve('socket', { minRating: 0 });
    if (remainingMemories.some(m => m.qualityRating < 0.5)) {
        throw new Error('Step 20a: Low quality memory was not pruned by auto-consolidation');
    }
    console.log('✓ Automated memory consolidation threshold trigger verified');

    // 20b: Weighted Hybrid RRF Scoring (denseWeight vs sparseWeight)
    const weightedCortex = new MemoryCortex({
        defaultAppId: 'weighted-rrf-app',
        isolatedStore: true
    });

    await weightedCortex.store('Postgres connection pool exhaustion under high concurrency spike', {
        domain: 'database',
        agentRole: 'DBA',
        qualityRating: 0.9
    });
    await weightedCortex.store('Relational database storage replication delay and failover procedures', {
        domain: 'database',
        agentRole: 'DBA',
        qualityRating: 0.9
    });

    // When dense weight dominates
    const densePriorityResults = await weightedCortex.retrieve('Postgres pool', {
        denseWeight: 5.0,
        sparseWeight: 0.2,
        limit: 2
    });
    // When sparse weight dominates
    const sparsePriorityResults = await weightedCortex.retrieve('Postgres pool', {
        denseWeight: 0.2,
        sparseWeight: 5.0,
        limit: 2
    });

    if (densePriorityResults.length === 0 || sparsePriorityResults.length === 0) {
        throw new Error('Step 20b: Weighted RRF retrieval returned empty results');
    }
    console.log('✓ Weighted RRF retrieval verified with dense/sparse weights');

    console.log('\n=== Step 21: End-to-End Multi-Session Continuous Learning Verification ===');
    const continuousLearningAppId = 'continuous-learning-production-app';
    const prodCortex = getOrCreateDefaultCortex(continuousLearningAppId);

    // Session 1: Initial analysis
    const session1Task = 'Mitigate distributed denial of service attack on API gateways';
    await executeSwarmWorkflow({
        task: session1Task,
        enableDeepAnalysis: true,
        settings: {
            appId: continuousLearningAppId,
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Security Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const session1Persisted = await prodCortex.retrieve(session1Task, { appId: continuousLearningAppId });
    if (session1Persisted.length === 0) {
        throw new Error('Step 21: Session 1 failed to persist analysis to MemoryCortex');
    }
    console.log('✓ Session 1 analysis successfully persisted to cortex');

    // Reinforce Session 1 with verified human/critic feedback
    const session1Point = session1Persisted[0];
    const pointId = (prodCortex as any).fallbackStore.find((p: any) => p.payload.content === session1Point.content)?.id;
    if (pointId) {
        await prodCortex.rateMemory(pointId, 0.98, 'Strict guideline: Always apply eBPF SYN-flood drops before cloud WAF throttling.');
    }

    // Session 2: Subsequent execution on related task retrieves Session 1's feedback exemplar
    const session2Task = 'Handle severe SYN flood traffic spike on edge gateway';
    const session2Result = await executeSwarmWorkflow({
        task: session2Task,
        enableDeepAnalysis: true,
        settings: {
            appId: continuousLearningAppId,
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Security Analyst', provider: 'custom-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const session2Retrieval = session2Result.events.find(e => e.action === 'Cortex Retrieval Complete');
    console.log('Session 2 cortex retrieval output:', session2Retrieval?.output);
    if (!session2Retrieval || !session2Retrieval.output?.message.includes('eBPF SYN-flood drops')) {
        throw new Error('Step 21: Session 2 failed to retrieve reinforced feedback exemplar from Session 1');
    }
    console.log('✓ Multi-session continuous learning loop verified end-to-end');

    console.log('\n=== Step 22: Zero-Dependency Free Tool & Function Calling Framework Verification ===');

    // 22a: Test built-in tools directly
    const calcRes = await calculatorTool.execute({ expression: '((25 * 4) + 50) / 2' });
    console.log('Calculator result:', calcRes);
    if (calcRes.result !== 75) {
        throw new Error(`Calculator failed: expected 75, got ${calcRes.result}`);
    }

    const statsRes = await statsSummaryTool.execute({ numbers: [10, 20, 30, 40, 50, 60] });
    console.log('Stats summary result:', statsRes);
    if (statsRes.count !== 6 || statsRes.sum !== 210 || statsRes.mean !== 35 || statsRes.median !== 35) {
        throw new Error('Stats summary tool returned incorrect calculations');
    }

    const regexRes = await regexMatchTool.execute({ pattern: 'user_([a-z0-9]+)', text: 'Found user_alice42 and user_bob99 in log' });
    console.log('Regex match result:', regexRes);
    if (!regexRes.matched || regexRes.matchCount !== 2 || regexRes.matches[0] !== 'user_alice42') {
        throw new Error('Regex match tool failed pattern extraction');
    }

    const jsonRes = await jsonExtractTool.execute({ data: { cluster: { nodes: [{ id: 'n1', memory: '16GB' }] } }, path: 'cluster.nodes[0].memory' });
    console.log('JSON extract result:', jsonRes);
    if (!jsonRes.found || jsonRes.value !== '16GB') {
        throw new Error('JSON extract tool failed to extract path');
    }

    // 22b: ToolRegistry custom tool registration & execution
    const customRegistry = new ToolRegistry();
    customRegistry.register({
        name: 'hash_sha1',
        description: 'Computes a simple deterministic mock hash of input string.',
        parameters: {
            input: { type: 'string', description: 'String to hash', required: true }
        },
        execute({ input }) {
            return { hash: `sha1-${input.length}-${input.charCodeAt(0)}` };
        }
    });

    const toolExec = await customRegistry.execute('hash_sha1', { input: 'test-data' });
    console.log('Custom tool execution result:', toolExec);
    if (!toolExec.success || !toolExec.result?.hash?.startsWith('sha1-')) {
        throw new Error('Custom tool execution in ToolRegistry failed');
    }

    // 22c: Parsing tool calls from raw LLM output
    const mockModelOutput = 'Thinking...\n```tool_call\n{\n  "tool": "calculator",\n  "parameters": { "expression": "100 * 1.08" }\n}\n```\nSynthesizing output...';
    const parsedCalls = globalToolRegistry.parseToolCalls(mockModelOutput);
    console.log('Parsed tool calls from model output:', parsedCalls);
    if (parsedCalls.length !== 1 || parsedCalls[0].tool !== 'calculator') {
        throw new Error('parseToolCalls failed to extract tool_call block');
    }

    const toolCallResults = await globalToolRegistry.executeAllToolCalls(parsedCalls);
    console.log('Executed tool calls result:', toolCallResults);
    if (toolCallResults.length !== 1 || toolCallResults[0].result?.result !== 108) {
        throw new Error('executeAllToolCalls returned invalid tool execution result');
    }

    // 22d: Engine Workflow with Tool Execution
    ProviderRegistry.register({
        providerName: 'tool-mock',
        async call(opts) {
            if (opts.prompt.includes('Data Chunk')) {
                // Analyst returns a tool call block and structured response
                return '```tool_call\n{\n  "tool": "calculator",\n  "parameters": { "expression": "5000 / 25" }\n}\n```\n' +
                    JSON.stringify({
                        insights: ['Initial throughput rate analyzed'],
                        anomalies: [],
                        summary: 'Throughput analysis with deterministic tool assistance.'
                    });
            }
            return JSON.stringify({
                ui_title: 'Deterministic Tool Assisted Analysis',
                components: [
                    { id: '1', type: 'InsightList', props: { title: 'Results', insights: [{ type: 'info', message: 'Tool verified' }] } }
                ]
            });
        }
    });

    const toolWorkflowResult = await executeSwarmWorkflow({
        task: 'Calculate exact throughput metrics',
        data: 'total_requests=5000, duration_sec=25',
        enableDeepAnalysis: true,
        tools: globalToolRegistry,
        settings: {
            appId: 'tool-test-app',
            agents: [
                { id: 'manager', role: 'Manager Node', provider: 'tool-mock', apiKey: 'mock-key', model: 'mock-model' },
                { id: 'a1', role: 'Telemetry Analyst', provider: 'tool-mock', apiKey: 'mock-key', model: 'mock-model' }
            ]
        }
    });

    const toolEngineEvent = toolWorkflowResult.events.find(e => e.action.includes('Executed Tool: calculator'));
    console.log('Tool execution engine event:', toolEngineEvent);
    if (!toolEngineEvent || toolEngineEvent.output?.result !== 200) {
        throw new Error('Step 22d: SwarmEngine failed to record deterministic tool execution event');
    }
    console.log('✓ Zero-dependency free tool framework verified across all modes');

    console.log('\n=== Step 23: Portable Memory Cortex Snapshotting & Cross-App Hydration ===');

    // 23a: Seed source cortex with high-quality and low-quality memories
    const sourceAppId = 'app-origin-analytics';
    const sourceCortex = new MemoryCortex({
        defaultAppId: sourceAppId,
        isolatedStore: true
    });

    await sourceCortex.store('Architectural Baseline: Use distributed read-replicas for read-heavy OLAP pipelines.', {
        domain: 'architecture',
        agentRole: 'Lead Architect',
        qualityRating: 0.98,
        verified: true,
        appId: sourceAppId
    });

    await sourceCortex.store('Security Baseline: JWT signatures must use RS256 with asymmetric private key rotation.', {
        domain: 'security',
        agentRole: 'Security Officer',
        qualityRating: 0.95,
        verified: true,
        appId: sourceAppId
    });

    await sourceCortex.store('Ephemeral unverified log message from temporary probe', {
        domain: 'debug',
        agentRole: 'Probe',
        qualityRating: 0.20,
        verified: false,
        appId: sourceAppId
    });

    // 23b: Export snapshot with quality filter (minRating: 0.8)
    const snapshot = await sourceCortex.exportMemories({ minRating: 0.8 });
    console.log(`Exported snapshot points count: ${snapshot.pointCount}`);
    if (snapshot.pointCount !== 2 || snapshot.memories.some(m => m.metadata.qualityRating < 0.8)) {
        throw new Error('Step 23b: exportMemories failed to filter out low-quality memories');
    }
    if (!snapshot.memories[0].denseVector || !snapshot.memories[0].sparseVector) {
        throw new Error('Step 23b: exportMemories omitted vector representations');
    }

    // 23c: Export JSON and JSONL
    const jsonStr = await sourceCortex.exportJson({ minRating: 0.8 });
    const jsonlStr = await sourceCortex.exportJsonl({ minRating: 0.8 });
    console.log(`JSON snapshot byte length: ${jsonStr.length}, JSONL line count: ${jsonlStr.split('\n').length}`);
    if (!jsonStr.includes('distributed read-replicas') || jsonlStr.split('\n').length !== 2) {
        throw new Error('Step 23c: exportJson/exportJsonl produced invalid serialized data');
    }

    // 23d: Hydrate snapshot into a fresh downstream app cortex
    const targetAppId = 'app-transplanted-downstream';
    const targetCortex = new MemoryCortex({
        defaultAppId: targetAppId,
        isolatedStore: true
    });

    const importResult = await targetCortex.importMemories(snapshot, { targetAppId });
    console.log('Hydration import result:', importResult);
    if (importResult.imported !== 2 || importResult.skipped !== 0) {
        throw new Error('Step 23d: importMemories failed to hydrate snapshot points into target cortex');
    }

    // Verify search and few-shot exemplar retrieval in the hydrated cortex
    const retrievedFromTarget = await targetCortex.retrieve('read-replicas for OLAP', { appId: targetAppId });
    console.log('Retrieved from transplanted cortex:', retrievedFromTarget.map(m => ({ appId: m.appId, content: m.content })));
    if (retrievedFromTarget.length === 0 || retrievedFromTarget[0].appId !== targetAppId) {
        throw new Error('Step 23d: Transplanted cortex failed to retrieve hydrated memory with remapped appId');
    }

    const targetExemplars = await targetCortex.retrieveExemplars('JWT signatures and asymmetric keys', { appId: targetAppId });
    console.log('Distilled exemplars from transplanted cortex:\n', targetExemplars);
    if (!targetExemplars.includes('RS256 with asymmetric private key rotation')) {
        throw new Error('Step 23d: Transplanted cortex failed to distill few-shot learning exemplars');
    }

    // 23e: Hydrate from JSONL string format with deduplication
    const jsonlImport = await targetCortex.importMemories(jsonlStr, { targetAppId, deduplicate: true });
    console.log('JSONL re-import result (expecting deduplication):', jsonlImport);
    if (jsonlImport.deduplicated !== 2) {
        throw new Error('Step 23e: Re-importing identical snapshot failed semantic deduplication');
    }
    console.log('✓ Portable memory snapshotting and cross-app hydration verified');

    console.log('\n=== Step 24: Resilient Zero-Drift AI JSON Repair & Schema Guard ===');

    // 24a: Malformed JSON with thinking tags, markdown fences, unquoted keys, trailing commas, comments, and Python literals
    const malformedOutput = `
<think>The user wants an analysis of the Redis cluster. Let me prepare the response.</think>
\`\`\`json
{
    // Primary observation
    summary: 'Redis cluster status is optimal',
    /* anomalies section */
    anomalies: [
        'Intermittent socket timeout on node-3',
    ],
    insights: [
        "Memory fragmentation ratio is 1.12",
        "Replication lag under 2ms",
    ],
    verified: True,
    active_connections: None,
}
\`\`\`
Hope this helps! Feel free to ask if you need further adjustments.
`;
    const repairedJsonStr = repairJson(malformedOutput);
    console.log('Repaired JSON string:\n', repairedJsonStr);
    const parsedObj = parseJsonSafe(malformedOutput);
    console.log('Parsed object from malformed output:', parsedObj);
    if (!parsedObj || parsedObj.summary !== 'Redis cluster status is optimal' || parsedObj.verified !== true || parsedObj.active_connections !== null) {
        throw new Error('Step 24a: parseJsonSafe failed to repair and parse malformed JSON');
    }

    // 24b: Truncated JSON repair (mid-string and mid-array inside an object)
    const truncatedOutput = `{"summary": "Cluster migration in progress", "insights": ["Phase 1 complete", "Phase 2 synchronizing keys`;
    const repairedTruncated = parseJsonSafe(truncatedOutput);
    console.log('Repaired truncated object:', repairedTruncated);
    if (!repairedTruncated || repairedTruncated.summary !== 'Cluster migration in progress' || !Array.isArray(repairedTruncated.insights) || repairedTruncated.insights.length !== 2) {
        throw new Error('Step 24b: parseJsonSafe failed to auto-close and salvage truncated JSON');
    }

    // 24c: Unclosed <think> tag preceding JSON output
    const unclosedThink = `<think>Analyzing high throughput stream...
{"summary": "Throughput steady at 45k ops/sec", "insights": ["No backpressure detected"], "anomalies": []}`;
    const parsedUnclosed = parseJsonSafe(unclosedThink);
    console.log('Parsed unclosed think tag output:', parsedUnclosed);
    if (!parsedUnclosed || parsedUnclosed.summary !== 'Throughput steady at 45k ops/sec') {
        throw new Error('Step 24c: parseJsonSafe failed to strip unclosed thinking tag');
    }

    // 24d: Fuzzy field extraction from unstructured conversational prose
    const rawProse = `
Here is the analytical breakdown:
Summary: Production ingress proxy reported elevated 5xx rates.
Insights:
- Upstream Envoy timeout triggered after 15 seconds
- TCP connection pool exhausted on worker-pod-07
Anomalies:
- Spurious RST packets detected on eth0
`;
    const parsedProse = parseJsonSafe(rawProse);
    console.log('Fuzzy parsed prose object:', parsedProse);
    if (!parsedProse || !parsedProse.summary || !Array.isArray(parsedProse.insights) || parsedProse.insights.length !== 2) {
        throw new Error('Step 24d: parseJsonSafe failed fuzzy field extraction on unstructured text');
    }

    // 24e: Domain schema guards
    const guardedAnalyst = guardAnalystResponse(rawProse, 'Network Specialist');
    console.log('Guarded Analyst Response:', guardedAnalyst);
    if (!guardedAnalyst.summary || guardedAnalyst.insights.length !== 2 || guardedAnalyst.anomalies.length !== 1) {
        throw new Error('Step 24e: guardAnalystResponse failed to synthesize valid AnalystResponse');
    }

    const guardedManager = guardManagerResponse({ title: 'Custom Title', insights: ['System healthy'] });
    console.log('Guarded Manager Response:', guardedManager);
    if (!guardedManager.ui_title || !Array.isArray(guardedManager.components) || guardedManager.components.length === 0) {
        throw new Error('Step 24e: guardManagerResponse failed to synthesize valid ManagerResponse');
    }

    const criticPass = guardVerificationResult("The proposal looks solid. VERIFICATION PASSED with high confidence.");
    const criticFail = guardVerificationResult("CRITIQUE FAILED: Missing database indexing specification.");
    console.log('Guarded Critic Results:', { pass: criticPass, fail: criticFail });
    if (criticPass.pass !== true || criticFail.pass !== false) {
        throw new Error('Step 24e: guardVerificationResult failed sentiment pass/fail evaluation');
    }

    // 24f: SwarmEngine resilient workflow execution with malformed analyst and manager outputs
    const malformedProvider = 'malformed-test-provider';
    ProviderRegistry.register({
        providerName: malformedProvider,
        async call(opts) {
            if (opts.prompt.includes('Evaluate this proposal')) {
                return 'After careful review, VERIFICATION PASSED. All invariants met.';
            }
            if (opts.systemInstruction?.includes('Swarm Orchestrator') || opts.prompt.includes('Analyst Reports:')) {
                // Return malformed markdown-fenced manager output with trailing commas
                return '```json\n{ ui_title: "Resilient Manager Dashboard", components: [ { id: "m1", type: "InsightList", props: { title: "Status", insights: [ { type: "success", message: "Zero drift parsing verified", }, ], }, }, ], }\n```\nDone!';
            }
            // Return malformed analyst output with unquoted keys and unclosed think
            return '<think>Thinking...\n{ summary: "Zero-drift parser test", insights: ["Handled malformed input smoothly",], anomalies: [], }';
        }
    });

    const malformedResult = await executeSwarmWorkflow({
        task: 'Test payload for parser resilience',
        enableDeepAnalysis: true,
        settings: {
            appId: 'resilient-test-app',
            agents: [
                { id: 'manager', role: 'Manager Node', provider: malformedProvider, apiKey: 'mock-key', model: 'malformed-mock' },
                { id: 'a1', role: 'Malformed Analyst', provider: malformedProvider, apiKey: 'mock-key', model: 'malformed-mock' }
            ]
        }
    });

    console.log('Resilient swarm workflow execution result:', {
        title: malformedResult.finalAnalysis.ui_title,
        componentsCount: malformedResult.finalAnalysis.components?.length
    });
    if (!malformedResult.finalAnalysis.ui_title || malformedResult.finalAnalysis.ui_title.includes('Error')) {
        throw new Error('Step 24f: SwarmEngine failed to handle malformed LLM outputs gracefully');
    }
    console.log('✓ Resilient Zero-Drift AI JSON Repair & Schema Guard verified');

    console.log('\n=== Step 25: RRF Retrieval Presets, onMemoryLearned Lifecycle Hook & Unified SwarmClient SDK ===');

    // 25a: RRF Retrieval Presets (semantic, lexical, balanced, hybrid)
    const rrfTestCortex = new MemoryCortex({ defaultAppId: 'rrf-preset-app', isolatedStore: true });
    await rrfTestCortex.store('Critical database deadlock timeout detected on payment processing transactions.', {
        domain: 'database',
        qualityRating: 0.95,
        verified: true,
        appId: 'rrf-preset-app'
    });
    await rrfTestCortex.store('Sluggish UI performance and elevated latency observed on checkout page.', {
        domain: 'frontend',
        qualityRating: 0.90,
        verified: true,
        appId: 'rrf-preset-app'
    });

    const semanticQuery = await rrfTestCortex.retrieve('system sluggishness and high delay', {
        rrfProfile: RRF_PRESETS.semantic
    });
    console.log('Semantic preset retrieval top match:', semanticQuery[0]?.content);
    if (!semanticQuery.length || !semanticQuery[0].content.includes('Sluggish UI')) {
        throw new Error('Step 25a: RRF_PRESETS.semantic failed to prioritize semantic match');
    }

    const lexicalQuery = await rrfTestCortex.retrieve('deadlock timeout database transactions', {
        rrfProfile: RRF_PRESETS.lexical
    });
    console.log('Lexical preset retrieval top match:', lexicalQuery[0]?.content);
    if (!lexicalQuery.length || !lexicalQuery[0].content.includes('deadlock timeout')) {
        throw new Error('Step 25a: RRF_PRESETS.lexical failed to prioritize lexical match');
    }

    const balancedQuery = await rrfTestCortex.retrieve('database latency', {
        rrfProfile: RRF_PRESETS.balanced
    });
    const hybridQuery = await rrfTestCortex.retrieve('database latency', {
        rrfProfile: RRF_PRESETS.hybrid
    });
    if (balancedQuery.length === 0 || hybridQuery.length === 0) {
        throw new Error('Step 25a: Balanced or hybrid RRF retrieval failed to return results');
    }
    console.log('✓ Pre-Calibrated RRF Retrieval Presets verified');

    // 25b: onMemoryLearned Lifecycle Hook
    const learnedEvents: any[] = [];
    const learningEngine = new SwarmEngine({
        cortex: rrfTestCortex,
        onMemoryLearned: (event) => {
            learnedEvents.push(event);
        }
    });

    // Fast-path execution trigger
    await learningEngine.executeWorkflow({
        task: 'Health check node ping',
        data: 'node=green',
        settings: {
            appId: 'rrf-preset-app',
            agents: [
                { id: 'm1', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mock', model: 'm-mock' },
                { id: 'a1', role: 'Analyst', provider: 'custom-mock', apiKey: 'k-mock', model: 'm-mock' }
            ]
        }
    });

    console.log('Fast-path learned event:', learnedEvents[0]);
    if (learnedEvents.length === 0 || !learnedEvents[0].metadata?.fastPath) {
        throw new Error('Step 25b: onMemoryLearned did not fire on fast-path workflow');
    }

    // Deep analysis execution trigger
    await learningEngine.executeWorkflow({
        task: 'Investigate deadlock logs and propose indexing strategy',
        enableDeepAnalysis: true,
        settings: {
            appId: 'rrf-preset-app',
            agents: [
                { id: 'm1', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mock', model: 'm-mock' },
                { id: 'a1', role: 'Analyst', provider: 'custom-mock', apiKey: 'k-mock', model: 'm-mock' }
            ]
        }
    });

    console.log('Total onMemoryLearned events received:', learnedEvents.length);
    const deepLearned = learnedEvents.find(e => e.metadata?.task?.includes('deadlock logs'));
    if (!deepLearned || deepLearned.metadata?.fastPath) {
        throw new Error('Step 25b: onMemoryLearned did not fire on deep-analysis workflow');
    }
    console.log('✓ onMemoryLearned lifecycle hooks verified for both fast-path and deep-analysis');

    // 25c: Unified SwarmClient SDK
    const client = createSwarmClient({
        mode: 'embedded',
        appId: 'sdk-client-app',
        settings: {
            agents: [
                { id: 'sdk-mgr', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mock', model: 'm-mock' },
                { id: 'sdk-analyst', role: 'Analyst', provider: 'custom-mock', apiKey: 'k-mock', model: 'm-mock' }
            ]
        }
    });

    const sdkResult = await client.analyze({
        task: 'Analyze system telemetry stream',
        data: 'telemetry=nominal'
    });
    console.log('SDK analyze() output title:', sdkResult.finalAnalysis?.ui_title);
    if (!sdkResult.finalAnalysis?.ui_title) {
        throw new Error('Step 25c: SwarmClient.analyze() failed');
    }

    const streamedChunks: any[] = [];
    for await (const chunk of client.stream({
        task: 'Stream diagnostic health check',
        data: 'mode=live'
    })) {
        streamedChunks.push(chunk);
    }
    console.log(`SDK stream() received ${streamedChunks.length} chunks`);
    if (streamedChunks.length === 0 || !streamedChunks.some(c => c.type === 'complete')) {
        throw new Error('Step 25c: SwarmClient.stream() failed to stream events');
    }

    // Test client memory interface
    const storedMemId = await client.memory.store('SDK knowledge: Redis caching reduces p95 by 40ms.', {
        domain: 'caching',
        qualityRating: 0.98
    });
    console.log('SDK memory store result ID:', storedMemId);
    if (!storedMemId) {
        throw new Error('Step 25c: SwarmClient.memory.store() failed');
    }

    const retrievedMemories = await client.memory.retrieve('Redis caching p95');
    if (retrievedMemories.length === 0 || !retrievedMemories[0].content.includes('Redis caching')) {
        throw new Error('Step 25c: SwarmClient.memory.retrieve() failed');
    }

    const exportedSnapshot = await client.memory.exportSnapshot({ format: 'json' });
    const importedResult = await client.memory.importSnapshot(exportedSnapshot, { deduplicate: true });
    console.log('SDK memory export/import stats:', importedResult);
    if (importedResult.deduplicated < 1) {
        throw new Error('Step 25c: SwarmClient.memory export/import roundtrip failed');
    }

    // Remote mode client validation
    const remoteClient = createSwarmClient({
        mode: 'remote',
        endpoint: 'http://localhost:3000'
    });
    if (remoteClient.mode !== 'remote') {
        throw new Error('Step 25c: SwarmClient remote configuration failed');
    }
    console.log('✓ Unified SwarmClient SDK verified (embedded analyze, streaming, memory, and remote config)');

    console.log('\n=== Step 26: Extended Analysis Tools, Critic Baselines & Memory File Persistence ===');

    // 26a: Extended Tools - data_filter
    const sampleData = [
        { id: 1, name: 'Service A', latencyMs: 120, status: 'active', tags: ['core', 'auth'] },
        { id: 2, name: 'Service B', latencyMs: 450, status: 'degraded', tags: ['billing'] },
        { id: 3, name: 'Service C', latencyMs: 85, status: 'active', tags: ['cache'] },
        { id: 4, name: 'Service D', latencyMs: 620, status: 'offline', tags: ['search'] }
    ];

    const filteredResult = await dataFilterTool.execute({
        data: sampleData,
        filter: {
            field: 'latencyMs',
            operator: '>',
            value: 100
        },
        sortBy: 'latencyMs',
        sortOrder: 'desc',
        limit: 2
    });
    console.log('dataFilterTool result count:', filteredResult.matchedCount, 'top item:', filteredResult.data[0]?.name);
    if (filteredResult.matchedCount !== 3 || filteredResult.data[0]?.name !== 'Service D' || filteredResult.data.length !== 2) {
        throw new Error('Step 26a: dataFilterTool failed to filter, sort, and limit items correctly');
    }

    // 26b: Extended Tools - string_similarity
    const simResult = await stringSimilarityTool.execute({
        stringA: 'redis cache connection timeout error',
        stringB: 'redis connection timeout failure',
        metric: 'all'
    });
    console.log('stringSimilarityTool result:', simResult);
    if (simResult.jaccardSimilarity < 0.4 || simResult.levenshteinSimilarity < 0.5) {
        throw new Error('Step 26b: stringSimilarityTool computed unexpected low similarity scores');
    }

    // 26c: Extended Tools - date_math
    const dateMathDiff = await dateMathTool.execute({
        operation: 'diff',
        dateA: '2026-09-13T12:00:00Z',
        dateB: '2026-09-13T10:00:00Z',
        unit: 'hours'
    });
    console.log('dateMathTool diff result:', dateMathDiff);
    if (dateMathDiff.diff !== 2) {
        throw new Error(`Step 26c: dateMathTool diff expected 2 hours, got ${dateMathDiff.diff}`);
    }

    const dateMathAdd = await dateMathTool.execute({
        operation: 'add',
        dateA: '2026-09-01T00:00:00Z',
        amount: 5,
        unit: 'days'
    });
    console.log('dateMathTool add result:', dateMathAdd.resultDate);
    if (!dateMathAdd.resultDate.startsWith('2026-09-06')) {
        throw new Error('Step 26c: dateMathTool add days failed');
    }

    // 26d: Critic Context Awareness & Historical Baseline Verification
    const criticMockProvider = {
        providerName: 'critic-baseline-verifier',
        async call(opts: any) {
            if (opts.systemInstruction?.includes('CRITIC') || opts.prompt?.includes('Evaluate this proposal')) {
                if (!opts.prompt.includes('[Historical Baselines & Past Lessons]')) {
                    throw new Error('Critic prompt failed to include [Historical Baselines & Past Lessons]');
                }
                if (!opts.prompt.includes('Baseline Lesson: Latency above 200ms violates enterprise SLA')) {
                    throw new Error('Critic prompt missing injected historical baseline content');
                }
                return JSON.stringify({
                    pass: true,
                    feedback: 'Historical baselines strictly satisfied and verified.'
                });
            }
            return JSON.stringify({
                insights: ['Latency measured at 95ms'],
                anomalies: [],
                summary: 'Nominal'
            });
        }
    };
    ProviderRegistry.register(criticMockProvider);

    const criticTestAgent = new Agent('Data Analyst', 'test-model', 'critic-baseline-verifier', 'test-key');
    const criticVerifierAgent = new Agent('Quality Critic', 'test-model', 'critic-baseline-verifier', 'test-key');
    const baselineLifecycle = new AnalysisLifecycle(criticTestAgent, criticVerifierAgent, 2);

    const criticLifecycleResult = await baselineLifecycle.executeAndVerify(
        {
            rawData: 'Current p95 latency = 95ms',
            historicalBaselines: 'Baseline Lesson: Latency above 200ms violates enterprise SLA'
        },
        context,
        'Assess customer API latency',
        'Verify this proposal against baselines.'
    );
    console.log('Critic baseline verification result:', criticLifecycleResult.criticFeedback);
    if (!criticLifecycleResult.success || !criticLifecycleResult.criticFeedback?.includes('strictly satisfied')) {
        throw new Error('Step 26d: Critic historical baseline verification failed');
    }

    // 26e: Transparent Local File Persistence (persistPath)
    const testPersistPath = path.resolve(process.cwd(), 'temp_test_cortex_persist.json');
    if (fs.existsSync(testPersistPath)) fs.unlinkSync(testPersistPath);

    const persistingCortex = new MemoryCortex({
        persistPath: testPersistPath,
        autoSave: true,
        isolatedStore: true,
        defaultAppId: 'persist-test-app'
    });
    await persistingCortex.initialize();

    const pId = await persistingCortex.store('Durable persistent memory: PostgreSQL connection pool tuning optimal at 25.', {
        domain: 'database',
        qualityRating: 0.95,
        verified: true
    });
    if (!fs.existsSync(testPersistPath)) {
        throw new Error('Step 26e: MemoryCortex failed to auto-save snapshot to persistPath');
    }
    const savedContent = fs.readFileSync(testPersistPath, 'utf-8');
    if (!savedContent.includes('PostgreSQL connection pool tuning optimal at 25')) {
        throw new Error('Step 26e: Persisted file does not contain expected memory content');
    }
    console.log('✓ Auto-persistence to disk verified at:', testPersistPath);

    const reloadedCortex = new MemoryCortex({
        persistPath: testPersistPath,
        autoSave: true,
        isolatedStore: true,
        defaultAppId: 'persist-test-app'
    });
    await reloadedCortex.initialize();

    const loadedMemories = await reloadedCortex.retrieve('PostgreSQL connection pool', { appId: 'persist-test-app' });
    console.log('Reloaded memories from disk:', loadedMemories.map(m => m.content));
    if (loadedMemories.length === 0 || !loadedMemories[0].content.includes('PostgreSQL connection pool')) {
        throw new Error('Step 26e: Fresh MemoryCortex failed to auto-load memories from persistPath');
    }
    console.log('✓ Auto-load from disk upon initialize() verified');

    const explicitJsonlPath = path.resolve(process.cwd(), 'temp_test_cortex_explicit.jsonl');
    if (fs.existsSync(explicitJsonlPath)) fs.unlinkSync(explicitJsonlPath);

    await persistingCortex.saveToFile(explicitJsonlPath);
    if (!fs.existsSync(explicitJsonlPath)) {
        throw new Error('Step 26e: saveToFile failed to write JSONL file');
    }
    const explicitImport = await persistingCortex.loadFromFile(explicitJsonlPath);
    console.log('Explicit loadFromFile result:', explicitImport);
    if (explicitImport.imported + explicitImport.deduplicated < 1) {
        throw new Error('Step 26e: loadFromFile failed to load JSONL snapshot');
    }

    await persistingCortex.wipeCollection();
    if (fs.existsSync(testPersistPath)) {
        throw new Error('Step 26e: wipeCollection failed to unlink persistPath file');
    }
    if (fs.existsSync(explicitJsonlPath)) fs.unlinkSync(explicitJsonlPath);
    console.log('✓ wipeCollection and cleanup verified');

    console.log('\n=== Step 16: Context Event Log Summary ===');
    console.log(`Total events recorded in SwarmContext: ${recordedEvents.length}`);
    recordedEvents.forEach(e => console.log(' -', e));

    console.log('\n ALL PORTABILITY, RESILIENCE, LEARNING CORTEX, CACHING, HIERARCHY & LOAD BALANCING VALIDATIONS PASSED SUCCESSFULLY!');
}

runPortableValidation().catch(err => {
    console.error('Validation failed:', err);
    process.exit(1);
});
