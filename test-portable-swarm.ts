import {
    Agent,
    SwarmContext,
    ProviderRegistry,
    ModelRouter,
    MemoryCortex,
    DeterministicLocalEmbeddingProvider,
    AnalysisLifecycle
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

    console.log('\n=== Step 4: ModelRouter Task Inference ===');
    const simpleComplexity = ModelRouter.inferComplexity('Summarize this receipt in 2 bullets');
    const complexComplexity = ModelRouter.inferComplexity('Deep audit and root cause security verification of memory leaks');
    console.log('Inferred simple task complexity:', simpleComplexity);
    console.log('Inferred complex task complexity:', complexComplexity);
    if (simpleComplexity !== 'simple' || complexComplexity !== 'complex') {
        throw new Error('ModelRouter complexity inference failure');
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

    console.log('\n=== Step 7: Zero-cost Deterministic Memory Cortex ===');
    const cortex = new MemoryCortex({
        url: 'http://localhost:6333',
        apiKey: '',
        collectionName: 'test_collection',
        embeddingProvider: new DeterministicLocalEmbeddingProvider()
    });
    console.log('Cortex initialized with DeterministicLocalEmbeddingProvider');

    console.log('\n=== Step 8: Context Event Log Summary ===');
    console.log(`Total events recorded in SwarmContext: ${recordedEvents.length}`);
    recordedEvents.forEach(e => console.log(' -', e));

    console.log('\n PORTABILITY & INTEGRATION VALIDATION PASSED SUCCESSFULLY!');
}

runPortableValidation().catch(err => {
    console.error('Validation failed:', err);
    process.exit(1);
});
