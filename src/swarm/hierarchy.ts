/**
 * Hierarchical Agent Specialization & Dynamic Complexity Routing
 * 
 * Organizes swarm specialists into multi-tier directed capability trees:
 * Tier 0: Root Coordinator (Manager Node)
 * Tier 1: Domain Cluster Leads / Lead Architects
 * Tier 2: Specialized Deep Analysts
 * Tier 3: Leaf Micro-Agents / Deterministic Tool Operators
 * 
 * Provides domain ontology matching, complexity-aware task routing,
 * downward delegation, and upward anomaly escalation protocols.
 * Pure TypeScript, zero external runtime dependencies.
 */

import type { AgentConfig } from './types.ts';

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

/**
 * Built-in Domain Taxonomy classifying technical specializations.
 */
export const DOMAIN_TAXONOMY: Record<string, DomainTaxonomyNode> = {
    security: {
        domain: 'Security & Compliance',
        subDomains: ['auth', 'cryptography', 'vulnerability', 'auditing', 'zero_trust'],
        coreKeywords: [
            'security', 'auth', 'token', 'jwt', 'vulnerability', 'cve', 'exploit',
            'injection', 'permission', 'credential', 'firewall', 'breach', 'tls',
            'ssl', 'oauth', 'acl', 'encryption', 'crypt', 'sanitize', 'audit', 'xss'
        ]
    },
    performance: {
        domain: 'Performance & Resource Systems',
        subDomains: ['latency', 'throughput', 'profiling', 'memory', 'cpu'],
        coreKeywords: [
            'performance', 'latency', 'slow', 'bottleneck', 'cpu', 'memory', 'ram',
            'leak', 'io_wait', 'gc_pause', 'throughput', 'profile', 'benchmark',
            'concurrency', 'saturation', 'queue_depth', 'overhead', 'contention'
        ]
    },
    database: {
        domain: 'Data Storage & Persistence',
        subDomains: ['sql', 'nosql', 'indexing', 'transactions', 'sharding'],
        coreKeywords: [
            'database', 'sql', 'postgres', 'query', 'nosql', 'index', 'lock',
            'deadlock', 'transaction', 'table', 'schema', 'migration', 'sharding',
            'replication', 'connection_pool', 'replica_lag', 'acid', 'qdrant'
        ]
    },
    infrastructure: {
        domain: 'Cloud Infrastructure & SRE',
        subDomains: ['kubernetes', 'networking', 'containers', 'observability'],
        coreKeywords: [
            'infra', 'infrastructure', 'cloud', 'kubernetes', 'k8s', 'docker',
            'container', 'pod', 'cluster', 'node', 'host', 'network', 'dns',
            'load_balancer', 'ingress', 'failover', 'devops', 'sre', 'aws', 'gcp'
        ]
    },
    software_engineering: {
        domain: 'Software Architecture & Design',
        subDomains: ['design_patterns', 'refactoring', 'testing', 'syntax'],
        coreKeywords: [
            'architecture', 'design', 'refactor', 'typescript', 'pattern', 'pipeline',
            'api', 'service', 'module', 'interface', 'syntax', 'bug', 'exception',
            'stack_trace', 'nullpointer', 'typeerror', 'test', 'clean_code'
        ]
    },
    general: {
        domain: 'General Analysis',
        subDomains: ['summary', 'triage'],
        coreKeywords: ['general', 'overview', 'summary', 'status', 'report', 'check']
    }
};

/**
 * Classifies an agent role into an AgentTier based on naming and capability patterns.
 */
export function classifyAgentTier(role: string): { tier: AgentTier; tierRole: AgentTierRole } {
    const r = role.toLowerCase();

    if (r.includes('manager') || r.includes('coordinator') || r.includes('orchestrator') || r.includes('director')) {
        return { tier: 0, tierRole: 'root_coordinator' };
    }
    if (r.includes('lead') || r.includes('architect') || r.includes('principal') || r.includes('head')) {
        return { tier: 1, tierRole: 'cluster_lead' };
    }
    if (r.includes('tool') || r.includes('operator') || r.includes('calculator') || r.includes('extractor') || r.includes('validator')) {
        return { tier: 3, tierRole: 'leaf_operator' };
    }
    // Default analysts, specialists, engineers are Tier 2 deep specialists
    return { tier: 2, tierRole: 'deep_specialist' };
}

function matchesKeyword(text: string, kw: string): boolean {
    if (text.includes(kw)) return true;
    if (kw.endsWith('y') && text.includes(kw.slice(0, -1) + 'ies')) return true;
    if (text.includes(kw + 's') || text.includes(kw + 'es')) return true;
    return false;
}

/**
 * Evaluates semantic affinity and returns the best matching primary domain from taxonomy.
 */
export function identifyPrimaryDomain(text: string): { domainKey: string; domainName: string; score: number; matchedKeywords: string[] } {
    const lower = text.toLowerCase();
    let bestKey = 'general';
    let bestCount = 0;
    let bestKeywords: string[] = [];

    for (const [key, node] of Object.entries(DOMAIN_TAXONOMY)) {
        if (key === 'general') continue;
        const matched = node.coreKeywords.filter(kw => matchesKeyword(lower, kw));
        if (matched.length > bestCount) {
            bestCount = matched.length;
            bestKey = key;
            bestKeywords = matched;
        }
    }

    const score = Math.min(1.0, bestCount > 0 ? (bestCount * 0.15) + 0.25 : 0.2);
    return {
        domainKey: bestKey,
        domainName: DOMAIN_TAXONOMY[bestKey].domain,
        score,
        matchedKeywords: bestKeywords
    };
}

/**
 * Directed Multi-Tier Specialist Tree.
 * Maintains parent-child relationships and manages hierarchical team topology.
 */
export class HierarchicalSpecialistTree {
    private nodes: Map<string, SpecialistNode> = new Map();
    private rootId?: string;

    addNode(node: SpecialistNode): void {
        this.nodes.set(node.id, node);
        if (node.tier === 0 && !this.rootId) {
            this.rootId = node.id;
        }
    }

    getNode(id: string): SpecialistNode | undefined {
        return this.nodes.get(id);
    }

    getRoot(): SpecialistNode | undefined {
        return this.rootId ? this.nodes.get(this.rootId) : undefined;
    }

    getAllNodes(): SpecialistNode[] {
        return Array.from(this.nodes.values());
    }

    getChildren(nodeId: string): SpecialistNode[] {
        const node = this.nodes.get(nodeId);
        if (!node) return [];
        return node.childrenIds
            .map(cId => this.nodes.get(cId))
            .filter((n): n is SpecialistNode => !!n);
    }

    getParent(nodeId: string): SpecialistNode | undefined {
        const node = this.nodes.get(nodeId);
        if (!node || !node.parentId) return undefined;
        return this.nodes.get(node.parentId);
    }

    getTierNodes(tier: AgentTier): SpecialistNode[] {
        return Array.from(this.nodes.values()).filter(n => n.tier === tier);
    }

    getTreeDepth(): number {
        if (this.nodes.size === 0) return 0;
        let maxTier: AgentTier = 0;
        for (const n of this.nodes.values()) {
            if (n.tier > maxTier) maxTier = n.tier;
        }
        return maxTier + 1;
    }

    getMetrics(): HierarchyMetrics {
        const tierCounts: Record<AgentTier, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
        for (const n of this.nodes.values()) {
            tierCounts[n.tier] = (tierCounts[n.tier] || 0) + 1;
        }
        return {
            treeDepth: this.getTreeDepth(),
            totalNodes: this.nodes.size,
            tierCounts,
            delegationsCount: 0,
            escalationsCount: 0
        };
    }

    /**
     * Constructs a hierarchical specialization tree automatically from configured agents.
     */
    static buildFromAgents(agents: Array<AgentConfig | { id?: string; role: string; provider: string; model?: string }>, taskContext: string = ''): HierarchicalSpecialistTree {
        const tree = new HierarchicalSpecialistTree();

        // 1. Create SpecialistNode for each agent
        for (const a of agents) {
            const id = a.id || a.role;
            const { tier, tierRole } = classifyAgentTier(a.role);
            const domainInfo = identifyPrimaryDomain(`${a.role} ${taskContext}`);

            const node: SpecialistNode = {
                id,
                role: a.role,
                provider: a.provider,
                model: a.model,
                tier,
                tierRole,
                primaryDomain: domainInfo.domainKey,
                subDomains: DOMAIN_TAXONOMY[domainInfo.domainKey]?.subDomains || [],
                childrenIds: [],
                expertiseKeywords: domainInfo.matchedKeywords,
                maxConcurrentTasks: tier === 0 ? 10 : tier === 1 ? 5 : 2,
                activeTaskCount: 0
            };
            tree.addNode(node);
        }

        // 2. Resolve Root Coordinator
        let root = tree.getTierNodes(0)[0];
        if (!root && tree.getAllNodes().length > 0) {
            // Elect highest ranking agent or first agent as Root
            root = tree.getAllNodes()[0];
            root.tier = 0;
            root.tierRole = 'root_coordinator';
        }

        const tier1Leads = tree.getTierNodes(1);
        const tier2Specialists = tree.getTierNodes(2);
        const tier3Operators = tree.getTierNodes(3);

        // 3. Attach Tier 1 leads to Root
        if (root) {
            for (const lead of tier1Leads) {
                lead.parentId = root.id;
                if (!root.childrenIds.includes(lead.id)) {
                    root.childrenIds.push(lead.id);
                }
            }
        }

        // 4. Attach Tier 2 specialists to matching Tier 1 leads or directly to Root
        for (const spec of tier2Specialists) {
            const matchingLead = tier1Leads.find(l => l.primaryDomain === spec.primaryDomain);
            if (matchingLead) {
                spec.parentId = matchingLead.id;
                if (!matchingLead.childrenIds.includes(spec.id)) {
                    matchingLead.childrenIds.push(spec.id);
                }
            } else if (root) {
                spec.parentId = root.id;
                if (!root.childrenIds.includes(spec.id)) {
                    root.childrenIds.push(spec.id);
                }
            }
        }

        // 5. Attach Tier 3 leaf operators to matching Tier 2 specialists or Tier 1 leads
        for (const op of tier3Operators) {
            const matchingSpec = tier2Specialists.find(s => s.primaryDomain === op.primaryDomain)
                || tier1Leads.find(l => l.primaryDomain === op.primaryDomain)
                || root;
            if (matchingSpec) {
                op.parentId = matchingSpec.id;
                if (!matchingSpec.childrenIds.includes(op.id)) {
                    matchingSpec.childrenIds.push(op.id);
                }
            }
        }

        return tree;
    }
}

/**
 * Hierarchical Router.
 * Performs multi-factor complexity classification, domain expertise matching,
 * downward delegation, and upward escalation across specialist trees.
 */
export class HierarchicalRouter {
    private delegationHistory: DelegationRecord[] = [];
    private escalationHistory: EscalationRecord[] = [];

    /**
     * Determines task complexity based on length, structural markers, and technical keywords.
     */
    inferComplexity(task: string, dataPayload: string = ''): HierarchicalTaskComplexity {
        const fullText = `${task}\n${dataPayload}`.toLowerCase();
        const words = fullText.split(/\s+/).length;

        const hasCriticalMarkers = ['security breach', 'cve', 'data corruption', 'production down', 'critical outage', 'fatal panic'].some(m => fullText.includes(m));
        if (hasCriticalMarkers || words > 800) {
            return 'critical';
        }

        const hasComplexMarkers = ['architect', 'distributed', 'concurrency', 'cross-service', 'microservice', 'race condition', 'deadlock'].some(m => fullText.includes(m));
        if (hasComplexMarkers || words > 250) {
            return 'complex';
        }

        if (words > 60 || fullText.includes('audit') || fullText.includes('analyze') || fullText.includes('diagnose')) {
            return 'moderate';
        }

        return 'trivial';
    }

    /**
     * Calculates the multi-factor routing score for an agent candidate:
     * (DomainExpertise * 0.40) + (ComplexityFitness * 0.30) + (HistoricalRL * 0.20) + (CapacityHeadroom * 0.10)
     */
    calculateRoutingScore(
        node: SpecialistNode,
        complexity: HierarchicalTaskComplexity,
        taskDomainKey: string,
        historicalRlScore: number = 0.85
    ): number {
        // 1. Domain Expertise (0.0 to 1.0)
        let domainScore = 0.2;
        if (node.primaryDomain === taskDomainKey) {
            domainScore = 1.0;
        } else if (node.subDomains.some(sd => sd === taskDomainKey)) {
            domainScore = 0.7;
        } else if (node.primaryDomain === 'general') {
            domainScore = 0.4;
        }

        // 2. Complexity Fitness (0.0 to 1.0)
        let complexityScore = 0.5;
        if (complexity === 'trivial') {
            complexityScore = node.tier === 3 ? 1.0 : node.tier === 2 ? 0.8 : 0.4;
        } else if (complexity === 'moderate') {
            complexityScore = node.tier === 2 ? 1.0 : node.tier === 1 ? 0.9 : 0.6;
        } else if (complexity === 'complex') {
            complexityScore = node.tier === 1 ? 1.0 : node.tier === 2 ? 0.85 : 0.5;
        } else if (complexity === 'critical') {
            complexityScore = node.tier === 1 ? 1.0 : node.tier === 0 ? 0.95 : 0.7;
        }

        // 3. Historical RL Score (normalized 0.0 to 1.0)
        const rlScore = Math.min(1.0, Math.max(0.1, historicalRlScore));

        // 4. Capacity Headroom (0.0 to 1.0)
        const headroom = Math.max(0, node.maxConcurrentTasks - node.activeTaskCount);
        const capacityScore = node.maxConcurrentTasks > 0 ? headroom / node.maxConcurrentTasks : 0.5;

        // Weighted Combination
        return Math.round(((domainScore * 0.40) + (complexityScore * 0.30) + (rlScore * 0.20) + (capacityScore * 0.10)) * 1000) / 1000;
    }

    /**
     * Dynamically routes a task or chunk through the specialist hierarchy.
     */
    routeHierarchical(
        task: string,
        chunk: string,
        chunkIndex: number,
        tree: HierarchicalSpecialistTree,
        rlScoreGetter?: (role: string) => number
    ): HierarchicalRouteDecision {
        const complexity = this.inferComplexity(task, chunk);
        const domainInfo = identifyPrimaryDomain(`${task}\n${chunk}`);
        const allNodes = tree.getAllNodes();

        if (allNodes.length === 0) {
            throw new Error('HierarchicalSpecialistTree contains no specialist nodes');
        }

        // Score all available nodes
        const scoredNodes = allNodes.map(node => {
            const rlScore = rlScoreGetter ? rlScoreGetter(node.role) : 0.85;
            const score = this.calculateRoutingScore(node, complexity, domainInfo.domainKey, rlScore);
            return { node, score };
        });

        scoredNodes.sort((a, b) => b.score - a.score);
        const best = scoredNodes[0];
        const chosen = best.node;

        // Build delegation chain from Root down to chosen target
        const delegationChain: string[] = [];
        let curr: SpecialistNode | undefined = chosen;
        while (curr) {
            delegationChain.unshift(curr.role);
            curr = tree.getParent(curr.id);
        }

        let reason = `Hierarchical match for '${domainInfo.domainName}' (Complexity: ${complexity}, Score: ${best.score})`;
        if (delegationChain.length > 1) {
            reason += ` via Delegation: ${delegationChain.join(' -> ')}`;
        }

        // Record delegation if delegated downward from a parent
        if (chosen.parentId) {
            this.delegationHistory.push({
                taskId: `task-chunk-${chunkIndex}`,
                fromNodeId: chosen.parentId,
                toNodeId: chosen.id,
                subtask: task,
                timestamp: Date.now()
            });
        }

        return {
            targetNodeId: chosen.id,
            targetRole: chosen.role,
            targetTier: chosen.tier,
            tierRole: chosen.tierRole,
            provider: chosen.provider,
            complexity,
            primaryDomain: domainInfo.domainKey,
            routingScore: best.score,
            delegationChain,
            reason
        };
    }

    /**
     * Upward escalation: Triggered when a specialist detects critical anomalies or uncertainty,
     * routing the issue back up to its cluster lead or root coordinator.
     */
    escalate(
        taskId: string,
        fromNodeId: string,
        tree: HierarchicalSpecialistTree,
        anomalyCount: number,
        reason: string
    ): EscalationRecord {
        const fromNode = tree.getNode(fromNodeId);
        const targetParent = fromNode ? tree.getParent(fromNodeId) : tree.getRoot();
        const toNodeId = targetParent ? targetParent.id : 'root';

        const record: EscalationRecord = {
            taskId,
            fromNodeId,
            toNodeId,
            anomalyCount,
            reason,
            timestamp: Date.now()
        };

        this.escalationHistory.push(record);
        return record;
    }

    getDelegationHistory(): DelegationRecord[] {
        return [...this.delegationHistory];
    }

    getEscalationHistory(): EscalationRecord[] {
        return [...this.escalationHistory];
    }

    reset(): void {
        this.delegationHistory = [];
        this.escalationHistory = [];
    }
}

export const globalHierarchicalRouter = new HierarchicalRouter();
