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
    globalLoadBalancer
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

    const mockQdrantClient: any = {
        async getCollections() {
            return { collections: [{ name: 'test_collection' }] };
        },
        async createPayloadIndex() {
            return { status: 'ok' };
        },
        async query(col: string, queryParams: any) {
            mockQueries.push(queryParams);
            if (queryParams.score_threshold === 0.92) {
                const appId = queryParams.filter?.must?.find((m: any) => m.key === 'appId')?.match?.value;
                const existing = mockStore.find(p => p.payload.appId === appId);
                if (existing) {
                    return { points: [{ id: existing.id, score: 0.95, payload: existing.payload }] };
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

    console.log('\n=== Step 15: Context Event Log Summary ===');
    console.log(`Total events recorded in SwarmContext: ${recordedEvents.length}`);
    recordedEvents.forEach(e => console.log(' -', e));

    console.log('\n ALL PORTABILITY, RESILIENCE, LEARNING CORTEX, CACHING, HIERARCHY & LOAD BALANCING VALIDATIONS PASSED SUCCESSFULLY!');
}

runPortableValidation().catch(err => {
    console.error('Validation failed:', err);
    process.exit(1);
});
