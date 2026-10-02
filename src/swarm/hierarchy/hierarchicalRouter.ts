import type {
    DelegationRecord,
    EscalationRecord,
    HierarchicalRouteDecision,
    HierarchicalTaskComplexity,
    SpecialistNode
} from './types.ts';
import { identifyPrimaryDomain } from './taxonomy.ts';
import { HierarchicalSpecialistTree } from './specialistTree.ts';

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
