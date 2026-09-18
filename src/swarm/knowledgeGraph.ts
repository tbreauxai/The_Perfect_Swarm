/**
 * @file knowledgeGraph.ts
 * @description Shared versioned knowledge graph with entity-relationship modeling, Lamport version clocks,
 * delta changelog tracking, and fast subgraph queries.
 */

export type KnowledgeNodeType = 'entity' | 'concept' | 'finding' | 'hypothesis' | 'metric' | 'anomalous_event';

export type KnowledgeEdgeRelation =
    | 'causes'
    | 'correlates_with'
    | 'supports'
    | 'refutes'
    | 'subtask_of'
    | 'depends_on'
    | 'relates_to';

export interface KnowledgeGraphNode {
    id: string;
    type: KnowledgeNodeType;
    label: string;
    properties: Record<string, any>;
    confidence: number; // 0.0 - 1.0
    version: number;
    createdAt: number;
    updatedAt: number;
}

export interface KnowledgeGraphEdge {
    id: string;
    source: string;
    target: string;
    relation: KnowledgeEdgeRelation;
    weight: number; // 0.0 - 1.0
    version: number;
    properties?: Record<string, any>;
}

export interface GraphDelta {
    action: 'node_added' | 'node_updated' | 'node_removed' | 'edge_added' | 'edge_removed';
    entityId: string;
    version: number;
    timestamp: number;
    data?: any;
}

/**
 * High-performance, zero-dependency versioned knowledge graph.
 */
export class SharedKnowledgeGraph {
    private static instance: SharedKnowledgeGraph;

    private nodes: Map<string, KnowledgeGraphNode> = new Map();
    private edges: Map<string, KnowledgeGraphEdge> = new Map();
    private outgoing: Map<string, Set<string>> = new Map(); // sourceId -> edgeIds
    private incoming: Map<string, Set<string>> = new Map(); // targetId -> edgeIds

    private versionClock: number = 0;
    private changelog: GraphDelta[] = [];
    private listeners: Array<(delta: GraphDelta) => void> = [];

    public static getInstance(): SharedKnowledgeGraph {
        if (!SharedKnowledgeGraph.instance) {
            SharedKnowledgeGraph.instance = new SharedKnowledgeGraph();
        }
        return SharedKnowledgeGraph.instance;
    }

    public getVersion(): number {
        return this.versionClock;
    }

    public addNode(nodeInput: {
        id: string;
        type: KnowledgeNodeType;
        label: string;
        properties?: Record<string, any>;
        confidence?: number;
    }): KnowledgeGraphNode {
        this.versionClock++;
        const now = Date.now();

        const node: KnowledgeGraphNode = {
            id: nodeInput.id,
            type: nodeInput.type,
            label: nodeInput.label,
            properties: nodeInput.properties || {},
            confidence: Math.max(0, Math.min(1, nodeInput.confidence ?? 1.0)),
            version: this.versionClock,
            createdAt: now,
            updatedAt: now
        };

        this.nodes.set(node.id, node);
        if (!this.outgoing.has(node.id)) this.outgoing.set(node.id, new Set());
        if (!this.incoming.has(node.id)) this.incoming.set(node.id, new Set());

        this.recordDelta({
            action: 'node_added',
            entityId: node.id,
            version: this.versionClock,
            timestamp: now,
            data: node
        });

        return node;
    }

    public updateNode(id: string, updates: {
        label?: string;
        properties?: Record<string, any>;
        confidence?: number;
    }): KnowledgeGraphNode | undefined {
        const node = this.nodes.get(id);
        if (!node) return undefined;

        this.versionClock++;
        const now = Date.now();

        if (updates.label !== undefined) node.label = updates.label;
        if (updates.confidence !== undefined) {
            node.confidence = Math.max(0, Math.min(1, updates.confidence));
        }
        if (updates.properties) {
            node.properties = { ...node.properties, ...updates.properties };
        }
        node.version = this.versionClock;
        node.updatedAt = now;

        this.recordDelta({
            action: 'node_updated',
            entityId: node.id,
            version: this.versionClock,
            timestamp: now,
            data: node
        });

        return node;
    }

    public addEdge(edgeInput: {
        id?: string;
        source: string;
        target: string;
        relation: KnowledgeEdgeRelation;
        weight?: number;
        properties?: Record<string, any>;
    }): KnowledgeGraphEdge {
        if (!this.nodes.has(edgeInput.source)) {
            throw new Error(`Edge source node does not exist: ${edgeInput.source}`);
        }
        if (!this.nodes.has(edgeInput.target)) {
            throw new Error(`Edge target node does not exist: ${edgeInput.target}`);
        }

        this.versionClock++;
        const edgeId = edgeInput.id || `edge-${edgeInput.source}-${edgeInput.relation}-${edgeInput.target}`;
        const edge: KnowledgeGraphEdge = {
            id: edgeId,
            source: edgeInput.source,
            target: edgeInput.target,
            relation: edgeInput.relation,
            weight: Math.max(0, Math.min(1, edgeInput.weight ?? 1.0)),
            version: this.versionClock,
            properties: edgeInput.properties
        };

        this.edges.set(edge.id, edge);
        this.outgoing.get(edge.source)!.add(edge.id);
        this.incoming.get(edge.target)!.add(edge.id);

        this.recordDelta({
            action: 'edge_added',
            entityId: edge.id,
            version: this.versionClock,
            timestamp: Date.now(),
            data: edge
        });

        return edge;
    }

    public getNode(id: string): KnowledgeGraphNode | undefined {
        return this.nodes.get(id);
    }

    public getEdge(id: string): KnowledgeGraphEdge | undefined {
        return this.edges.get(id);
    }

    public getNeighbors(nodeId: string, direction: 'in' | 'out' | 'both' = 'both'): Array<{
        node: KnowledgeGraphNode;
        edge: KnowledgeGraphEdge;
        direction: 'incoming' | 'outgoing';
    }> {
        const results: Array<{ node: KnowledgeGraphNode; edge: KnowledgeGraphEdge; direction: 'incoming' | 'outgoing' }> = [];

        if (direction === 'out' || direction === 'both') {
            const outEdges = this.outgoing.get(nodeId) || new Set();
            for (const edgeId of outEdges) {
                const edge = this.edges.get(edgeId);
                if (edge) {
                    const targetNode = this.nodes.get(edge.target);
                    if (targetNode) {
                        results.push({ node: targetNode, edge, direction: 'outgoing' });
                    }
                }
            }
        }

        if (direction === 'in' || direction === 'both') {
            const inEdges = this.incoming.get(nodeId) || new Set();
            for (const edgeId of inEdges) {
                const edge = this.edges.get(edgeId);
                if (edge) {
                    const srcNode = this.nodes.get(edge.source);
                    if (srcNode) {
                        results.push({ node: srcNode, edge, direction: 'incoming' });
                    }
                }
            }
        }

        return results;
    }

    public queryNodes(filter: {
        type?: KnowledgeNodeType;
        minConfidence?: number;
        labelContains?: string;
    }): KnowledgeGraphNode[] {
        let list = Array.from(this.nodes.values());

        if (filter.type) {
            list = list.filter(n => n.type === filter.type);
        }
        if (filter.minConfidence !== undefined) {
            list = list.filter(n => n.confidence >= filter.minConfidence!);
        }
        if (filter.labelContains) {
            const needle = filter.labelContains.toLowerCase();
            list = list.filter(n => n.label.toLowerCase().includes(needle));
        }

        return list;
    }

    public extractSubgraph(seedNodeIds: string[], depth: number = 1): {
        nodes: KnowledgeGraphNode[];
        edges: KnowledgeGraphEdge[];
    } {
        const visitedNodes = new Set<string>();
        const visitedEdges = new Set<string>();
        let currentLevel = new Set<string>(seedNodeIds);

        for (const id of seedNodeIds) {
            if (this.nodes.has(id)) visitedNodes.add(id);
        }

        for (let d = 0; d < depth; d++) {
            const nextLevel = new Set<string>();
            for (const nodeId of currentLevel) {
                const neighbors = this.getNeighbors(nodeId, 'both');
                for (const { node, edge } of neighbors) {
                    visitedEdges.add(edge.id);
                    if (!visitedNodes.has(node.id)) {
                        visitedNodes.add(node.id);
                        nextLevel.add(node.id);
                    }
                }
            }
            currentLevel = nextLevel;
        }

        const nodes = Array.from(visitedNodes).map(id => this.nodes.get(id)!).filter(Boolean);
        const edges = Array.from(visitedEdges).map(id => this.edges.get(id)!).filter(Boolean);

        return { nodes, edges };
    }

    public getDeltasSince(sinceVersion: number): {
        deltas: GraphDelta[];
        currentVersion: number;
    } {
        const deltas = this.changelog.filter(d => d.version > sinceVersion);
        return {
            deltas,
            currentVersion: this.versionClock
        };
    }

    public subscribe(listener: (delta: GraphDelta) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    private recordDelta(delta: GraphDelta): void {
        this.changelog.push(delta);
        if (this.changelog.length > 500) {
            this.changelog.shift();
        }
        for (const listener of this.listeners) {
            try {
                listener(delta);
            } catch (err) {
                console.warn('[KnowledgeGraph] Listener error:', err);
            }
        }
    }

    public clear(): void {
        this.nodes.clear();
        this.edges.clear();
        this.outgoing.clear();
        this.incoming.clear();
        this.changelog = [];
        this.versionClock = 0;
    }

    public getStats(): {
        totalNodes: number;
        totalEdges: number;
        version: number;
        nodeTypes: Record<string, number>;
    } {
        const nodeTypes: Record<string, number> = {};
        for (const node of this.nodes.values()) {
            nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
        }
        return {
            totalNodes: this.nodes.size,
            totalEdges: this.edges.size,
            version: this.versionClock,
            nodeTypes
        };
    }
}

export const globalKnowledgeGraph = SharedKnowledgeGraph.getInstance();
