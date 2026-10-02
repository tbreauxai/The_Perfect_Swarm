import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import type { SwarmEngineSettings } from '../types.ts';
import {
    globalHierarchicalMessageBus,
    globalClusterTopologyManager,
    type SpecialistNodeInput,
    type SwarmTopology
} from '../communication.ts';
import {
    globalSpecialistProfiler,
    globalNodeCapacityManager
} from '../loadBalancer.ts';
import {
    HierarchicalSpecialistTree,
    globalHierarchicalRouter,
    type HierarchicalRouteDecision
} from '../hierarchy.ts';

export interface ClusterTopologySetupResult {
    topology: SwarmTopology;
    analystClusterMap: Map<string, string>;
    specialistTree?: HierarchicalSpecialistTree;
    hierarchicalDelegationCount: number;
    hierarchicalEscalationCount: number;
}

export function setupClusterTopology(params: {
    task: string;
    data?: string;
    analysts: Agent[];
    managerAgent: Agent;
    chunks: string[];
    settings?: SwarmEngineSettings;
    context: SwarmContext;
}): ClusterTopologySetupResult {
    const { task, data, analysts, managerAgent, chunks, settings, context } = params;

    const rootManagerId = managerAgent.id || managerAgent.role || 'manager';
    const specialistInputs: SpecialistNodeInput[] = analysts.map(a => ({
        id: a.id || a.role,
        role: a.role,
        provider: a.provider,
        model: a.modelName
    }));

    const topology: SwarmTopology = globalClusterTopologyManager.discoverTopology({
        specialists: specialistInputs,
        task,
        rootNodeId: rootManagerId,
        capabilityScorer: (role) => globalSpecialistProfiler.getCapabilityScore(role),
        capacityHeadroomGetter: (nodeKey) => globalNodeCapacityManager.getNodeHeadroom(nodeKey)
    });

    globalClusterTopologyManager.applyTopologyToBus(
        globalHierarchicalMessageBus,
        topology,
        { id: rootManagerId, role: managerAgent.role }
    );

    const analystClusterMap = new Map<string, string>();
    for (const [nodeId, clusterId] of Object.entries(topology.nodeClusterMap)) {
        analystClusterMap.set(nodeId, clusterId);
    }

    let specialistTree: HierarchicalSpecialistTree | undefined;
    const hierarchicalDecisions: HierarchicalRouteDecision[] = [];
    let hierarchicalDelegationCount = 0;
    const hierarchicalEscalationCount = 0;

    if (settings?.hierarchySettings?.enabled !== false && analysts.length > 0) {
        specialistTree = HierarchicalSpecialistTree.buildFromAgents([managerAgent, ...analysts], task);

        const chunksToRoute = chunks.length > 0 ? chunks : [data || task];
        chunksToRoute.forEach((chk, i) => {
            const decision = globalHierarchicalRouter.routeHierarchical(
                task,
                chk,
                i,
                specialistTree!,
                (role) => globalSpecialistProfiler.getCapabilityScore(role)
            );
            hierarchicalDecisions.push(decision);
            if (decision.delegationChain.length > 1) {
                hierarchicalDelegationCount++;
                if (settings?.hierarchySettings?.delegationEnabled !== false) {
                    context.addEvent({
                        agentRole: 'Hierarchical Router',
                        action: 'Specialist Delegation',
                        modelName: 'Local/HierarchyRouter',
                        prompt: `Delegated task chunk ${i + 1} down hierarchy: ${decision.delegationChain.join(' -> ')}`,
                        output: {
                            chunkIndex: i,
                            targetRole: decision.targetRole,
                            targetTier: decision.targetTier,
                            tierRole: decision.tierRole,
                            delegationChain: decision.delegationChain,
                            complexity: decision.complexity,
                            primaryDomain: decision.primaryDomain,
                            routingScore: decision.routingScore,
                            reason: decision.reason
                        },
                        durationMs: 0
                    });
                }
            }
        });

        const treeMetrics = specialistTree.getMetrics();
        context.addEvent({
            agentRole: 'Hierarchical Router',
            action: 'Hierarchical Routing Plan',
            modelName: 'Local/HierarchyRouter',
            prompt: `Organized ${treeMetrics.totalNodes} agents across depth ${treeMetrics.treeDepth} with ${hierarchicalDecisions.length} hierarchical routing decisions`,
            output: {
                treeMetrics,
                decisions: hierarchicalDecisions
            },
            durationMs: 0
        });
    }

    return {
        topology,
        analystClusterMap,
        specialistTree,
        hierarchicalDelegationCount,
        hierarchicalEscalationCount
    };
}
