import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    HierarchicalMessageBus,
    globalHierarchicalMessageBus,
    ClusterTopologyManager,
    globalClusterTopologyManager,
    type ClusterNode,
    type HierarchicalMessage,
    type SpecialistNodeInput
} from './communication.ts';

describe('HierarchicalMessageBus: Multi-Tier Scoped Routing', () => {
    let bus: HierarchicalMessageBus;

    beforeEach(() => {
        bus = new HierarchicalMessageBus();
        globalHierarchicalMessageBus.reset();
    });

    it('registers and discovers nodes across multi-tier hierarchy', () => {
        const root: ClusterNode = { id: 'root-mgr', role: 'Root Manager', layer: 'root', clusterId: 'root-cluster' };
        const secLead: ClusterNode = { id: 'sec-lead', role: 'Security Cluster Lead', layer: 'cluster-lead', clusterId: 'security-pod' };
        const secWorker1: ClusterNode = { id: 'sec-w1', role: 'Auth Specialist', layer: 'specialist', clusterId: 'security-pod' };
        const secWorker2: ClusterNode = { id: 'sec-w2', role: 'Vulnerability Auditor', layer: 'specialist', clusterId: 'security-pod' };
        const perfLead: ClusterNode = { id: 'perf-lead', role: 'Performance Cluster Lead', layer: 'cluster-lead', clusterId: 'perf-pod' };

        bus.registerNode(root);
        bus.registerNode(secLead);
        bus.registerNode(secWorker1);
        bus.registerNode(secWorker2);
        bus.registerNode(perfLead);

        expect(bus.getRootNode()?.id).toBe('root-mgr');
        expect(bus.getClusterLead('security-pod')?.id).toBe('sec-lead');
        expect(bus.getClusterLead('perf-pod')?.id).toBe('perf-lead');
        expect(bus.getClusterLead('nonexistent-pod')).toBeUndefined();

        const secNodes = bus.getClusterNodes('security-pod');
        expect(secNodes).toHaveLength(3);
        expect(secNodes.map(n => n.id)).toEqual(expect.arrayContaining(['sec-lead', 'sec-w1', 'sec-w2']));

        // Unregister test
        expect(bus.unregisterNode('sec-w2')).toBe(true);
        expect(bus.getNode('sec-w2')).toBeUndefined();
        expect(bus.getClusterNodes('security-pod')).toHaveLength(2);
    });

    it('routes local messages strictly to the sender node', async () => {
        const worker: ClusterNode = { id: 'w1', role: 'Worker', layer: 'specialist', clusterId: 'cluster-a' };
        const other: ClusterNode = { id: 'w2', role: 'Worker 2', layer: 'specialist', clusterId: 'cluster-a' };
        bus.registerNode(worker);
        bus.registerNode(other);

        const w1Received: any[] = [];
        const w2Received: any[] = [];
        bus.subscribe('w1', msg => w1Received.push(msg));
        bus.subscribe('w2', msg => w2Received.push(msg));

        const result = await bus.dispatch({
            senderId: 'w1',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'cluster-a',
            scope: 'local',
            payload: { data: 'private memory' }
        });

        expect(result.deliveredCount).toBe(1);
        expect(result.recipientIds).toEqual(['w1']);
        expect(w1Received).toHaveLength(1);
        expect(w1Received[0].payload.data).toBe('private memory');
        expect(w2Received).toHaveLength(0);
    });

    it('routes cluster messages to all peers within cluster pod while isolating other clusters', async () => {
        const secLead: ClusterNode = { id: 'sec-lead', role: 'Security Lead', layer: 'cluster-lead', clusterId: 'sec-pod' };
        const secW1: ClusterNode = { id: 'sec-w1', role: 'Sec Worker 1', layer: 'specialist', clusterId: 'sec-pod' };
        const secW2: ClusterNode = { id: 'sec-w2', role: 'Sec Worker 2', layer: 'specialist', clusterId: 'sec-pod' };
        const perfW1: ClusterNode = { id: 'perf-w1', role: 'Perf Worker', layer: 'specialist', clusterId: 'perf-pod' };

        bus.registerNode(secLead);
        bus.registerNode(secW1);
        bus.registerNode(secW2);
        bus.registerNode(perfW1);

        const receivedLead: any[] = [];
        const receivedW1: any[] = [];
        const receivedW2: any[] = [];
        const receivedPerf: any[] = [];

        bus.subscribe('sec-lead', msg => receivedLead.push(msg));
        bus.subscribe('sec-w1', msg => receivedW1.push(msg));
        bus.subscribe('sec-w2', msg => receivedW2.push(msg));
        bus.subscribe('perf-w1', msg => receivedPerf.push(msg));

        // sec-w1 dispatches cluster message
        const result = await bus.dispatch({
            senderId: 'sec-w1',
            senderRole: 'Sec Worker 1',
            senderLayer: 'specialist',
            clusterId: 'sec-pod',
            scope: 'cluster',
            payload: { alert: 'Suspicious credential activity' }
        });

        expect(result.deliveredCount).toBe(2);
        expect(result.recipientIds).toEqual(expect.arrayContaining(['sec-lead', 'sec-w2']));
        expect(receivedW1).toHaveLength(0); // Excludes sender
        expect(receivedLead).toHaveLength(1);
        expect(receivedW2).toHaveLength(1);
        expect(receivedPerf).toHaveLength(0); // Completely isolated from perf-pod
    });

    it('cascades upward messages from specialists to cluster leads and from cluster leads to root', async () => {
        const root: ClusterNode = { id: 'root', role: 'Root', layer: 'root', clusterId: 'root-cluster' };
        const lead: ClusterNode = { id: 'lead', role: 'Lead', layer: 'cluster-lead', clusterId: 'pod-1' };
        const worker: ClusterNode = { id: 'worker', role: 'Worker', layer: 'specialist', clusterId: 'pod-1' };

        bus.registerNode(root);
        bus.registerNode(lead);
        bus.registerNode(worker);

        const rootReceived: any[] = [];
        const leadReceived: any[] = [];
        bus.subscribe('root', msg => rootReceived.push(msg));
        bus.subscribe('lead', msg => leadReceived.push(msg));

        // 1. Worker sends upward -> should arrive at cluster lead
        const resWorker = await bus.dispatch({
            senderId: 'worker',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'pod-1',
            scope: 'upward',
            payload: { finding: 'Pod finding' }
        });

        expect(resWorker.deliveredCount).toBe(1);
        expect(resWorker.recipientIds).toEqual(['lead']);
        expect(leadReceived).toHaveLength(1);
        expect(rootReceived).toHaveLength(0);

        // 2. Cluster lead sends upward -> should arrive at root
        const resLead = await bus.dispatch({
            senderId: 'lead',
            senderRole: 'Lead',
            senderLayer: 'cluster-lead',
            clusterId: 'pod-1',
            scope: 'upward',
            payload: { digest: 'Pod digest summary' }
        });

        expect(resLead.deliveredCount).toBe(1);
        expect(resLead.recipientIds).toEqual(['root']);
        expect(rootReceived).toHaveLength(1);

        // 3. Root sends upward -> should drop because root has no parent
        const resRoot = await bus.dispatch({
            senderId: 'root',
            senderRole: 'Root',
            senderLayer: 'root',
            clusterId: 'root-cluster',
            scope: 'upward',
            payload: { test: 'noop' }
        });

        expect(resRoot.dropped).toBe(true);
        expect(resRoot.deliveredCount).toBe(0);
    });

    it('routes upward directly to root if cluster has no designated cluster lead', async () => {
        const root: ClusterNode = { id: 'root', role: 'Root', layer: 'root', clusterId: 'root-cluster' };
        const orphanWorker: ClusterNode = { id: 'orphan', role: 'Orphan Worker', layer: 'specialist', clusterId: 'flat-pod' };

        bus.registerNode(root);
        bus.registerNode(orphanWorker);

        const rootReceived: any[] = [];
        bus.subscribe('root', msg => rootReceived.push(msg));

        const result = await bus.dispatch({
            senderId: 'orphan',
            senderRole: 'Orphan Worker',
            senderLayer: 'specialist',
            clusterId: 'flat-pod',
            scope: 'upward',
            payload: { direct: 'Report directly to root' }
        });

        expect(result.deliveredCount).toBe(1);
        expect(result.recipientIds).toEqual(['root']);
        expect(rootReceived).toHaveLength(1);
    });

    it('routes targeted messages directly to the designated recipient and drops unknown recipients', async () => {
        const n1: ClusterNode = { id: 'n1', role: 'Node 1', layer: 'specialist', clusterId: 'c1' };
        const n2: ClusterNode = { id: 'n2', role: 'Node 2', layer: 'specialist', clusterId: 'c2' };
        bus.registerNode(n1);
        bus.registerNode(n2);

        const n2Received: any[] = [];
        bus.subscribe('n2', msg => n2Received.push(msg));

        // Valid targeted
        const res1 = await bus.dispatch({
            senderId: 'n1',
            senderRole: 'Node 1',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'targeted',
            recipientId: 'n2',
            payload: { secret: 'peer-to-peer data' }
        });

        expect(res1.deliveredCount).toBe(1);
        expect(res1.recipientIds).toEqual(['n2']);
        expect(n2Received).toHaveLength(1);

        // Targeted to unknown node
        const res2 = await bus.dispatch({
            senderId: 'n1',
            senderRole: 'Node 1',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'targeted',
            recipientId: 'unknown-node-xyz',
            payload: { error: 'should drop' }
        });

        expect(res2.dropped).toBe(true);
        expect(res2.deliveredCount).toBe(0);
    });

    it('delivers broadcast messages to all nodes except the sender', async () => {
        const root: ClusterNode = { id: 'root', role: 'Root', layer: 'root', clusterId: 'root-cluster' };
        const w1: ClusterNode = { id: 'w1', role: 'W1', layer: 'specialist', clusterId: 'c1' };
        const w2: ClusterNode = { id: 'w2', role: 'W2', layer: 'specialist', clusterId: 'c2' };

        bus.registerNode(root);
        bus.registerNode(w1);
        bus.registerNode(w2);

        const rootReceived: any[] = [];
        const w1Received: any[] = [];
        const w2Received: any[] = [];

        bus.subscribe('root', msg => rootReceived.push(msg));
        bus.subscribe('w1', msg => w1Received.push(msg));
        bus.subscribe('w2', msg => w2Received.push(msg));

        const res = await bus.dispatch({
            senderId: 'root',
            senderRole: 'Root',
            senderLayer: 'root',
            clusterId: 'root-cluster',
            scope: 'broadcast',
            payload: { announcement: 'Global directive: enter low-power mode' }
        });

        expect(res.deliveredCount).toBe(2);
        expect(res.recipientIds).toEqual(expect.arrayContaining(['w1', 'w2']));
        expect(rootReceived).toHaveLength(0);
        expect(w1Received).toHaveLength(1);
        expect(w2Received).toHaveLength(1);
    });

    it('handles async listeners and isolates listener exceptions safely', async () => {
        const node: ClusterNode = { id: 'n1', role: 'Worker', layer: 'specialist', clusterId: 'c1' };
        bus.registerNode(node);

        const mockConsole = vi.spyOn(console, 'error').mockImplementation(() => {});

        let asyncReceived = false;
        bus.subscribe('n1', async () => {
            await new Promise(r => setTimeout(r, 10));
            asyncReceived = true;
        });

        bus.subscribe('n1', () => {
            throw new Error('Explosion in buggy listener');
        });

        const res = await bus.dispatch({
            senderId: 'n1',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'local',
            payload: { ping: true }
        });

        expect(res.deliveredCount).toBe(1);
        expect(asyncReceived).toBe(true);
        expect(mockConsole).toHaveBeenCalled();
        mockConsole.mockRestore();
    });

    it('tracks accurate aggregate metrics across scopes, clusters, and layers', async () => {
        const root: ClusterNode = { id: 'root', role: 'Root', layer: 'root', clusterId: 'core' };
        const w1: ClusterNode = { id: 'w1', role: 'W1', layer: 'specialist', clusterId: 'c1' };
        bus.registerNode(root);
        bus.registerNode(w1);

        await bus.dispatch({
            senderId: 'w1',
            senderRole: 'W1',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'local',
            payload: { a: 1 }
        });

        await bus.dispatch({
            senderId: 'w1',
            senderRole: 'W1',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'upward',
            payload: { a: 2 }
        });

        // Trigger dropped message
        await bus.dispatch({
            senderId: 'w1',
            senderRole: 'W1',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'targeted',
            recipientId: 'missing-node',
            payload: { a: 3 }
        });

        const metrics = bus.getMetrics();
        expect(metrics.totalSent).toBe(3);
        expect(metrics.totalDelivered).toBe(2);
        expect(metrics.totalDropped).toBe(1);
        expect(metrics.byScope.local).toBe(1);
        expect(metrics.byScope.upward).toBe(1);
        expect(metrics.byScope.targeted).toBe(1);
        expect(metrics.byLayer.specialist).toBe(3);
        expect(metrics.byCluster['c1']).toBe(3);
        expect(metrics.activeNodesCount).toBe(2);

        bus.reset();
        const freshMetrics = bus.getMetrics();
        expect(freshMetrics.totalSent).toBe(0);
        expect(freshMetrics.activeNodesCount).toBe(0);
    });

    it('suppresses in-flight duplicate messages within deduplication window and allows bypass', async () => {
        const customBus = new HierarchicalMessageBus({ dedupWindowMs: 200 });
        const node: ClusterNode = { id: 'w1', role: 'Worker', layer: 'specialist', clusterId: 'c1' };
        customBus.registerNode(node);

        const received: any[] = [];
        customBus.subscribe('w1', m => received.push(m));

        // First message should be delivered
        const res1 = await customBus.dispatch({
            senderId: 'w1',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'local',
            payload: { alert: 'CPU spike 95%' }
        });
        expect(res1.deliveredCount).toBe(1);
        expect(res1.suppressed).toBeFalsy();

        // Immediate identical message should be suppressed
        const res2 = await customBus.dispatch({
            senderId: 'w1',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'local',
            payload: { alert: 'CPU spike 95%' }
        });
        expect(res2.suppressed).toBe(true);
        expect(res2.deliveredCount).toBe(0);
        expect(customBus.getMetrics().duplicatesSuppressed).toBe(1);

        // Identical message with bypassDedup should be delivered
        const res3 = await customBus.dispatch({
            senderId: 'w1',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'local',
            metadata: { bypassDedup: true },
            payload: { alert: 'CPU spike 95%' }
        });
        expect(res3.deliveredCount).toBe(1);
        expect(res3.suppressed).toBeFalsy();

        // Wait for window expiration
        await new Promise(r => setTimeout(r, 220));

        // After window expires, message should be delivered again
        const res4 = await customBus.dispatch({
            senderId: 'w1',
            senderRole: 'Worker',
            senderLayer: 'specialist',
            clusterId: 'c1',
            scope: 'local',
            payload: { alert: 'CPU spike 95%' }
        });
        expect(res4.deliveredCount).toBe(1);
        expect(res4.suppressed).toBeFalsy();
    });

    it('aggregates multiple specialist reports into deduplicated cluster digest with token reduction', () => {
        const busInstance = new HierarchicalMessageBus();
        const reports = [
            {
                specialistRole: 'Auth Specialist',
                insights: [
                    'JWT access token expires in 15 minutes',
                    'Refresh tokens stored in httpOnly secure cookie',
                    'Replay attacks mitigated by nonce check'
                ],
                anomalies: [
                    'Missing rate limit on login endpoint'
                ],
                summary: 'Authentication configuration inspected and verified.'
            },
            {
                specialistRole: 'Vulnerability Auditor',
                insights: [
                    'jwt access token expires in 15 minutes.', // Duplicate insight with minor punctuation/casing
                    'CORS policy restricts access to authorized origins only',
                    'Replay attacks mitigated by nonce check' // Exact duplicate
                ],
                anomalies: [
                    'missing rate limit on login endpoint.', // Duplicate anomaly
                    'CSRF protection disabled on public webhooks'
                ],
                summary: 'Vulnerability audit identified minor webhook configuration risk.'
            }
        ];

        const digest = busInstance.aggregateClusterReports('security-cluster', reports);

        expect(digest.clusterId).toBe('security-cluster');
        expect(digest.specialistCount).toBe(2);
        expect(digest.specialistRoles).toEqual(['Auth Specialist', 'Vulnerability Auditor']);

        // Insights should be deduplicated (4 unique out of 6)
        expect(digest.keyFindings).toHaveLength(4);
        expect(digest.keyFindings).toContain('JWT access token expires in 15 minutes');
        expect(digest.keyFindings).toContain('CORS policy restricts access to authorized origins only');

        // Anomalies should be deduplicated (2 unique out of 3)
        expect(digest.anomalies).toHaveLength(2);
        expect(digest.anomalies).toContain('Missing rate limit on login endpoint');
        expect(digest.anomalies).toContain('CSRF protection disabled on public webhooks');

        // Token compression metrics
        expect(digest.originalTokensEstimate).toBeGreaterThan(digest.compressedTokensEstimate);
        expect(digest.tokenReductionRatio).toBeGreaterThan(0.20); // At least 20% token reduction

        const metrics = busInstance.getMetrics();
        expect(metrics.digestsGenerated).toBe(1);
        expect(metrics.originalTokensProcessed).toBe(digest.originalTokensEstimate);
        expect(metrics.compressedTokensEmitted).toBe(digest.compressedTokensEstimate);
        expect(metrics.overallCompressionRatio).toBe(digest.tokenReductionRatio);
    });

    it('filters downward broadcast directives by target domains', async () => {
        const secLead: ClusterNode = { id: 'sec-lead', role: 'Sec Lead', layer: 'cluster-lead', clusterId: 'security-pod', domain: 'security' };
        const secW: ClusterNode = { id: 'sec-w', role: 'Sec Worker', layer: 'specialist', clusterId: 'security-pod', domain: 'security' };
        const perfLead: ClusterNode = { id: 'perf-lead', role: 'Perf Lead', layer: 'cluster-lead', clusterId: 'perf-pod', domain: 'performance' };
        const perfW: ClusterNode = { id: 'perf-w', role: 'Perf Worker', layer: 'specialist', clusterId: 'perf-pod', domain: 'performance' };
        const root: ClusterNode = { id: 'root', role: 'Root Manager', layer: 'root', clusterId: 'core' };

        bus.registerNode(root);
        bus.registerNode(secLead);
        bus.registerNode(secW);
        bus.registerNode(perfLead);
        bus.registerNode(perfW);

        const secReceived: any[] = [];
        const perfReceived: any[] = [];
        bus.subscribe('sec-lead', m => secReceived.push(m));
        bus.subscribe('sec-w', m => secReceived.push(m));
        bus.subscribe('perf-lead', m => perfReceived.push(m));
        bus.subscribe('perf-w', m => perfReceived.push(m));

        // Broadcast targeting only security domain
        const res = await bus.dispatch({
            senderId: 'root',
            senderRole: 'Root Manager',
            senderLayer: 'root',
            clusterId: 'core',
            scope: 'broadcast',
            metadata: { targetDomains: ['security'] },
            payload: { directive: 'Mandatory rotation of HMAC secrets' }
        });

        expect(res.deliveredCount).toBe(2);
        expect(res.recipientIds).toEqual(expect.arrayContaining(['sec-lead', 'sec-w']));
        expect(secReceived).toHaveLength(2);
        expect(perfReceived).toHaveLength(0); // Filtered out

        const metrics = bus.getMetrics();
        expect(metrics.downwardDirectivesFiltered).toBe(2); // perf-lead & perf-w filtered out
    });
});

describe('ClusterTopologyManager: Dynamic Auto-Discovery & Lead Election', () => {
    let topologyManager: ClusterTopologyManager;

    beforeEach(() => {
        topologyManager = new ClusterTopologyManager();
    });

    it('auto-discovers domain pods based on specialist roles and task keywords', () => {
        const specialists: SpecialistNodeInput[] = [
            { id: 's1', role: 'Security Auditor' },
            { id: 's2', role: 'Auth & JWT Specialist' },
            { id: 'p1', role: 'Latency Benchmark Engineer' },
            { id: 'p2', role: 'Memory Allocation Profiler' },
            { id: 'd1', role: 'SQL Schema Analyst' },
            { id: 'g1', role: 'Generalist Worker' }
        ];

        const topology = topologyManager.discoverTopology({
            specialists,
            task: 'Audit system authentication vulnerabilities and API throughput bottlenecks'
        });

        expect(topology.totalSpecialists).toBe(6);
        expect(topology.totalPods).toBe(4); // security-pod, performance-pod, data-pod, general-pod

        expect(topology.pods['security-pod']).toBeDefined();
        expect(topology.pods['security-pod'].memberNodeIds).toEqual(expect.arrayContaining(['s1', 's2']));

        expect(topology.pods['performance-pod']).toBeDefined();
        expect(topology.pods['performance-pod'].memberNodeIds).toEqual(expect.arrayContaining(['p1', 'p2']));

        expect(topology.pods['data-pod']).toBeDefined();
        expect(topology.pods['data-pod'].memberNodeIds).toEqual(['d1']);

        expect(topology.pods['general-pod']).toBeDefined();
        expect(topology.pods['general-pod'].memberNodeIds).toEqual(['g1']);
    });

    it('elects cluster leads based on capability scores and capacity headroom', () => {
        const specialists: SpecialistNodeInput[] = [
            { id: 'sec-junior', role: 'Junior Security Auditor' },
            { id: 'sec-senior', role: 'Senior Security Architect' }
        ];

        // Custom capability scorer favoring Senior Architect
        const capabilityScorer = (role: string) => {
            return role.includes('Senior') ? 1.95 : 0.80;
        };

        const headroomGetter = (nodeKey: string) => {
            return nodeKey === 'sec-senior' ? 3 : 1;
        };

        const topology = topologyManager.discoverTopology({
            specialists,
            capabilityScorer,
            capacityHeadroomGetter: headroomGetter
        });

        const secPod = topology.pods['security-pod'];
        expect(secPod).toBeDefined();
        expect(secPod.leadNodeId).toBe('sec-senior');
        expect(secPod.leadRole).toBe('Senior Security Architect');
        expect(secPod.electionReason).toContain('capability score');
    });

    it('rebalances cluster leads when active lead becomes saturated', () => {
        const specialists: SpecialistNodeInput[] = [
            { id: 'p1', role: 'Performance Engineer 1' },
            { id: 'p2', role: 'Performance Engineer 2' }
        ];

        const initialTopology = topologyManager.discoverTopology({
            specialists,
            capabilityScorer: (role) => (role.includes('1') ? 1.5 : 1.2)
        });

        expect(initialTopology.pods['performance-pod'].leadNodeId).toBe('p1');

        // Now p1 is saturated
        const rebalanced = topologyManager.rebalanceTopology(initialTopology, ['p1']);
        expect(rebalanced.pods['performance-pod'].leadNodeId).toBe('p2');
        expect(rebalanced.pods['performance-pod'].leadRole).toBe('Performance Engineer 2');
        expect(rebalanced.pods['performance-pod'].electionReason).toContain('Rebalanced');
    });

    it('applies discovered topology to HierarchicalMessageBus and verifies routing', async () => {
        const bus = new HierarchicalMessageBus();
        const specialists: SpecialistNodeInput[] = [
            { id: 'sec-lead-node', role: 'Principal Security Lead' },
            { id: 'sec-worker-node', role: 'Security Analyst' }
        ];

        const topology = topologyManager.discoverTopology({
            specialists,
            capabilityScorer: (r) => (r.includes('Principal') ? 1.9 : 1.0)
        });

        topologyManager.applyTopologyToBus(bus, topology, { id: 'root-mgr', role: 'Manager Node' });

        expect(bus.getRootNode()?.id).toBe('root-mgr');
        expect(bus.getClusterLead('security-pod')?.id).toBe('sec-lead-node');

        const secNodes = bus.getClusterNodes('security-pod');
        expect(secNodes).toHaveLength(2);

        const leadNode = bus.getNode('sec-lead-node');
        const workerNode = bus.getNode('sec-worker-node');
        expect(leadNode?.layer).toBe('cluster-lead');
        expect(workerNode?.layer).toBe('specialist');

        // Verify upward dispatch from worker reaches cluster lead
        const leadReceived: any[] = [];
        bus.subscribe('sec-lead-node', m => leadReceived.push(m));

        await bus.dispatch({
            senderId: 'sec-worker-node',
            senderRole: 'Security Analyst',
            senderLayer: 'specialist',
            clusterId: 'security-pod',
            scope: 'upward',
            payload: { finding: 'Insecure direct object reference detected' }
        });

        expect(leadReceived).toHaveLength(1);
        expect(leadReceived[0].payload.finding).toBe('Insecure direct object reference detected');
    });
});
