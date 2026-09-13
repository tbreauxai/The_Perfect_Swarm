import {
    executeSwarmWorkflow,
    SwarmEngine,
    MemoryCortex,
    ModelRouter,
    PayloadCache,
    SwarmHierarchy,
    AdaptiveLoadBalancer,
    ProviderRegistry,
    createSwarmServer,
    handleSwarmSse
} from './dist/swarm/index.js';
import { createSwarmServer as serverFromSubpath } from './dist/swarm/server.js';

async function runDistVerification() {
    console.log('\n=== Distribution Bundle Verification (ESM from dist/swarm/index.js) ===');

    // 1. Verify exports presence
    console.log('Verifying compiled library exports:');
    if (!executeSwarmWorkflow || !SwarmEngine || !MemoryCortex || !ModelRouter || !PayloadCache || !SwarmHierarchy || !AdaptiveLoadBalancer || !ProviderRegistry || !createSwarmServer || !handleSwarmSse || !serverFromSubpath) {
        throw new Error('Missing core exports in compiled dist bundle');
    }
    console.log('✓ All core exports verified.');

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

    console.log('\n✓ ALL COMPILED SWARM DISTRIBUTION BUNDLE TESTS PASSED SUCCESSFULLY!\n');
}

runDistVerification().catch(err => {
    console.error('Dist verification failed:', err);
    process.exit(1);
});
