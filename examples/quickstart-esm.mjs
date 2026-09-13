import { executeSwarmWorkflow, ProviderRegistry } from '../dist/swarm/index.js';

// Register mock provider for self-contained execution without external API keys
ProviderRegistry.register({
    providerName: 'example-mock',
    async call(options) {
        return JSON.stringify({
            insights: [
                'Throughput reached 15,200 requests/sec',
                'P99 latency stabilized at 18ms',
                'Memory usage remains within nominal bounds'
            ],
            anomalies: [],
            summary: 'System telemetry analysis completed successfully with zero alerts.'
        });
    }
});

console.log('--- Executing Perfect Swarm Autonomous Workflow ---');

const result = await executeSwarmWorkflow({
    task: 'Analyze microservice cluster telemetry and throughput',
    data: 'rps=15200, p99=18ms, error_rate=0.001%',
    settings: {
        appId: 'quickstart-app',
        agents: [
            { id: 'mgr', role: 'Manager Node', provider: 'example-mock', model: 'mock-1', apiKey: 'test-key' },
            { id: 'a1', role: 'Cluster Analyst', provider: 'example-mock', model: 'mock-1', apiKey: 'test-key' }
        ]
    },
    onEvent: (event) => {
        console.log(`[EVENT] [${event.agentRole}] ${event.action} (${event.durationMs || 0}ms)`);
    }
});

console.log('\n--- Final Generative Analysis Output ---');
console.log(JSON.stringify(result.finalAnalysis, null, 2));
