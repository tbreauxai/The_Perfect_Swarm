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
    globalPayloadCache,
    AdaptiveLoadBalancer,
    globalLoadBalancer,
    SpecialistAffinityRouter,
    NodeCapacityManager
} from './src/swarm/index.ts';

async function runMultiAppSimulation() {
    console.log('================================================================');
    console.log('  END-TO-END MULTI-APP SIMULATION & FREE-TIER STRESS TEST');
    console.log('================================================================\n');

    // -------------------------------------------------------------
    // SETUP: Mock Free-Tier Providers with realistic failure modes
    // -------------------------------------------------------------
    let groqCallCount = 0;
    let openRouterCallCount = 0;
    let mistralCallCount = 0;

    ProviderRegistry.register({
        providerName: 'sim-groq-free',
        async call(opts) {
            groqCallCount++;
            // Simulate 429 rate limit on every 2nd call (free-tier 6000 TPM spike)
            if (groqCallCount % 2 === 1) {
                throw new Error('[RATE_LIMIT_429] Groq Free-Tier TPM exceeded: 429 Too Many Requests. Try again in 2s.');
            }
            return JSON.stringify({
                app: 'groq-worker',
                status: 'success',
                analysis: `Analyzed with Groq: ${opts.prompt.substring(0, 40)}`
            });
        }
    });

    ProviderRegistry.register({
        providerName: 'sim-openrouter-free',
        async call(opts) {
            openRouterCallCount++;
            // Simulate DeepSeek-R1 reasoning model output with <think> blocks
            return `<think>
Evaluating multi-tenant parameters...
Checking schema constraints and potential anomaly indicators...
Synthesizing structured findings.
</think>
\`\`\`json
{
  "source": "sim-openrouter-free",
  "status": "success",
  "findings": ["Recovered via OpenRouter failover cascade", "Zero downtime"],
  "promptEcho": "${opts.prompt.substring(0, 30)}"
}
\`\`\``;
        }
    });

    ProviderRegistry.register({
        providerName: 'sim-mistral-free',
        async call(opts) {
            mistralCallCount++;
            return JSON.stringify({
                source: 'sim-mistral-free',
                verificationPass: true,
                pass: true,
                feedback: 'Verified analysis strictly conforms to payload rules.'
            });
        }
    });

    // -------------------------------------------------------------
    // SIMULATED IN-MEMORY QDRANT VECTOR STORE
    // -------------------------------------------------------------
    const simulatedStore: any[] = [];
    const simulatedQdrant: any = {
        async getCollections() {
            return { collections: [{ name: 'multi_app_cortex' }] };
        },
        async createPayloadIndex() {
            return { status: 'ok' };
        },
        async query(col: string, queryParams: any) {
            if (queryParams.score_threshold === 0.92) {
                const appId = queryParams.filter?.must?.find((m: any) => m.key === 'appId')?.match?.value;
                const existing = simulatedStore.find(p => p.payload.appId === appId);
                if (existing) {
                    return { points: [{ id: existing.id, score: 0.96, payload: existing.payload }] };
                }
                return { points: [] };
            }
            const appId = queryParams.prefetch?.[0]?.filter?.must?.find((m: any) => m.key === 'appId')?.match?.value;
            let results = simulatedStore;
            if (appId) {
                results = simulatedStore.filter(p => p.payload.appId === appId);
            }
            return {
                points: results.map(p => ({ id: p.id, score: 0.89, payload: p.payload }))
            };
        },
        async upsert(col: string, params: any) {
            simulatedStore.push(...params.points);
            return { status: 'ok' };
        },
        async setPayload(col: string, params: any) {
            for (const ptId of params.points) {
                const pt = simulatedStore.find(p => p.id === ptId);
                if (pt) {
                    pt.payload = { ...pt.payload, ...params.payload };
                }
            }
            return { status: 'ok' };
        }
    };

    // -------------------------------------------------------------
    // PHASE 1: App 1 (FinTech Fraud Detection) Deployment
    // -------------------------------------------------------------
    console.log('>>> PHASE 1: Deploying App 1 (app-fintech-fraud)...');
    const fintechContext = new SwarmContext();
    const fintechEvents: string[] = [];
    fintechContext.subscribe(e => fintechEvents.push(`[${e.agentRole}] ${e.action}`));

    const fintechCortex = new MemoryCortex({
        url: 'http://localhost:6333',
        collectionName: 'multi_app_cortex',
        defaultAppId: 'app-fintech-fraud',
        embeddingProvider: new DeterministicLocalEmbeddingProvider()
    });
    (fintechCortex as any).qdrant = simulatedQdrant;
    (fintechCortex as any).isAvailable = true;

    // Create resilient agent with Groq as primary, OpenRouter as failover cascade
    const fintechAgent = new Agent(
        'Fraud Analyst',
        'llama-3.3-70b',
        'sim-groq-free',
        'key-groq',
        undefined,
        [{ provider: 'sim-openrouter-free', apiKey: 'key-openrouter', modelName: 'deepseek-r1-free' }]
    );

    // Run execution - should fail on Groq (429) and cascade to OpenRouter with <think> stripping
    const fintechResult = await fintechAgent.run(
        'Analyze anomalous wire transfers exceeding $50,000 threshold',
        fintechContext,
        { responseMimeType: 'application/json' }
    );

    console.log('Fintech Execution Result (via failover):', fintechResult);
    if (fintechResult.source !== 'sim-openrouter-free') {
        throw new Error('FinTech agent failed to failover to OpenRouter upon Groq 429 rate limit');
    }

    // Store diagnosis in FinTech memory
    const fintechMemId = await fintechCortex.store(
        'High frequency wire transfers from unverified sub-merchant IDs flagged as AML violation',
        { domain: 'fraud-detection', agentRole: 'Fraud Analyst', appId: 'app-fintech-fraud', qualityRating: 0.95 }
    );
    console.log('Stored FinTech diagnosis memory point:', fintechMemId);

    // Reinforce diagnosis with user feedback
    await fintechCortex.rateMemory(fintechMemId as string, 0.99, 'Audited and verified by Compliance Officer');

    // -------------------------------------------------------------
    // PHASE 2: App 2 (Health Analytics) Deployment & Isolation
    // -------------------------------------------------------------
    console.log('\n>>> PHASE 2: Deploying App 2 (app-health-analytics)...');
    const healthContext = new SwarmContext();
    const healthCortex = new MemoryCortex({
        url: 'http://localhost:6333',
        collectionName: 'multi_app_cortex',
        defaultAppId: 'app-health-analytics',
        embeddingProvider: new DeterministicLocalEmbeddingProvider()
    });
    (healthCortex as any).qdrant = simulatedQdrant;
    (healthCortex as any).isAvailable = true;

    // Verify isolation: Health app queries its memories - should find ZERO FinTech records
    const healthMemoriesBefore = await healthCortex.retrieve('wire transfers AML', { appId: 'app-health-analytics' });
    console.log(`Health App isolated memory search (expected 0): ${healthMemoriesBefore.length} records found`);
    if (healthMemoriesBefore.length !== 0) {
        throw new Error('Multi-tenant isolation breach: Health app accessed FinTech memory records!');
    }

    // Store Health App specific diagnosis
    const healthMemId = await healthCortex.store(
        'Elevated systolic BP readings clustered in clinical cohort B after dosage modification',
        { domain: 'clinical-trials', agentRole: 'Biostatistician', appId: 'app-health-analytics', qualityRating: 0.9 }
    );
    console.log('Stored Health diagnosis memory point:', healthMemId);

    // Verify FinTech app still cannot see Health records
    const fintechMemoriesAfter = await fintechCortex.retrieve('systolic BP readings', { appId: 'app-fintech-fraud' });
    console.log(`Fintech App isolated memory search (expected 1 FinTech only): ${fintechMemoriesAfter.length} records found`);
    if (fintechMemoriesAfter.some(m => m.appId === 'app-health-analytics')) {
        throw new Error('Multi-tenant isolation breach: FinTech app accessed Health memory records!');
    }

    // -------------------------------------------------------------
    // PHASE 3: Few-Shot Exemplar Distillation Test
    // -------------------------------------------------------------
    console.log('\n>>> PHASE 3: Testing Continuous Learning Few-Shot Exemplar Distillation...');
    const fintechExemplars = await fintechCortex.retrieveExemplars('suspicious wire transfers AML', {
        appId: 'app-fintech-fraud',
        minRating: 0.8
    });
    console.log('FinTech Few-Shot Exemplars for new prompt:\n', fintechExemplars);
    if (!fintechExemplars.includes('AML violation') || !fintechExemplars.includes('Quality Rating: 99%')) {
        throw new Error('Failed to distill high-rated exemplar into prompt context');
    }

    // -------------------------------------------------------------
    // PHASE 4: Concurrency & Rate-Limit Stress Test
    // -------------------------------------------------------------
    console.log('\n>>> PHASE 4: Running Concurrent Multi-App Stress Test (12 parallel tasks)...');
    const stressContext = new SwarmContext();
    const stressPromises = [];

    for (let i = 0; i < 12; i++) {
        const tenantAppId = i % 2 === 0 ? 'app-fintech-fraud' : 'app-health-analytics';
        const stressAgent = new Agent(
            `StressWorker-${i}`,
            'llama-3-8b',
            'sim-groq-free',
            'key-groq',
            undefined,
            [{ provider: 'sim-openrouter-free', apiKey: 'key-openrouter', modelName: 'deepseek-r1-free' }]
        );

        const task = stressAgent.run(`Stress Task #${i} for ${tenantAppId}`, stressContext, { responseMimeType: 'application/json' })
            .then(res => {
                return { taskId: i, tenantAppId, success: true, res };
            });

        stressPromises.push(task);
    }

    const stressResults = await Promise.all(stressPromises);
    const successfulTasks = stressResults.filter(r => r.success);
    console.log(`Stress Test Completed: ${successfulTasks.length}/${stressResults.length} tasks succeeded.`);
    console.log(`Provider Metrics -> Groq Calls: ${groqCallCount}, OpenRouter Failover Calls: ${openRouterCallCount}`);

    if (successfulTasks.length !== 12) {
        throw new Error(`Stress test failed: only ${successfulTasks.length}/12 tasks resolved`);
    }

    // -------------------------------------------------------------
    // PHASE 5: Fast-Path Intent Pre-Filtering & Payload Cache Benchmark
    // -------------------------------------------------------------
    console.log('\n>>> PHASE 5: Benchmarking Fast-Path Pre-Filtering & Deterministic Payload Caching...');
    const fastPathBenchmarkQueries = [
        { query: 'Status ping', data: '', expectFast: true },
        { query: 'Health check', data: 'ok=true', expectFast: true },
        { query: 'Get user profile count', data: 'tenant=app-fintech', expectFast: true },
        { query: 'Echo test', data: 'ping', expectFast: true },
        { query: 'Root cause analysis of cross-app memory leak and race condition in vector DB', data: 'stacktrace...', expectFast: false },
        { query: 'Synthesize clinical cohort metrics across 500 patient records with confidence intervals', data: 'data...', expectFast: false }
    ];

    let fastPathEligibleCount = 0;
    for (const item of fastPathBenchmarkQueries) {
        const decision = ModelRouter.evaluateFastPath(item.query, item.data);
        if (decision.eligible === item.expectFast) {
            fastPathEligibleCount++;
        }
        if (item.expectFast && decision.targetTier !== 'instant') {
            throw new Error(`Fast-path query ${item.query} was not assigned to 'instant' tier`);
        }
    }
    console.log(`Fast-Path Pre-Filtering Accuracy: ${fastPathEligibleCount}/${fastPathBenchmarkQueries.length} classified correctly.`);
    if (fastPathEligibleCount !== fastPathBenchmarkQueries.length) {
        throw new Error('Fast-path pre-filtering classification failed on benchmark queries');
    }

    // Benchmark Deterministic Payload Cache
    const simCache = new PayloadCache({ maxEntries: 10, defaultTtlMs: 30000 });
    const cacheTestTask = 'Analyze recurring AML pattern for tenant';
    const cacheTestData = JSON.stringify({ tenantId: 'app-fintech-fraud', pattern: 'burst-wire-transfers' });
    const computedAnalysis = { riskScore: 0.98, recommendation: 'Block and notify AML officer immediately' };

    // 1st Execution: Cache Miss
    const missFingerprint = PayloadCache.computeFingerprint(cacheTestTask, cacheTestData);
    const missResult = simCache.get(missFingerprint);
    if (missResult !== null) {
        throw new Error('Expected initial cache lookup to be a miss');
    }
    simCache.set(missFingerprint, computedAnalysis);

    // 2nd Execution: Instant Cache Hit (sub-millisecond)
    const t0 = performance.now();
    const hitResult = simCache.get(missFingerprint);
    const hitDurationMs = performance.now() - t0;
    console.log(`Deterministic Cache Hit returned in ${hitDurationMs.toFixed(3)}ms (sub-millisecond zero-drift verification)`);

    if (!hitResult || hitResult.riskScore !== 0.98) {
        throw new Error('Deterministic cache hit failed to retrieve correct payload');
    }

    // Verify LRU Eviction Under Load
    for (let k = 0; k < 12; k++) {
        const fp = PayloadCache.computeFingerprint(`Task-${k}`, `Data-${k}`);
        simCache.set(fp, { k });
    }
    const cacheStats = simCache.getStats();
    console.log(`PayloadCache LRU Capacity: size=${cacheStats.size}, evictions=${cacheStats.evictions}, hitRatio=${(cacheStats.hitRatio * 100).toFixed(1)}%`);
    if (cacheStats.size > 10 || cacheStats.evictions < 2) {
        throw new Error('PayloadCache failed to enforce strict LRU bounds under load');
    }

    // -------------------------------------------------------------
    // PHASE 6: Hierarchical Multi-Specialist Dispatch & Broadcast Reduction
    // -------------------------------------------------------------
    console.log('\n>>> PHASE 6: Benchmarking Hierarchical Multi-Specialist Dispatch & Broadcast Reduction...');

    // Register mock specialist execution providers
    ProviderRegistry.register({
        providerName: 'sim-spec-sec',
        async call(opts) {
            return JSON.stringify({
                status: 'success',
                specialist: 'Security Specialist',
                findings: ['JWT token expiration verified: 3600s', 'No credential replay vulnerabilities']
            });
        }
    });

    ProviderRegistry.register({
        providerName: 'sim-spec-perf',
        async call(opts) {
            return JSON.stringify({
                status: 'success',
                specialist: 'Performance Engineer',
                findings: ['P99 latency within 25ms SLA', 'Throughput sustained at 4500 RPS']
            });
        }
    });

    ProviderRegistry.register({
        providerName: 'sim-spec-data',
        async call(opts) {
            return JSON.stringify({
                status: 'success',
                specialist: 'Database Analyst',
                findings: ['B-Tree index active on tenant_id', 'Connection pool headroom at 65%']
            });
        }
    });

    const specialistAgents = [
        new Agent('Security Specialist', 'mock-sec', 'sim-spec-sec', 'k-sec'),
        new Agent('Performance Engineer', 'mock-perf', 'sim-spec-perf', 'k-perf'),
        new Agent('Database Analyst', 'mock-data', 'sim-spec-data', 'k-data')
    ];
    specialistAgents[0].id = 'sec-node';
    specialistAgents[1].id = 'perf-node';
    specialistAgents[2].id = 'data-node';

    const simNodeCap = new NodeCapacityManager();
    simNodeCap.setMaxConcurrency('sec-node', 1);
    simNodeCap.setMaxConcurrency('perf-node', 1);
    simNodeCap.setMaxConcurrency('data-node', 1);

    const simRouter = new SpecialistAffinityRouter(undefined, undefined, undefined, simNodeCap);

    const taskDomain = 'Comprehensive multi-tenant infrastructure security audit, query indexing, and latency benchmarking';
    const testChunks = [
        'JWT token signature verification, OAuth2 authorization flow, session expiration attack vector analysis, credential leak prevention',
        'Database query execution plan, B-tree index scan on foreign keys, sql transaction deadlocks, connection pool exhaustion',
        'Server latency percentiles, p95 and p99 response times, thread pool bottleneck, memory cpu cache eviction'
    ];

    const distributionPlan = simRouter.planDistribution(taskDomain, testChunks, specialistAgents);
    console.log(`Specialist Plan: ${distributionPlan.assignments.length} assignments planned for ${distributionPlan.totalChunks} chunks.`);

    // Broadcast comparison: Full broadcast would require 3 specialists * 3 chunks = 9 runs
    const fullBroadcastCalls = specialistAgents.length * testChunks.length;
    const targetedCalls = distributionPlan.assignments.length;
    const callReductionPercent = ((fullBroadcastCalls - targetedCalls) / fullBroadcastCalls) * 100;
    console.log(`Broadcast Reduction: ${fullBroadcastCalls} broadcast calls reduced to ${targetedCalls} targeted calls (${callReductionPercent.toFixed(1)}% call & token reduction)`);

    if (callReductionPercent < 50) {
        throw new Error(`Specialist router did not achieve broadcast reduction: expected >=50%, got ${callReductionPercent}%`);
    }

    // Verify appropriate domain routing
    const secAsn = distributionPlan.assignments.find(a => a.chunkIndex === 0);
    const dataAsn = distributionPlan.assignments.find(a => a.chunkIndex === 1);
    const perfAsn = distributionPlan.assignments.find(a => a.chunkIndex === 2);

    if (secAsn?.agentRole !== 'Security Specialist') {
        throw new Error(`Expected chunk 0 to route to Security Specialist, got ${secAsn?.agentRole}`);
    }
    if (dataAsn?.agentRole !== 'Database Analyst') {
        throw new Error(`Expected chunk 1 to route to Database Analyst, got ${dataAsn?.agentRole}`);
    }
    if (perfAsn?.agentRole !== 'Performance Engineer') {
        throw new Error(`Expected chunk 2 to route to Performance Engineer, got ${perfAsn?.agentRole}`);
    }

    // Now test capacity saturation spillover: Saturate Security Specialist (concurrency=1)
    const activeSecSlot = simNodeCap.tryAcquireSlot('sec-node');
    if (!activeSecSlot) throw new Error('Failed to acquire initial slot for sec-node');

    // Planning another security chunk should now detect saturation and trigger spillover
    const overflowSecurityChunk = ['Authentication credential rotation breach vector under emergency conditions'];
    const spilloverPlan = simRouter.planDistribution('Security breach emergency response', overflowSecurityChunk, specialistAgents);
    const spilloverAsn = spilloverPlan.assignments[0];

    console.log(`Saturation Spillover: Saturated Security Specialist redirected to '${spilloverAsn.agentRole}' (isSpillover=${spilloverAsn.isSpillover}, reason='${spilloverAsn.reason}')`);
    if (!spilloverAsn.isSpillover) {
        throw new Error('Specialist router failed to mark spillover when node capacity is saturated');
    }
    if (spilloverAsn.agentRole === 'Security Specialist') {
        throw new Error('Specialist router assigned saturated node instead of spilling over');
    }

    // Release slot and verify zero leaks
    activeSecSlot.release();
    const finalSecMetrics = simNodeCap.getNodeMetrics('sec-node');
    if (finalSecMetrics.activeInFlight !== 0) {
        throw new Error(`Node capacity slot leak detected: ${finalSecMetrics.activeInFlight} active in-flight remaining`);
    }
    console.log(`Node capacity slot lifecycle verified with zero in-flight leaks.`);
    console.log('\n>>> PHASE 7: Benchmarking Adaptive Load Balancer & Dynamic 429 Cooldown Feedback...');
    let burstGroqCount = 0;
    ProviderRegistry.register({
        providerName: 'sim-burst-groq',
        async call(opts) {
            burstGroqCount++;
            // Rapidly throw 429 on 3rd call
            if (burstGroqCount >= 3) {
                throw new Error('[RATE_LIMIT_429] 429 Too Many Requests: Groq free-tier TPM threshold exceeded');
            }
            return JSON.stringify({ provider: 'sim-burst-groq', result: 'fast-groq-analysis' });
        }
    });

    ProviderRegistry.register({
        providerName: 'sim-burst-gemini',
        async call(opts) {
            return JSON.stringify({ provider: 'sim-burst-gemini', result: 'stable-gemini-analysis' });
        }
    });

    ProviderRegistry.register({
        providerName: 'sim-burst-mistral',
        async call(opts) {
            return JSON.stringify({ provider: 'sim-burst-mistral', result: 'backup-mistral-analysis' });
        }
    });

    const adaptiveBalancer = new AdaptiveLoadBalancer({
        emaAlpha: 0.5,
        rateLimitCooldownMs: 8000
    });

    const candidateProviders = [
        { provider: 'sim-burst-groq', apiKey: 'k-groq', modelName: 'llama-3.1-8b-instant' },
        { provider: 'sim-burst-gemini', apiKey: 'k-gemini', modelName: 'gemini-2.5-flash' },
        { provider: 'sim-burst-mistral', apiKey: 'k-mistral', modelName: 'mistral-small' }
    ];

    // Seed initial fast latency for groq
    adaptiveBalancer.recordStart('sim-burst-groq');
    adaptiveBalancer.recordSuccess('sim-burst-groq', 25); // 25ms

    // Seed initial standard latency for gemini
    adaptiveBalancer.recordStart('sim-burst-gemini');
    adaptiveBalancer.recordSuccess('sim-burst-gemini', 85); // 85ms

    // Initial choice: should be sim-burst-groq due to lower EMA latency
    const initialChoice = adaptiveBalancer.selectOptimalProvider(candidateProviders);
    console.log('Initial optimal provider selected (fastest EMA):', initialChoice.provider);
    if (initialChoice.provider !== 'sim-burst-groq') {
        throw new Error(`Adaptive balancer should have selected sim-burst-groq, got ${initialChoice.provider}`);
    }

    // Now execute requests and trigger 429 on groq
    const adaptiveAgent = new Agent(
        'Adaptive Stress Agent',
        'llama-3.1-8b',
        'sim-burst-groq',
        'k-groq',
        undefined,
        [
            { provider: 'sim-burst-gemini', apiKey: 'k-gemini', modelName: 'gemini-2.5-flash' },
            { provider: 'sim-burst-mistral', apiKey: 'k-mistral', modelName: 'mistral-small' }
        ],
        adaptiveBalancer
    );

    const adaptiveContext = new SwarmContext();
    const adaptiveRunResults = [];
    for (let r = 0; r < 5; r++) {
        const res = await adaptiveAgent.run(`Adaptive Run ${r}`, adaptiveContext, { responseMimeType: 'application/json' });
        adaptiveRunResults.push(res);
    }

    console.log(`Adaptive Agent Runs Completed: 5 runs.`);
    const groqTelemetry = adaptiveBalancer.getTelemetry('sim-burst-groq');
    const geminiTelemetry = adaptiveBalancer.getTelemetry('sim-burst-gemini');
    console.log(`Groq Telemetry Status: ${groqTelemetry.status}, Failures: ${groqTelemetry.failureCount}, Cooldown: ${groqTelemetry.cooldownUntil !== undefined}`);
    console.log(`Gemini Telemetry Status: ${geminiTelemetry.status}, Successes: ${geminiTelemetry.successCount}, EMA Latency: ${geminiTelemetry.latencyEmaMs.toFixed(1)}ms`);

    // Verify that the load balancer correctly placed groq in cooldown after the 429 error
    if (groqTelemetry.status !== 'cooldown') {
        throw new Error('sim-burst-groq was not placed into cooldown status following 429 rate limit');
    }

    // Subsequent selection must route to gemini, never groq
    const postCooldownChoice = adaptiveBalancer.selectOptimalProvider(candidateProviders);
    console.log('Optimal provider selected after 429 cooldown (expected sim-burst-gemini):', postCooldownChoice.provider);
    if (postCooldownChoice.provider !== 'sim-burst-gemini') {
        throw new Error('Adaptive balancer failed to route to sim-burst-gemini during Groq cooldown');
    }

    console.log('\n================================================================');
    console.log('  ALL MULTI-APP SIMULATIONS & FREE-TIER STRESS TESTS PASSED! ');
    console.log('================================================================');
}

runMultiAppSimulation().catch(err => {
    console.error('Multi-App Simulation Failed:', err);
    process.exit(1);
});
