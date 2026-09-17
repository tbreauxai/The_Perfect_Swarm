import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleSwarmSse } from './server.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('Phase 2: Server-Side Streaming & Heartbeat Resilience', () => {
    it('sends periodic keepalive comments and flushes headers during execution', async () => {
        ProviderRegistry.register({
            providerName: 'slow-test-provider' as any,
            async call() {
                // Simulate delay
                await new Promise(resolve => setTimeout(resolve, 150));
                return JSON.stringify({
                    insights: ['Deep inference output'],
                    anomalies: [],
                    summary: 'Done'
                });
            }
        });

        const req: any = new EventEmitter();
        const writes: string[] = [];
        let flushed = false;

        const res: any = {
            writeHead: vi.fn(),
            write: vi.fn((chunk: string) => {
                writes.push(chunk);
                return true;
            }),
            flushHeaders: vi.fn(() => {
                flushed = true;
            }),
            end: vi.fn()
        };

        const params: any = {
            task: 'Long running task',
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'slow-test-provider', model: 'mock', apiKey: 'k' },
                    { id: 'a1', role: 'Analyst', provider: 'slow-test-provider', model: 'mock', apiKey: 'k' }
                ]
            }
        };

        // Pass heartbeatIntervalMs of 30ms so we observe multiple keepalives in 150ms
        await handleSwarmSse(req, res, params, { heartbeatIntervalMs: 30 });

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream'
        }));
        expect(flushed).toBe(true);

        // Verify connected handshake was sent first
        expect(writes[0]).toBe(':connected\n\n');

        // Verify periodic keepalives were sent
        const keepalives = writes.filter(w => w === ':keepalive\n\n');
        expect(keepalives.length).toBeGreaterThanOrEqual(2);

        // Verify swarm_complete was sent before end
        const completeEvent = writes.find(w => w.includes('event: swarm_complete'));
        expect(completeEvent).toBeDefined();
        expect(res.end).toHaveBeenCalled();
    });

    it('cleans up keepalive timer when client connection closes', async () => {
        ProviderRegistry.register({
            providerName: 'hanging-test-provider' as any,
            async call() {
                await new Promise(resolve => setTimeout(resolve, 200));
                return JSON.stringify({ summary: 'ok' });
            }
        });

        const req: any = new EventEmitter();
        const writes: string[] = [];

        const res: any = {
            writeHead: vi.fn(),
            write: vi.fn((chunk: string) => writes.push(chunk)),
            end: vi.fn()
        };

        const params: any = {
            task: 'Hanging task',
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'hanging-test-provider', model: 'mock', apiKey: 'k' },
                    { id: 'a1', role: 'Analyst', provider: 'hanging-test-provider', model: 'mock', apiKey: 'k' }
                ]
            }
        };

        const ssePromise = handleSwarmSse(req, res, params, { heartbeatIntervalMs: 25 });

        // Simulate client closing request after 50ms
        setTimeout(() => {
            req.emit('close');
        }, 50);

        await ssePromise;
        const initialCount = writes.filter(w => w === ':keepalive\n\n').length;

        // Wait a bit longer and verify no more keepalives were sent after close
        await new Promise(resolve => setTimeout(resolve, 60));
        const finalCount = writes.filter(w => w === ':keepalive\n\n').length;
        expect(finalCount).toBe(initialCount);
    });

    it('streams swarm_stage events with cluster digests before manager synthesis completes', async () => {
        ProviderRegistry.register({
            providerName: 'stage-stream-provider' as any,
            async call(options) {
                if (options.systemInstruction?.includes('Orchestrator') || options.prompt?.includes('Analyst Reports')) {
                    return JSON.stringify({
                        ui_title: 'Synthesized Title',
                        components: [{ id: '1', type: 'InsightList', props: { title: 'T', insights: [] } }]
                    });
                }
                return JSON.stringify({
                    insights: ['Sec insight A'],
                    anomalies: ['Sec anomaly A'],
                    summary: 'Pod analysis'
                });
            }
        });

        const req: any = new EventEmitter();
        const writes: string[] = [];

        const res: any = {
            writeHead: vi.fn(),
            write: vi.fn((chunk: string) => writes.push(chunk)),
            flushHeaders: vi.fn(),
            end: vi.fn()
        };

        const params: any = {
            task: 'Analyze security telemetry',
            data: 'auth logs',
            forceFullSwarm: true,
            settings: {
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'stage-stream-provider', model: 'mock-mgr', apiKey: 'k' },
                    { id: 'sec-spec', role: 'Security Specialist', provider: 'stage-stream-provider', model: 'mock-sec', apiKey: 'k' }
                ]
            }
        };

        await handleSwarmSse(req, res, params);

        // Find swarm_stage events
        const stageWrites = writes.filter(w => w.startsWith('event: swarm_stage\n'));
        expect(stageWrites.length).toBeGreaterThanOrEqual(2);

        // Extract payloads
        const stagePayloads = stageWrites.map(w => {
            const dataLine = w.split('\n').find(l => l.startsWith('data: '));
            return JSON.parse(dataLine!.replace('data: ', ''));
        });

        const clusterAggStage = stagePayloads.find(p => p.stage === 'cluster_aggregation');
        expect(clusterAggStage).toBeDefined();
        expect(clusterAggStage.digests['security-pod']).toBeDefined();
        expect(clusterAggStage.digests['security-pod'].keyFindings).toContain('Sec insight A');

        const managerStage = stagePayloads.find(p => p.stage === 'manager_synthesis');
        expect(managerStage).toBeDefined();

        const completedStage = stagePayloads.find(p => p.stage === 'completed');
        expect(completedStage).toBeDefined();

        // Verify swarm_complete is sent last
        const lastEvent = writes[writes.length - 1];
        expect(lastEvent).toContain('event: swarm_complete\n');
    });
});
