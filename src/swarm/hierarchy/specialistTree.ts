import type { AgentConfig } from '../types.ts';
import type { AgentTier, HierarchyMetrics, SpecialistNode } from './types.ts';
import { DOMAIN_TAXONOMY, classifyAgentTier, identifyPrimaryDomain } from './taxonomy.ts';

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
