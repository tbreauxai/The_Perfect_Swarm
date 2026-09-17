import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './engine.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { globalTokenBudgetManager, globalSpecialistProfiler, globalNodeCapacityManager } from './loadBalancer.ts';

describe('Dynamic Task Routing & Token Allocation in Engine Step 4', () => {
    beforeEach(() => {
        globalTokenBudgetManager.reset();
        globalSpecialistProfiler.reset();
        globalNodeCapacityManager.reset();
    });

    it('emits Specialist Dynamic Routing event and tracks token budget for single-chunk workloads', async () => {
        ProviderRegistry.register({
            providerName: 'custom-mock',
            async call(options) {
                return JSON.stringify({
                    insights: [`Analysis from ${options.modelName || 'model'}`],
                    anomalies: [],
                    summary: 'Analysis completed successfully'
                });
            }
        });

        const result = await executeSwarmWorkflow({
            task: 'Audit authentication token security and JWT expiration',
            data: 'short payload for single chunk',
            forceFullSwarm: true,
            settings: {
                appId: 'test-dynamic-routing-single',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mgr', model: 'mock-mgr' },
                    { id: 'sec-spec', role: 'Security Specialist', provider: 'custom-mock', apiKey: 'k-sec', model: 'mock-sec' },
                    { id: 'perf-spec', role: 'Performance Specialist', provider: 'custom-mock', apiKey: 'k-perf', model: 'mock-perf' }
                ]
            }
        });

        // 1. Verify Specialist Dynamic Routing event emission
        const routingEvent = result.events.find(e => e.action === 'Specialist Dynamic Routing');
        expect(routingEvent).toBeDefined();
        expect(routingEvent?.agentRole).toBe('Dynamic Task Router');
        expect(routingEvent?.modelName).toBe('Local/AffinityRouter');

        // 2. Verify routing plan output structure
        const output = routingEvent?.output;
        expect(output).toBeDefined();
        expect(output.totalChunks).toBe(1);
        expect(output.assignments).toHaveLength(2);
        expect(output.specialistSummary['Security Specialist']).toBeDefined();
        expect(output.specialistSummary['Performance Specialist']).toBeDefined();

        // 3. Verify security specialist received higher affinity for auth task
        const secAssignment = output.assignments.find((a: any) => a.agentRole === 'Security Specialist');
        const perfAssignment = output.assignments.find((a: any) => a.agentRole === 'Performance Specialist');
        expect(secAssignment.affinityScore).toBeGreaterThan(perfAssignment.affinityScore);

        // 4. Verify token budget manager tracked consumption
        const metrics = globalTokenBudgetManager.getMetrics();
        expect(metrics['custom-mock']).toBeDefined();
        expect(metrics['custom-mock'].totalCumulativeTokens).toBeGreaterThan(0);
    });

    it('routes multiple data chunks to specialists based on domain affinity and token capacity', async () => {
        const assignedRoles: string[] = [];

        ProviderRegistry.register({
            providerName: 'routing-mock-prov',
            async call(options) {
                // Record the system instruction or prompt context
                if (options.systemInstruction?.includes('Security')) {
                    assignedRoles.push('Security');
                } else if (options.systemInstruction?.includes('Performance')) {
                    assignedRoles.push('Performance');
                }
                return JSON.stringify({
                    insights: ['Chunk insight'],
                    anomalies: [],
                    summary: 'OK'
                });
            }
        });

        // Create a large payload that exceeds DEFAULT_MAX_TOKENS_PER_CHUNK (8000 tokens / 32,000 chars)
        const securityChunkContent = 'auth jwt token vulnerability permission credential attack breach secret xss csrf\n'.repeat(800);
        const perfChunkContent = 'latency throughput bottleneck memory cpu cache tpm slow benchmark allocation leak\n'.repeat(800);
        const combinedData = `${securityChunkContent}\n${perfChunkContent}`;

        const result = await executeSwarmWorkflow({
            task: 'Analyze system telemetry for security vulnerabilities and latency bottlenecks',
            data: combinedData,
            forceFullSwarm: true,
            settings: {
                appId: 'test-dynamic-routing-multi',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'routing-mock-prov', apiKey: 'k', model: 'm' },
                    { id: 'sec-spec', role: 'Security Analyst', provider: 'routing-mock-prov', apiKey: 'k', model: 'm' },
                    { id: 'perf-spec', role: 'Performance Engineer', provider: 'routing-mock-prov', apiKey: 'k', model: 'm' }
                ]
            }
        });

        const routingEvent = result.events.find(e => e.action === 'Specialist Dynamic Routing');
        expect(routingEvent).toBeDefined();
        expect(routingEvent?.output.totalChunks).toBeGreaterThanOrEqual(2);

        // Verify assignments map each chunk to appropriate specialists
        const assignments = routingEvent?.output.assignments;
        expect(assignments.length).toBeGreaterThanOrEqual(2);

        // Verify summary accounts for all assigned chunks
        const summary = routingEvent?.output.specialistSummary;
        expect(summary['Security Analyst']).toBeDefined();
        expect(summary['Performance Engineer']).toBeDefined();
        const totalAssignedChunks = Object.values(summary).reduce((acc: number, s: any) => acc + s.chunksAssigned, 0);
        expect(totalAssignedChunks).toBe(routingEvent?.output.totalChunks);

        // Verify execution results produced
        expect(result.finalAnalysis).toBeDefined();

        // Verify Workflow Metrics Baseline was emitted and attached to result
        const baselineEvent = result.events.find(e => e.action === 'Workflow Metrics Baseline');
        expect(baselineEvent).toBeDefined();
        expect(baselineEvent?.agentRole).toBe('System Profiler');
        expect(baselineEvent?.output.totalTasks).toBeGreaterThanOrEqual(1);

        expect(result.metrics).toBeDefined();
        expect(result.metrics?.overallCompletionRatePercent).toBe(100);
        expect(result.metrics?.overallLatency.sampleCount).toBeGreaterThanOrEqual(1);
    }, 15000);

    it('records baseline metrics on fast-path execution', async () => {
        const result = await executeSwarmWorkflow({
            task: 'ping health check',
            data: 'status=ok',
            settings: {
                appId: 'test-fast-metrics',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k', model: 'm' },
                    { id: 'a1', role: 'Analyst', provider: 'custom-mock', apiKey: 'k', model: 'm' }
                ]
            }
        });

        expect(result.metrics).toBeDefined();
        expect(result.metrics?.overallCompletionRatePercent).toBe(100);
        const baselineEvent = result.events.find(e => e.action === 'Workflow Metrics Baseline');
        expect(baselineEvent).toBeDefined();
    });

    it('records RL capability outcomes for specialists during workflow execution and emits capability profiles', async () => {
        ProviderRegistry.register({
            providerName: 'rl-test-prov',
            async call() {
                return JSON.stringify({
                    insights: ['Verified security insight'],
                    anomalies: [],
                    summary: 'Security analysis complete'
                });
            }
        });

        const result = await executeSwarmWorkflow({
            task: 'Audit authentication token security',
            data: 'test auth data block',
            forceFullSwarm: true,
            settings: {
                appId: 'test-rl-profiling',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'rl-test-prov', apiKey: 'k', model: 'm' },
                    { id: 'sec', role: 'Security Specialist', provider: 'rl-test-prov', apiKey: 'k', model: 'm' }
                ]
            }
        });

        // 1. Verify routing event contains capabilityProfiles structure
        const routingEvent = result.events.find(e => e.action === 'Specialist Dynamic Routing');
        expect(routingEvent).toBeDefined();
        expect(routingEvent?.output.capabilityProfiles).toBeDefined();

        // 2. Verify globalSpecialistProfiler recorded the analyst outcome
        const secProfile = globalSpecialistProfiler.getProfile('Security Specialist');
        expect(secProfile).toBeDefined();
        expect(secProfile?.trials).toBeGreaterThanOrEqual(1);
        expect(secProfile?.successes).toBeGreaterThanOrEqual(1);
        expect(secProfile?.completionRate).toBe(1.0);
        expect(secProfile?.averageReward).toBeGreaterThan(0.70);
    });

    it('emits nodeCapacity metrics in routing event and manages slot lifecycle without leaks', async () => {
        ProviderRegistry.register({
            providerName: 'capacity-test-prov',
            async call() {
                return JSON.stringify({
                    insights: ['Capacity verified insight'],
                    anomalies: [],
                    summary: 'Capacity analysis complete'
                });
            }
        });

        const result = await executeSwarmWorkflow({
            task: 'Audit system performance under high concurrency',
            data: 'test payload',
            forceFullSwarm: true,
            settings: {
                appId: 'test-node-capacity',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'capacity-test-prov', apiKey: 'k', model: 'm' },
                    { id: 'perf-node', role: 'Performance Engineer', provider: 'capacity-test-prov', apiKey: 'k', model: 'm' }
                ]
            }
        });

        // 1. Verify routing event contains nodeCapacity telemetry
        const routingEvent = result.events.find(e => e.action === 'Specialist Dynamic Routing');
        expect(routingEvent).toBeDefined();
        expect(routingEvent?.output.nodeCapacity).toBeDefined();

        // 2. Verify all slots were released after execution (0 in-flight)
        const perfMetrics = globalNodeCapacityManager.getNodeMetrics('perf-node');
        expect(perfMetrics.activeInFlight).toBe(0);
        expect(perfMetrics.totalSlotsAcquired).toBeGreaterThanOrEqual(1);
        expect(perfMetrics.totalSlotsReleased).toBeGreaterThanOrEqual(1);
        expect(perfMetrics.totalSlotsAcquired).toBe(perfMetrics.totalSlotsReleased);
    });

    it('emits Hierarchical Swarm Communication event with cluster digests and token reduction', async () => {
        ProviderRegistry.register({
            providerName: 'hierarchical-test-prov',
            async call(options) {
                if (options.systemInstruction?.includes('Orchestrator') || options.prompt?.includes('Analyst Reports') || options.prompt?.includes('Cluster Digests')) {
                    return JSON.stringify({
                        ui_title: 'Hierarchical Swarm Dashboard',
                        components: [
                            { id: 'c1', type: 'MetricCard', props: { title: 'Status', value: 'Active' } }
                        ]
                    });
                }
                if (options.modelName === 'sec-model') {
                    return JSON.stringify({
                        insights: ['JWT token validated', 'Token expiration set to 15m'],
                        anomalies: ['Missing CSP header'],
                        summary: 'Security audit complete'
                    });
                }
                return JSON.stringify({
                    insights: ['P99 latency within 20ms baseline', 'Throughput healthy'],
                    anomalies: [],
                    summary: 'Performance audit complete'
                });
            }
        });

        const result = await executeSwarmWorkflow({
            task: 'Analyze system telemetry for auth vulnerabilities and latency',
            data: 'test auth and latency telemetry block',
            forceFullSwarm: true,
            settings: {
                appId: 'test-hierarchical-comm',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'hierarchical-test-prov', apiKey: 'k', model: 'mgr-model' },
                    { id: 'sec-spec', role: 'Security Specialist', provider: 'hierarchical-test-prov', apiKey: 'k', model: 'sec-model' },
                    { id: 'sec-audit', role: 'Security Auditor', provider: 'hierarchical-test-prov', apiKey: 'k', model: 'sec-model' },
                    { id: 'perf-spec', role: 'Performance Engineer', provider: 'hierarchical-test-prov', apiKey: 'k', model: 'perf-model' }
                ]
            }
        });

        // 1. Verify Hierarchical Swarm Communication event emission
        const commEvent = result.events.find(e => e.action === 'Hierarchical Swarm Communication');
        expect(commEvent).toBeDefined();
        expect(commEvent?.agentRole).toBe('Hierarchical Communication Layer');
        expect(commEvent?.modelName).toBe('Local/HierarchicalBus');

        // 2. Verify cluster digests generated for both pods
        const digests = commEvent?.output.digests;
        expect(digests).toBeDefined();
        expect(digests['security-pod']).toBeDefined();
        expect(digests['performance-pod']).toBeDefined();

        expect(digests['security-pod'].specialistRoles).toContain('Security Specialist');
        expect(digests['security-pod'].keyFindings).toContain('JWT token validated');
        expect(digests['security-pod'].anomalies).toContain('Missing CSP header');

        // 3. Verify bus metrics
        const metrics = commEvent?.output.metrics;
        expect(metrics).toBeDefined();
        expect(metrics.totalSent).toBeGreaterThanOrEqual(2);
        expect(metrics.digestsGenerated).toBeGreaterThanOrEqual(2);
        expect(metrics.overallCompressionRatio).toBeGreaterThan(0);

        // 4. Verify topology auto-discovery & lead election output
        const topology = commEvent?.output.topology;
        expect(topology).toBeDefined();
        expect(topology.totalPods).toBeGreaterThanOrEqual(2);
        expect(topology.pods['security-pod']).toBeDefined();
        expect(topology.pods['performance-pod']).toBeDefined();
        expect(topology.pods['security-pod'].leadNodeId).toBeDefined();
        expect(topology.pods['performance-pod'].leadNodeId).toBeDefined();
        expect(topology.leadNodeIds).toContain(topology.pods['security-pod'].leadNodeId);
        expect(topology.leadNodeIds).toContain(topology.pods['performance-pod'].leadNodeId);
    });

    it('auto-discovers domain pods and elects cluster leads based on capability profile and headroom', async () => {
        ProviderRegistry.register({
            providerName: 'lead-election-prov',
            async call(options) {
                if (options.systemInstruction?.includes('Orchestrator') || options.prompt?.includes('Analyst Reports') || options.prompt?.includes('Cluster Digests')) {
                    return JSON.stringify({
                        ui_title: 'Lead Election Dashboard',
                        components: [{ id: 'c1', type: 'MetricCard', props: { title: 'Clusters', value: '2' } }]
                    });
                }
                return JSON.stringify({
                    insights: [`Analysis from ${options.modelName || 'agent'}`],
                    anomalies: [],
                    summary: 'Pod analysis finished'
                });
            }
        });

        // Boost capability profile for 'Senior Security Lead'
        globalSpecialistProfiler.recordOutcome('Senior Security Lead', {
            success: true,
            qualityRating: 0.98,
            durationMs: 400
        });
        globalSpecialistProfiler.recordOutcome('Senior Security Lead', {
            success: true,
            qualityRating: 0.99,
            durationMs: 350
        });

        // 'Junior Security Analyst' has lower rating
        globalSpecialistProfiler.recordOutcome('Junior Security Analyst', {
            success: true,
            qualityRating: 0.70,
            durationMs: 1200
        });

        const stagePayloads: any[] = [];
        const result = await executeSwarmWorkflow({
            task: 'Audit authentication token security and investigate memory cache latency',
            data: 'test auth and cache data',
            forceFullSwarm: true,
            onStage: (payload) => {
                stagePayloads.push(payload);
            },
            settings: {
                appId: 'test-lead-election',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'lead-election-prov', apiKey: 'k', model: 'mgr' },
                    { id: 'sec-senior', role: 'Senior Security Lead', provider: 'lead-election-prov', apiKey: 'k', model: 'm1' },
                    { id: 'sec-junior', role: 'Junior Security Analyst', provider: 'lead-election-prov', apiKey: 'k', model: 'm2' },
                    { id: 'perf-expert', role: 'Performance Engineer', provider: 'lead-election-prov', apiKey: 'k', model: 'm3' }
                ]
            }
        });

        const commEvent = result.events.find(e => e.action === 'Hierarchical Swarm Communication');
        expect(commEvent).toBeDefined();

        const topology = commEvent?.output.topology;
        expect(topology).toBeDefined();
        expect(topology.totalPods).toBe(2);

        // Security pod should have elected 'sec-senior' due to higher UCB1 capability score
        expect(topology.pods['security-pod'].leadNodeId).toBe('sec-senior');
        expect(topology.pods['performance-pod'].leadNodeId).toBe('perf-expert');
        expect(topology.leadNodeIds).toContain('sec-senior');
        expect(topology.leadNodeIds).toContain('perf-expert');

        // Verify onStage received cluster_aggregation stage with topology
        const clusterStage = stagePayloads.find(p => p.stage === 'cluster_aggregation');
        expect(clusterStage).toBeDefined();
        expect(clusterStage.topology).toBeDefined();
        expect(clusterStage.topology.pods['security-pod'].leadNodeId).toBe('sec-senior');
    });
});
