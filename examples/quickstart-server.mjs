import { createSwarmServer } from '../dist/swarm/server.js';
import { ProviderRegistry } from '../dist/swarm/index.js';

// Register mock provider for isolated testing
ProviderRegistry.register({
    providerName: 'example-server-mock',
    async call(options) {
        return JSON.stringify({
            insights: ['Server stream active', 'SSE connection stable'],
            anomalies: [],
            summary: 'Streaming service health verified.'
        });
    }
});

const PORT = 3001;
const server = createSwarmServer({
    port: PORT,
    cors: true,
    defaultSettings: {
        appId: 'example-server-app',
        agents: [
            { id: 'mgr', role: 'Manager Node', provider: 'example-server-mock', model: 'mock-1', apiKey: 'test-key' },
            { id: 'a1', role: 'Live Analyst', provider: 'example-server-mock', model: 'mock-1', apiKey: 'test-key' }
        ]
    }
});

server.listen(PORT, () => {
    console.log(`\nSwarm HTTP & SSE Server running on http://localhost:${PORT}`);
    console.log(`- Health: http://localhost:${PORT}/api/health`);
    console.log(`- Stream: http://localhost:${PORT}/api/swarm/stream?task=Check+cluster+status`);
    console.log('\nPress Ctrl+C to stop.\n');
});
