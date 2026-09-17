/**
 * Hierarchical Communication Layer for Swarm Multi-Agent Architectures.
 * Decouples inter-agent messaging from flat broadcasts, enforcing structured multi-tier
 * routing (Root -> Cluster Leads -> Specialists), in-flight deduplication,
 * semantic digest compression, and downward directive filtering.
 */

export type CommunicationLayer = 'root' | 'cluster-lead' | 'specialist';

export type MessageScope = 'local' | 'cluster' | 'upward' | 'targeted' | 'broadcast';

export interface ClusterNode {
    id: string;
    role: string;
    layer: CommunicationLayer;
    clusterId: string;
    parentClusterId?: string;
    domain?: string;
    metadata?: Record<string, any>;
}

export interface HierarchicalMessage<T = any> {
    id: string;
    senderId: string;
    senderRole: string;
    senderLayer: CommunicationLayer;
    clusterId: string;
    scope: MessageScope;
    recipientId?: string;
    payload: T;
    timestamp: number;
    metadata?: {
        bypassDedup?: boolean;
        targetDomains?: string[];
        [key: string]: any;
    };
}

export interface MessageDeliveryResult {
    messageId: string;
    deliveredCount: number;
    recipientIds: string[];
    dropped: boolean;
    suppressed?: boolean;
    dropReason?: string;
    latencyMs: number;
}

export interface ClusterDigest {
    clusterId: string;
    specialistCount: number;
    specialistRoles: string[];
    keyFindings: string[];
    anomalies: string[];
    summary: string;
    originalTokensEstimate: number;
    compressedTokensEstimate: number;
    tokenReductionRatio: number; // 0.0 to 1.0 (e.g. 0.65 = 65% token reduction)
}

export interface SpecialistReportInput {
    specialistRole?: string;
    insights?: string[];
    anomalies?: string[];
    summary?: string;
    [key: string]: any;
}

export interface HierarchicalBusConfig {
    dedupWindowMs?: number;         // Window to suppress identical payloads (default 5000ms)
    enableDeduplication?: boolean;  // Default true
    maxDedupCacheSize?: number;     // Maximum cached fingerprints (default 2000)
}

export interface MessageBusMetrics {
    totalSent: number;
    totalDelivered: number;
    totalDropped: number;
    duplicatesSuppressed: number;
    digestsGenerated: number;
    originalTokensProcessed: number;
    compressedTokensEmitted: number;
    overallCompressionRatio: number;
    downwardDirectivesFiltered: number;
    byScope: Record<MessageScope, number>;
    byCluster: Record<string, number>;
    byLayer: Record<CommunicationLayer, number>;
    activeNodesCount: number;
}

export type MessageListener<T = any> = (message: HierarchicalMessage<T>) => any;

/**
 * High-performance hierarchical message bus with sub-millisecond local dispatch,
 * in-flight deduplication, semantic digest compression, and downward domain filtering.
 */
export class HierarchicalMessageBus {
    private nodes: Map<string, ClusterNode> = new Map();
    private listeners: Map<string, Set<MessageListener>> = new Map();

    private dedupWindowMs: number;
    private enableDeduplication: boolean;
    private maxDedupCacheSize: number;
    private dedupCache: Map<string, number> = new Map();

    private totalSentCount: number = 0;
    private totalDeliveredCount: number = 0;
    private totalDroppedCount: number = 0;
    private duplicatesSuppressedCount: number = 0;
    private digestsGeneratedCount: number = 0;
    private originalTokensCount: number = 0;
    private compressedTokensCount: number = 0;
    private downwardDirectivesFilteredCount: number = 0;

    private scopeCounts: Record<MessageScope, number> = {
        local: 0,
        cluster: 0,
        upward: 0,
        targeted: 0,
        broadcast: 0
    };
    private clusterCounts: Map<string, number> = new Map();
    private layerCounts: Record<CommunicationLayer, number> = {
        root: 0,
        'cluster-lead': 0,
        specialist: 0
    };

    constructor(config?: HierarchicalBusConfig) {
        this.dedupWindowMs = config?.dedupWindowMs ?? 5000;
        this.enableDeduplication = config?.enableDeduplication ?? true;
        this.maxDedupCacheSize = config?.maxDedupCacheSize ?? 2000;
    }

    /**
     * Registers a cluster node into the communication topology.
     */
    registerNode(node: ClusterNode): void {
        this.nodes.set(node.id, { ...node });
        if (!this.listeners.has(node.id)) {
            this.listeners.set(node.id, new Set());
        }
    }

    /**
     * Unregisters a cluster node and cleans up listeners.
     */
    unregisterNode(nodeId: string): boolean {
        this.listeners.delete(nodeId);
        return this.nodes.delete(nodeId);
    }

    /**
     * Retrieves a registered node by ID.
     */
    getNode(nodeId: string): ClusterNode | undefined {
        return this.nodes.get(nodeId);
    }

    /**
     * Retrieves all nodes belonging to a cluster.
     */
    getClusterNodes(clusterId: string): ClusterNode[] {
        const result: ClusterNode[] = [];
        for (const node of this.nodes.values()) {
            if (node.clusterId === clusterId) {
                result.push(node);
            }
        }
        return result;
    }

    /**
     * Retrieves the designated Cluster Lead for a given cluster.
     */
    getClusterLead(clusterId: string): ClusterNode | undefined {
        for (const node of this.nodes.values()) {
            if (node.clusterId === clusterId && node.layer === 'cluster-lead') {
                return node;
            }
        }
        return undefined;
    }

    /**
     * Retrieves the Root Manager node.
     */
    getRootNode(): ClusterNode | undefined {
        for (const node of this.nodes.values()) {
            if (node.layer === 'root') {
                return node;
            }
        }
        return undefined;
    }

    /**
     * Subscribes a listener to messages routed to a specific node ID.
     */
    subscribe<T = any>(nodeId: string, listener: MessageListener<T>): () => void {
        let set = this.listeners.get(nodeId);
        if (!set) {
            set = new Set();
            this.listeners.set(nodeId, set);
        }
        set.add(listener as MessageListener);

        return () => {
            set?.delete(listener as MessageListener);
        };
    }

    /**
     * Generates a normalized payload fingerprint for in-flight deduplication.
     */
    private computePayloadFingerprint(msg: HierarchicalMessage): string {
        const raw = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
        const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase();
        return `${msg.clusterId}:${msg.scope}:${normalized}`;
    }

    /**
     * Cleans expired entries from the deduplication cache.
     */
    private pruneDedupCache(now: number): void {
        if (this.dedupCache.size === 0) return;
        const cutoff = now - this.dedupWindowMs;
        for (const [key, ts] of this.dedupCache.entries()) {
            if (ts < cutoff) {
                this.dedupCache.delete(key);
            }
        }
        if (this.dedupCache.size > this.maxDedupCacheSize) {
            // Evict oldest entries
            const sorted = Array.from(this.dedupCache.entries()).sort((a, b) => a[1] - b[1]);
            const toRemove = sorted.slice(0, Math.floor(this.maxDedupCacheSize / 2));
            for (const [k] of toRemove) {
                this.dedupCache.delete(k);
            }
        }
    }

    /**
     * Dispatches a message according to its defined hierarchical scope,
     * applying in-flight deduplication and downward domain filtering.
     */
    async dispatch<T = any>(
        msg: Omit<HierarchicalMessage<T>, 'id' | 'timestamp'> & { id?: string; timestamp?: number }
    ): Promise<MessageDeliveryResult> {
        const startTime = Date.now();
        const messageId = msg.id || `msg-${Math.random().toString(36).substring(2, 10)}`;
        const timestamp = msg.timestamp || startTime;

        const fullMessage: HierarchicalMessage<T> = {
            ...msg,
            id: messageId,
            timestamp
        };

        this.totalSentCount++;
        this.scopeCounts[fullMessage.scope] = (this.scopeCounts[fullMessage.scope] || 0) + 1;
        this.clusterCounts.set(fullMessage.clusterId, (this.clusterCounts.get(fullMessage.clusterId) || 0) + 1);
        this.layerCounts[fullMessage.senderLayer] = (this.layerCounts[fullMessage.senderLayer] || 0) + 1;

        // In-flight deduplication check
        if (this.enableDeduplication && !fullMessage.metadata?.bypassDedup) {
            this.pruneDedupCache(timestamp);
            const fingerprint = this.computePayloadFingerprint(fullMessage);
            const lastSeen = this.dedupCache.get(fingerprint);

            if (lastSeen !== undefined && (timestamp - lastSeen) <= this.dedupWindowMs) {
                this.duplicatesSuppressedCount++;
                return {
                    messageId,
                    deliveredCount: 0,
                    recipientIds: [],
                    dropped: false,
                    suppressed: true,
                    dropReason: 'Duplicate message suppressed within deduplication window',
                    latencyMs: Date.now() - startTime
                };
            }

            this.dedupCache.set(fingerprint, timestamp);
        }

        // Resolve recipients based on message scope and downward filters
        const targetRecipientIds = this.resolveRecipients(fullMessage);

        if (targetRecipientIds.length === 0) {
            this.totalDroppedCount++;
            return {
                messageId,
                deliveredCount: 0,
                recipientIds: [],
                dropped: true,
                dropReason: `No valid recipients resolved for scope '${fullMessage.scope}' from sender '${fullMessage.senderId}'`,
                latencyMs: Date.now() - startTime
            };
        }

        const deliveryPromises: Promise<void>[] = [];
        const deliveredIds: string[] = [];

        for (const recipientId of targetRecipientIds) {
            const recipientListeners = this.listeners.get(recipientId);
            if (recipientListeners && recipientListeners.size > 0) {
                deliveredIds.push(recipientId);
                for (const listener of recipientListeners) {
                    try {
                        const res = listener(fullMessage);
                        if (res instanceof Promise) {
                            deliveryPromises.push(res);
                        }
                    } catch (err) {
                        console.error(`[HierarchicalMessageBus] Error in listener on node '${recipientId}':`, err);
                    }
                }
            } else if (this.nodes.has(recipientId)) {
                // Node exists in topology but has no active listeners currently registered
                deliveredIds.push(recipientId);
            }
        }

        if (deliveryPromises.length > 0) {
            await Promise.allSettled(deliveryPromises);
        }

        this.totalDeliveredCount += deliveredIds.length;

        return {
            messageId,
            deliveredCount: deliveredIds.length,
            recipientIds: deliveredIds,
            dropped: deliveredIds.length === 0,
            dropReason: deliveredIds.length === 0 ? 'Recipients unreachable or unregistered' : undefined,
            latencyMs: Date.now() - startTime
        };
    }

    /**
     * Resolves recipient node IDs based on scoped routing rules and downward domain filters.
     */
    private resolveRecipients(msg: HierarchicalMessage): string[] {
        switch (msg.scope) {
            case 'local':
                return this.nodes.has(msg.senderId) ? [msg.senderId] : [];

            case 'cluster':
                // Deliver to all other nodes in the same cluster pod
                return Array.from(this.nodes.values())
                    .filter(n => n.clusterId === msg.clusterId && n.id !== msg.senderId)
                    .map(n => n.id);

            case 'upward': {
                // Upward cascade:
                // Specialist -> Cluster Lead
                // Cluster Lead -> Root Manager (or parent cluster lead)
                // Root -> Dropped (root has no upward parent)
                if (msg.senderLayer === 'specialist') {
                    const lead = this.getClusterLead(msg.clusterId);
                    if (lead && lead.id !== msg.senderId) {
                        return [lead.id];
                    }
                    // Fallback to root if cluster has no lead
                    const root = this.getRootNode();
                    if (root && root.id !== msg.senderId) {
                        return [root.id];
                    }
                    return [];
                }

                if (msg.senderLayer === 'cluster-lead') {
                    const senderNode = this.nodes.get(msg.senderId);
                    if (senderNode?.parentClusterId) {
                        const parentLead = this.getClusterLead(senderNode.parentClusterId);
                        if (parentLead) return [parentLead.id];
                    }
                    const root = this.getRootNode();
                    if (root && root.id !== msg.senderId) {
                        return [root.id];
                    }
                    return [];
                }

                // Root cannot send upward
                return [];
            }

            case 'targeted':
                if (msg.recipientId && this.nodes.has(msg.recipientId)) {
                    return [msg.recipientId];
                }
                return [];

            case 'broadcast': {
                // Downward directive filtering if targetDomains specified
                const targetDomains = msg.metadata?.targetDomains;
                const candidateNodes = Array.from(this.nodes.values()).filter(n => n.id !== msg.senderId);

                if (targetDomains && Array.isArray(targetDomains) && targetDomains.length > 0) {
                    const normalizedTargets = targetDomains.map(d => d.toLowerCase().trim());
                    const matchedNodes: string[] = [];

                    for (const node of candidateNodes) {
                        const clusterLower = (node.clusterId || '').toLowerCase();
                        const domainLower = (node.domain || '').toLowerCase();
                        const matches = normalizedTargets.some(t => clusterLower.includes(t) || domainLower.includes(t));

                        if (matches) {
                            matchedNodes.push(node.id);
                        } else {
                            this.downwardDirectivesFilteredCount++;
                        }
                    }
                    return matchedNodes;
                }

                return candidateNodes.map(n => n.id);
            }

            default:
                return [];
        }
    }

    /**
     * Aggregates multiple specialist reports within a cluster into a unified,
     * deduplicated ClusterDigest, stripping redundancy and calculating token reduction.
     */
    aggregateClusterReports(clusterId: string, reports: SpecialistReportInput[]): ClusterDigest {
        if (!reports || reports.length === 0) {
            return {
                clusterId,
                specialistCount: 0,
                specialistRoles: [],
                keyFindings: [],
                anomalies: [],
                summary: 'No reports submitted for cluster',
                originalTokensEstimate: 0,
                compressedTokensEstimate: 0,
                tokenReductionRatio: 0.0
            };
        }

        const specialistRoles = Array.from(new Set(reports.map(r => r.specialistRole).filter(Boolean))) as string[];
        const seenFindingNorms = new Set<string>();
        const seenAnomalyNorms = new Set<string>();
        const keyFindings: string[] = [];
        const anomalies: string[] = [];
        const summaries: string[] = [];

        let originalLength = 0;

        for (const rep of reports) {
            originalLength += JSON.stringify(rep).length;

            if (rep.summary && typeof rep.summary === 'string' && rep.summary.trim()) {
                summaries.push(rep.summary.trim());
            }

            if (Array.isArray(rep.insights)) {
                for (const ins of rep.insights) {
                    if (typeof ins === 'string' && ins.trim()) {
                        const norm = ins.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim().toLowerCase();
                        if (!seenFindingNorms.has(norm)) {
                            seenFindingNorms.add(norm);
                            keyFindings.push(ins.trim());
                        }
                    }
                }
            }

            if (Array.isArray(rep.anomalies)) {
                for (const anom of rep.anomalies) {
                    if (typeof anom === 'string' && anom.trim()) {
                        const norm = anom.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim().toLowerCase();
                        if (!seenAnomalyNorms.has(norm)) {
                            seenAnomalyNorms.add(norm);
                            anomalies.push(anom.trim());
                        }
                    }
                }
            }
        }

        const combinedSummary = summaries.length > 0 ? summaries.join(' | ') : 'Cluster findings consolidated';

        const digestPayload = {
            clusterId,
            specialistRoles,
            keyFindings,
            anomalies,
            summary: combinedSummary
        };

        const compressedLength = JSON.stringify(digestPayload).length;
        const originalTokens = Math.max(10, Math.ceil(originalLength / 4));
        const compressedTokens = Math.max(5, Math.ceil(compressedLength / 4));
        const tokenReductionRatio = Math.min(1.0, Math.max(0.0, Math.round((1 - (compressedTokens / originalTokens)) * 1000) / 1000));

        this.digestsGeneratedCount++;
        this.originalTokensCount += originalTokens;
        this.compressedTokensCount += compressedTokens;

        return {
            clusterId,
            specialistCount: reports.length,
            specialistRoles,
            keyFindings,
            anomalies,
            summary: combinedSummary,
            originalTokensEstimate: originalTokens,
            compressedTokensEstimate: compressedTokens,
            tokenReductionRatio
        };
    }

    /**
     * Returns real-time aggregate bus metrics including deduplication,
     * token compression, and downward filtering.
     */
    getMetrics(): MessageBusMetrics {
        const clusterMetrics: Record<string, number> = {};
        for (const [k, v] of this.clusterCounts.entries()) {
            clusterMetrics[k] = v;
        }

        const overallRatio = this.originalTokensCount > 0
            ? Math.min(1.0, Math.max(0.0, Math.round((1 - (this.compressedTokensCount / this.originalTokensCount)) * 1000) / 1000))
            : 0.0;

        return {
            totalSent: this.totalSentCount,
            totalDelivered: this.totalDeliveredCount,
            totalDropped: this.totalDroppedCount,
            duplicatesSuppressed: this.duplicatesSuppressedCount,
            digestsGenerated: this.digestsGeneratedCount,
            originalTokensProcessed: this.originalTokensCount,
            compressedTokensEmitted: this.compressedTokensCount,
            overallCompressionRatio: overallRatio,
            downwardDirectivesFiltered: this.downwardDirectivesFilteredCount,
            byScope: { ...this.scopeCounts },
            byCluster: clusterMetrics,
            byLayer: { ...this.layerCounts },
            activeNodesCount: this.nodes.size
        };
    }

    /**
     * Resets all nodes, listeners, dedup caches, and metrics.
     */
    reset(): void {
        this.nodes.clear();
        this.listeners.clear();
        this.dedupCache.clear();
        this.totalSentCount = 0;
        this.totalDeliveredCount = 0;
        this.totalDroppedCount = 0;
        this.duplicatesSuppressedCount = 0;
        this.digestsGeneratedCount = 0;
        this.originalTokensCount = 0;
        this.compressedTokensCount = 0;
        this.downwardDirectivesFilteredCount = 0;
        this.scopeCounts = {
            local: 0,
            cluster: 0,
            upward: 0,
            targeted: 0,
            broadcast: 0
        };
        this.clusterCounts.clear();
        this.layerCounts = {
            root: 0,
            'cluster-lead': 0,
            specialist: 0
        };
    }
}

export const globalHierarchicalMessageBus = new HierarchicalMessageBus();
