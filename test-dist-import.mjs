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
    handleSwarmSse,
    createSwarmClient
} from './dist/swarm/index.js';
import { createSwarmServer as serverFromSubpath } from './dist/swarm/server.js';
import { createSwarmClient as clientFromSubpath } from './dist/swarm/client.js';
import { ToolRegistry, calculatorTool } from './dist/swarm/tools.js';
import { repairJson, parseJsonSafe } from './dist/swarm/parser.js';

async function runDistVerification() {
    console.log('\n=== Distribution Bundle Verification (ESM from dist/swarm/index.js) ===');

    // 1. Verify exports presence
    console.log('Verifying compiled library exports:');
    if (!executeSwarmWorkflow || !SwarmEngine || !MemoryCortex || !ModelRouter || !PayloadCache || !SwarmHierarchy || !AdaptiveLoadBalancer || !ProviderRegistry || !createSwarmServer || !handleSwarmSse || !serverFromSubpath || !createSwarmClient || !clientFromSubpath) {
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

    console.log('\n✓ ALL COMPILED SWARM DISTRIBUTION BUNDLE TESTS PASSED SUCCESSFULLY!\n');
}

runDistVerification().catch(err => {
    console.error('Dist verification failed:', err);
    process.exit(1);
});
