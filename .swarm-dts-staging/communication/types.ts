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

export interface SpecialistNodeInput {
    id: string;
    role: string;
    provider?: string;
    model?: string;
    domain?: string;
}

export interface DiscoverTopologyParams {
    specialists: SpecialistNodeInput[];
    task?: string;
    rootNodeId?: string;
    minPodSize?: number;
    maxPodSize?: number;
    capabilityScorer?: (role: string) => number;
    capacityHeadroomGetter?: (nodeKey: string) => number;
}

export interface ClusterPodDefinition {
    clusterId: string;
    domain: string;
    leadNodeId: string;
    leadRole: string;
    memberNodeIds: string[];
    memberRoles: string[];
    electionReason: string;
}

export interface SwarmTopology {
    pods: Record<string, ClusterPodDefinition>;
    nodeClusterMap: Record<string, string>;
    leadNodeIds: string[];
    rootNodeId: string;
    totalSpecialists: number;
    totalPods: number;
}
