import {
    Agent,
    SwarmContext,
    ProviderRegistry,
    ModelRouter,
    MemoryCortex,
    DeterministicLocalEmbeddingProvider,
    SparseTokenizer,
    AnalysisLifecycle
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

    console.log('\n================================================================');
    console.log('  ALL MULTI-APP SIMULATIONS & FREE-TIER STRESS TESTS PASSED! ');
    console.log('================================================================');
}

runMultiAppSimulation().catch(err => {
    console.error('Multi-App Simulation Failed:', err);
    process.exit(1);
});
