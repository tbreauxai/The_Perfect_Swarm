import { describe, it, expect, beforeEach } from 'vitest';
import { SharedKnowledgeGraph, globalKnowledgeGraph } from './knowledgeGraph.ts';

describe('SharedKnowledgeGraph', () => {
    let graph: SharedKnowledgeGraph;

    beforeEach(() => {
        graph = new SharedKnowledgeGraph();
    });

    it('should create and retrieve nodes with Lamport versioning', () => {
        expect(graph.getVersion()).toBe(0);

        const node = graph.addNode({
            id: 'node-auth',
            type: 'entity',
            label: 'Auth Microservice',
            confidence: 0.95,
            properties: { port: 8080 }
        });

        expect(node.id).toBe('node-auth');
        expect(node.type).toBe('entity');
        expect(node.confidence).toBe(0.95);
        expect(node.version).toBe(1);
        expect(graph.getVersion()).toBe(1);
        expect(graph.getNode('node-auth')).toEqual(node);
    });

    it('should update existing node and advance version', () => {
        graph.addNode({
            id: 'node-db',
            type: 'entity',
            label: 'Postgres DB',
            confidence: 0.8
        });

        const updated = graph.updateNode('node-db', {
            label: 'Postgres Primary Cluster',
            confidence: 0.99,
            properties: { poolSize: 50 }
        });

        expect(updated).toBeDefined();
        expect(updated?.label).toBe('Postgres Primary Cluster');
        expect(updated?.confidence).toBe(0.99);
        expect(updated?.properties.poolSize).toBe(50);
        expect(updated?.version).toBe(2);
        expect(graph.getVersion()).toBe(2);

        const nonExistent = graph.updateNode('invalid-id', { label: 'None' });
        expect(nonExistent).toBeUndefined();
    });

    it('should add directed edges between nodes and enforce referential integrity', () => {
        graph.addNode({ id: 'svc-a', type: 'entity', label: 'Service A' });
        graph.addNode({ id: 'svc-b', type: 'entity', label: 'Service B' });

        expect(() => {
            graph.addEdge({
                source: 'svc-a',
                target: 'svc-unknown',
                relation: 'depends_on'
            });
        }).toThrow(/Edge target node does not exist/);

        expect(() => {
            graph.addEdge({
                source: 'svc-unknown',
                target: 'svc-b',
                relation: 'depends_on'
            });
        }).toThrow(/Edge source node does not exist/);

        const edge = graph.addEdge({
            source: 'svc-a',
            target: 'svc-b',
            relation: 'depends_on',
            weight: 0.85,
            properties: { protocol: 'gRPC' }
        });

        expect(edge.source).toBe('svc-a');
        expect(edge.target).toBe('svc-b');
        expect(edge.relation).toBe('depends_on');
        expect(edge.weight).toBe(0.85);
        expect(graph.getEdge(edge.id)).toEqual(edge);
    });

    it('should find incoming and outgoing neighbors correctly', () => {
        graph.addNode({ id: 'a', type: 'concept', label: 'Node A' });
        graph.addNode({ id: 'b', type: 'concept', label: 'Node B' });
        graph.addNode({ id: 'c', type: 'concept', label: 'Node C' });

        graph.addEdge({ source: 'a', target: 'b', relation: 'causes' });
        graph.addEdge({ source: 'c', target: 'a', relation: 'supports' });

        const outNeighbors = graph.getNeighbors('a', 'out');
        expect(outNeighbors).toHaveLength(1);
        expect(outNeighbors[0].node.id).toBe('b');
        expect(outNeighbors[0].direction).toBe('outgoing');

        const inNeighbors = graph.getNeighbors('a', 'in');
        expect(inNeighbors).toHaveLength(1);
        expect(inNeighbors[0].node.id).toBe('c');
        expect(inNeighbors[0].direction).toBe('incoming');

        const both = graph.getNeighbors('a', 'both');
        expect(both).toHaveLength(2);
    });

    it('should filter nodes by query criteria', () => {
        graph.addNode({ id: 'n1', type: 'finding', label: 'Memory leak detected in heap', confidence: 0.9 });
        graph.addNode({ id: 'n2', type: 'hypothesis', label: 'Memory leak due to cache retention', confidence: 0.6 });
        graph.addNode({ id: 'n3', type: 'finding', label: 'High CPU under load', confidence: 0.4 });

        const findings = graph.queryNodes({ type: 'finding' });
        expect(findings).toHaveLength(2);

        const highConfFindings = graph.queryNodes({ type: 'finding', minConfidence: 0.8 });
        expect(highConfFindings).toHaveLength(1);
        expect(highConfFindings[0].id).toBe('n1');

        const leakNodes = graph.queryNodes({ labelContains: 'leak' });
        expect(leakNodes).toHaveLength(2);
    });

    it('should extract subgraphs around seed nodes to given depth', () => {
        graph.addNode({ id: 'core', type: 'entity', label: 'Core' });
        graph.addNode({ id: 'hop1', type: 'entity', label: 'Hop 1' });
        graph.addNode({ id: 'hop2', type: 'entity', label: 'Hop 2' });
        graph.addNode({ id: 'unrelated', type: 'entity', label: 'Unrelated' });

        graph.addEdge({ source: 'core', target: 'hop1', relation: 'relates_to' });
        graph.addEdge({ source: 'hop1', target: 'hop2', relation: 'relates_to' });

        const subDepth1 = graph.extractSubgraph(['core'], 1);
        expect(subDepth1.nodes.map(n => n.id).sort()).toEqual(['core', 'hop1']);
        expect(subDepth1.edges).toHaveLength(1);

        const subDepth2 = graph.extractSubgraph(['core'], 2);
        expect(subDepth2.nodes.map(n => n.id).sort()).toEqual(['core', 'hop1', 'hop2']);
        expect(subDepth2.edges).toHaveLength(2);
    });

    it('should track changelog deltas and deliver events to subscribers', () => {
        const deltasReceived: any[] = [];
        const unsubscribe = graph.subscribe(delta => deltasReceived.push(delta));

        graph.addNode({ id: 'x', type: 'metric', label: 'P99 Latency' });
        graph.addNode({ id: 'y', type: 'anomalous_event', label: 'Latency Spike' });
        graph.addEdge({ source: 'y', target: 'x', relation: 'causes' });

        expect(deltasReceived).toHaveLength(3);
        expect(deltasReceived[0].action).toBe('node_added');
        expect(deltasReceived[0].entityId).toBe('x');
        expect(deltasReceived[2].action).toBe('edge_added');

        const deltaSince1 = graph.getDeltasSince(1);
        expect(deltaSince1.deltas).toHaveLength(2);
        expect(deltaSince1.currentVersion).toBe(3);

        unsubscribe();
        graph.addNode({ id: 'z', type: 'concept', label: 'Decoupled Node' });
        expect(deltasReceived).toHaveLength(3); // No new events after unsubscribe
    });

    it('should generate statistics and clear state', () => {
        graph.addNode({ id: 'e1', type: 'entity', label: 'Entity 1' });
        graph.addNode({ id: 'h1', type: 'hypothesis', label: 'Hypothesis 1' });
        graph.addEdge({ source: 'e1', target: 'h1', relation: 'supports' });

        const stats = graph.getStats();
        expect(stats.totalNodes).toBe(2);
        expect(stats.totalEdges).toBe(1);
        expect(stats.nodeTypes.entity).toBe(1);
        expect(stats.nodeTypes.hypothesis).toBe(1);

        graph.clear();
        const clearedStats = graph.getStats();
        expect(clearedStats.totalNodes).toBe(0);
        expect(clearedStats.totalEdges).toBe(0);
        expect(clearedStats.version).toBe(0);
    });

    it('should expose singleton globalKnowledgeGraph', () => {
        expect(globalKnowledgeGraph).toBeInstanceOf(SharedKnowledgeGraph);
    });
});
