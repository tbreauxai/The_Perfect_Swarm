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
    SwarmHierarchy,
    AdaptiveLoadBalancer,
    globalLoadBalancer,
    SwarmEngine,
    executeSwarmWorkflow,
    OpenRouterAdapter
} from './swarm.ts';

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

    console.log('\n=== Step 13: Hierarchical Agent Communication Layers & Scoped Event Broadcasting ===');
    const hierarchy = new SwarmHierarchy(context);

    const triageAgent = new Agent('Triage Node', 'mock-v1', 'custom-mock', 'key');
    const secAnalyst = new Agent('Security Specialist', 'mock-v1', 'custom-mock', 'key');
    const perfAnalyst = new Agent('Performance Specialist', 'mock-v1', 'custom-mock', 'key');
    const dbAnalyst = new Agent('Database Specialist', 'mock-v1', 'custom-mock', 'key');
    const managerAgent = new Agent('Manager Synthesizer', 'mock-v1', 'custom-mock', 'key');

    hierarchy.setTriageNode(triageAgent);
    hierarchy.addSpecialistNode(secAnalyst, 'sec-1', 'Security Specialist', ['vulnerability', 'auth', 'security', 'cve']);
    hierarchy.addSpecialistNode(perfAnalyst, 'perf-1', 'Performance Specialist', ['latency', 'throughput', 'memory', 'cpu']);
    hierarchy.addSpecialistNode(dbAnalyst, 'db-1', 'Database Specialist', ['sql', 'query', 'indexing', 'database']);
    hierarchy.setSynthesisNode(managerAgent);

    // 13a: Triage Planning - targeted selection
    const secPlan = hierarchy.planTriage('Investigate auth vulnerability in API gateway', '', 2);
    console.log('Triage Plan for security task:', secPlan);
    if (!secPlan.selectedSpecialistIds.includes('sec-1')) {
        throw new Error('L1 Triage failed to select Security Specialist for vulnerability task');
    }
    if (secPlan.selectedSpecialistIds.includes('db-1')) {
        throw new Error('L1 Triage should have bypassed Database Specialist for pure security task');
    }

    // 13b: Hierarchical Execution
    const hierResult = await hierarchy.execute(
        'Investigate auth vulnerability in API gateway',
        'Payload: invalid JWT token format accepted',
        { maxSpecialists: 2, scope: 'milestones' }
    );
    console.log('Hierarchy execution bypassed specialists:', hierResult.bypassedSpecialists);
    if (!hierResult.bypassedSpecialists.includes('db-1')) {
        throw new Error('Expected unneeded specialist to be bypassed during execution');
    }

    // 13c: Scoped Event Filtering
    const allEvents = hierarchy.getContext().events;
    const milestoneEvents = hierarchy.filterEventsByScope(allEvents, 'milestones');
    console.log(`Total raw events: ${allEvents.length}, Scoped milestone events: ${milestoneEvents.length}`);
    if (milestoneEvents.length > allEvents.length) {
        throw new Error('Scoped filtering returned more events than total');
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

    console.log('\n=== Step 16: Context Event Log Summary ===');
    console.log(`Total events recorded in SwarmContext: ${recordedEvents.length}`);
    recordedEvents.forEach(e => console.log(' -', e));

    console.log('\n ALL PORTABILITY, RESILIENCE, LEARNING CORTEX, CACHING, HIERARCHY & LOAD BALANCING VALIDATIONS PASSED SUCCESSFULLY!');
}

runPortableValidation().catch(err => {
    console.error('Validation failed:', err);
    process.exit(1);
});
