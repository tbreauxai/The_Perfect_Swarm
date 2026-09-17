import * as http from 'node:http';
import { createRequire } from 'node:module';
import { createSwarmServer, handleSwarmSse, parseJsonBody } from './dist/swarm/server.js';
import { ProviderRegistry } from './dist/swarm/index.js';

const require = createRequire(import.meta.url);

async function runSseServerTests() {
    console.log('\n=== Swarm Zero-Dependency HTTP & SSE Server Verification ===');

    // 1. Verify CJS bundle export
    console.log('Testing CommonJS server bundle import:');
    const cjsServer = require('./dist/swarm/server.cjs');
    if (typeof cjsServer.createSwarmServer !== 'function' || typeof cjsServer.handleSwarmSse !== 'function') {
        throw new Error('CommonJS export validation failed for dist/swarm/server.cjs');
    }
    console.log('✓ CommonJS server exports verified.');

    // 2. Register mock provider for isolated testing
    ProviderRegistry.register({
        providerName: 'test-mock-server',
        async call(options) {
            if (options.systemInstruction && options.systemInstruction.includes('Swarm Orchestrator')) {
                return JSON.stringify({
                    ui_title: 'Cluster Metrics Dashboard',
                    components: [
                        { id: 'm1', type: 'MetricCard', props: { title: 'Cluster Status', value: 'Nominal', trend: 'up' } },
                        { id: 'i1', type: 'InsightList', props: { title: 'Health', insights: [{ type: 'info', message: 'All nodes healthy' }] } }
                    ]
                });
            }
            return JSON.stringify({
                insights: ['Latency 12ms', 'Memory footprint optimal'],
                anomalies: [],
                summary: 'Mock server analysis complete.'
            });
        }
    });

    // 3. Instantiate server
    const server = createSwarmServer({
        cors: true,
        defaultSettings: {
            appId: 'sse-test-app',
            agents: [
                { id: 'mgr', role: 'Manager Node', provider: 'test-mock-server', model: 'mock-1', apiKey: 'mock-key' },
                { id: 'a1', role: 'Server Analyst', provider: 'test-mock-server', model: 'mock-1', apiKey: 'mock-key' }
            ]
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`✓ Swarm HTTP/SSE server started on ${baseUrl}`);

    try {
        // Step A: Health check endpoint
        console.log('\n[Test 1] GET /api/health');
        const healthRes = await fetch(`${baseUrl}/api/health`);
        if (healthRes.status !== 200) throw new Error(`Health status expected 200, got ${healthRes.status}`);
        const healthData = await healthRes.json();
        console.log('✓ Health response:', healthData);
        if (healthData.status !== 'ok') throw new Error('Health check payload invalid');

        // Step B: CORS preflight
        console.log('\n[Test 2] OPTIONS /api/swarm/stream (CORS preflight)');
        const optionsRes = await fetch(`${baseUrl}/api/swarm/stream`, { method: 'OPTIONS' });
        if (optionsRes.status !== 204) throw new Error(`OPTIONS expected 204, got ${optionsRes.status}`);
        if (optionsRes.headers.get('access-control-allow-origin') !== '*') {
            throw new Error('CORS header missing in OPTIONS response');
        }
        console.log('✓ CORS preflight accepted with 204');

        // Step C: Validation error for missing task
        console.log('\n[Test 3] POST /api/swarm/stream with missing task');
        const invalidRes = await fetch(`${baseUrl}/api/swarm/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (invalidRes.status !== 400) throw new Error(`Expected 400 for missing task, got ${invalidRes.status}`);
        console.log('✓ Correctly rejected missing task with 400 Bad Request');

        // Step D: Full Server-Sent Events (SSE) streaming
        console.log('\n[Test 4] POST /api/swarm/stream (SSE Stream)');
        const sseEvents = [];
        const sseStages = [];
        let sseCompleteReceived = false;

        await new Promise((resolve, reject) => {
            const req = http.request(`${baseUrl}/api/swarm/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                }
            }, (res) => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`SSE stream status expected 200, got ${res.statusCode}`));
                }
                const contentType = res.headers['content-type'] || '';
                if (!contentType.includes('text/event-stream')) {
                    return reject(new Error(`Invalid content-type: ${contentType}`));
                }

                let buffer = '';
                res.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop() || '';

                    for (const block of lines) {
                        if (block.startsWith(':connected')) {
                            console.log('  → SSE handshake received: :connected');
                        } else if (block.startsWith('event: swarm_event')) {
                            const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                            if (dataLine) {
                                const parsed = JSON.parse(dataLine.replace('data: ', ''));
                                sseEvents.push(parsed);
                                console.log(`  → SSE Swarm Event: [${parsed.agentRole}] ${parsed.action}`);
                            }
                        } else if (block.startsWith('event: swarm_stage')) {
                            const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                            if (dataLine) {
                                const parsed = JSON.parse(dataLine.replace('data: ', ''));
                                sseStages.push(parsed);
                                console.log(`  → SSE Swarm Stage: [${parsed.stage}]`);
                            }
                        } else if (block.startsWith('event: swarm_complete')) {
                            sseCompleteReceived = true;
                            const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                            const parsed = JSON.parse(dataLine.replace('data: ', ''));
                            console.log('  → SSE Swarm Complete received with UI title:', parsed.finalAnalysis?.ui_title);
                        }
                    }
                });

                res.on('end', () => {
                    resolve();
                });
                res.on('error', reject);
            });

            req.on('error', reject);
            req.write(JSON.stringify({
                task: 'Diagnose memory allocation in microservice cluster',
                data: 'nodes=12, mem_utilization=94%, gc_pause=450ms'
            }));
            req.end();
        });

        if (!sseCompleteReceived) throw new Error('Failed to receive event: swarm_complete');
        if (sseEvents.length === 0) throw new Error('Failed to receive any event: swarm_event');
        if (sseStages.length === 0) throw new Error('Failed to receive any event: swarm_stage');
        console.log(`✓ SSE streaming successfully verified with ${sseEvents.length} live swarm events and ${sseStages.length} stage transitions.`);

        // Step 4b: Multi-specialist SSE stream with cluster digest progressive stage
        console.log('\n[Test 4b] POST /api/swarm/stream with forceFullSwarm (Cluster Digest Stage)');
        const fullSwarmStages = [];
        await new Promise((resolve, reject) => {
            const req = http.request(`${baseUrl}/api/swarm/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                }
            }, (res) => {
                let buffer = '';
                res.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop() || '';
                    for (const block of lines) {
                        if (block.startsWith('event: swarm_stage')) {
                            const dataLine = block.split('\n').find(l => l.startsWith('data: '));
                            if (dataLine) {
                                const parsed = JSON.parse(dataLine.replace('data: ', ''));
                                fullSwarmStages.push(parsed);
                                console.log(`  → Full Swarm Stage: [${parsed.stage}]`);
                            }
                        }
                    }
                });
                res.on('end', resolve);
                res.on('error', reject);
            });
            req.on('error', reject);
            req.write(JSON.stringify({
                task: 'Audit authentication latency and vulnerability profile',
                data: 'auth telemetry sample',
                forceFullSwarm: true
            }));
            req.end();
        });

        const clusterStage = fullSwarmStages.find(s => s.stage === 'cluster_aggregation');
        if (!clusterStage) throw new Error('Missing cluster_aggregation stage in full swarm SSE stream');
        console.log('✓ Multi-stage cluster digest SSE stage verified with pods:', Object.keys(clusterStage.digests || {}));

        // Step E: Direct JSON endpoint POST /api/swarm/analyze
        console.log('\n[Test 5] POST /api/swarm/analyze (Standard JSON)');
        const analyzeRes = await fetch(`${baseUrl}/api/swarm/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                task: 'Synthesize cluster metrics',
                data: 'status=ready'
            })
        });
        if (analyzeRes.status !== 200) throw new Error(`Analyze expected 200, got ${analyzeRes.status}`);
        const analyzeData = await analyzeRes.json();
        console.log('✓ Direct JSON analysis response received:', analyzeData.finalAnalysis?.ui_title);
        if (!analyzeData.finalAnalysis) throw new Error('Missing finalAnalysis in direct JSON response');

        console.log('\n✓ ALL SWARM HTTP/SSE STREAMING SERVER TESTS PASSED SUCCESSFULLY!\n');
    } finally {
        server.close();
    }
}

runSseServerTests().catch(err => {
    console.error('Server test failure:', err);
    process.exit(1);
});
