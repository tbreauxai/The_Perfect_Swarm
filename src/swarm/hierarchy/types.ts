export type AgentTier = 0 | 1 | 2 | 3;

export type AgentTierRole =
    | 'root_coordinator'
    | 'cluster_lead'
    | 'deep_specialist'
    | 'leaf_operator';

export type HierarchicalTaskComplexity = 'trivial' | 'moderate' | 'complex' | 'critical';

export interface DomainTaxonomyNode {
    domain: string;
    parentDomain?: string;
    subDomains: string[];
    coreKeywords: string[];
}

export interface SpecialistNode {
    id: string;
    role: string;
    provider: string;
    model?: string;
    tier: AgentTier;
    tierRole: AgentTierRole;
    primaryDomain: string;
    subDomains: string[];
    parentId?: string;
    childrenIds: string[];
    expertiseKeywords: string[];
    maxConcurrentTasks: number;
    activeTaskCount: number;
}

export interface HierarchicalRouteDecision {
    targetNodeId: string;
    targetRole: string;
    targetTier: AgentTier;
    tierRole: AgentTierRole;
    provider: string;
    complexity: HierarchicalTaskComplexity;
    primaryDomain: string;
    routingScore: number;
    delegationChain: string[];
    isEscalated?: boolean;
    escalatedFrom?: string;
    reason: string;
}

export interface DelegationRecord {
    taskId: string;
    fromNodeId: string;
    toNodeId: string;
    subtask: string;
    timestamp: number;
}

export interface EscalationRecord {
    taskId: string;
    fromNodeId: string;
    toNodeId: string;
    anomalyCount: number;
    reason: string;
    timestamp: number;
}

export interface HierarchyMetrics {
    treeDepth: number;
    totalNodes: number;
    tierCounts: Record<AgentTier, number>;
    delegationsCount: number;
    escalationsCount: number;
}
