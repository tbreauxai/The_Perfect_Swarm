import type {
    SpecialistNodeInput,
    DiscoverTopologyParams,
    ClusterPodDefinition,
    SwarmTopology
} from './types.ts';
import { HierarchicalMessageBus } from './messageBus.ts';

export const DOMAIN_KEYWORD_PATTERNS: Record<string, string[]> = {
    'security-pod': ['sec', 'auth', 'crypto', 'vulnerab', 'audit', 'permission', 'threat', 'token', 'jwt', 'rbac', 'oauth', 'csrf', 'xss', 'firewall', 'breach', 'secret', 'sanitize'],
    'performance-pod': ['perf', 'latency', 'throughput', 'bottleneck', 'speed', 'cache', 'memory', 'cpu', 'benchmark', 'optimi', 'allocation', 'leak', 'tpm', 'rpm', 'timeout', 'concurrency'],
    'data-pod': ['data', 'sql', 'schema', 'database', 'storage', 'migration', 'query', 'table', 'model', 'analytics', 'cortex', 'vector', 'qdrant', 'embedding', 'dataset', 'record'],
    'architecture-pod': ['arch', 'system', 'infra', 'distributed', 'network', 'protocol', 'deployment', 'cloud', 'pipeline', 'gateway', 'microservice', 'orchestrat', 'cluster', 'failover']
};

/**
 * Manages dynamic cluster auto-discovery, capability-based lead election,
 * and pod workload rebalancing for hierarchical multi-agent swarms.
 */
export class ClusterTopologyManager {
    /**
     * Dynamically clusters specialist agents into affinity pods and elects
     * the highest-capability and highest-headroom node as Cluster Lead.
     */
    discoverTopology(params: DiscoverTopologyParams): SwarmTopology {
        const specialists = params.specialists || [];
        const rootNodeId = params.rootNodeId || 'manager';
        const taskLower = (params.task || '').toLowerCase();

        // 1. Group specialists into cluster pods
        const podMembersMap: Record<string, SpecialistNodeInput[]> = {};

        for (const spec of specialists) {
            const clusterId = this.resolveClusterId(spec, taskLower);
            if (!podMembersMap[clusterId]) {
                podMembersMap[clusterId] = [];
            }
            podMembersMap[clusterId].push(spec);
        }

        // Fallback: If no specialists or single pod
        if (Object.keys(podMembersMap).length === 0) {
            return {
                pods: {},
                nodeClusterMap: {},
                leadNodeIds: [],
                rootNodeId,
                totalSpecialists: 0,
                totalPods: 0
            };
        }

        // 2. Elect Cluster Leads for each pod
        const pods: Record<string, ClusterPodDefinition> = {};
        const nodeClusterMap: Record<string, string> = {};
        const leadNodeIds: string[] = [];

        for (const [clusterId, members] of Object.entries(podMembersMap)) {
            const domain = clusterId.replace('-pod', '');
            const memberNodeIds = members.map(m => m.id);
            const memberRoles = members.map(m => m.role);

            for (const m of members) {
                nodeClusterMap[m.id] = clusterId;
            }

            const { leadNodeId, leadRole, electionReason } = this.electLead(members, params);
            leadNodeIds.push(leadNodeId);

            pods[clusterId] = {
                clusterId,
                domain,
                leadNodeId,
                leadRole,
                memberNodeIds,
                memberRoles,
                electionReason
            };
        }

        return {
            pods,
            nodeClusterMap,
            leadNodeIds,
            rootNodeId,
            totalSpecialists: specialists.length,
            totalPods: Object.keys(pods).length
        };
    }

    /**
     * Resolves the best-matching cluster pod for a given specialist.
     */
    private resolveClusterId(spec: SpecialistNodeInput, taskLower: string): string {
        if (spec.domain) {
            const cleaned = spec.domain.toLowerCase().trim();
            if (DOMAIN_KEYWORD_PATTERNS[`${cleaned}-pod`]) {
                return `${cleaned}-pod`;
            }
        }

        const roleLower = (spec.role || '').toLowerCase();
        let bestDomain = 'general-pod';
        let highestScore = 0;

        for (const [podId, keywords] of Object.entries(DOMAIN_KEYWORD_PATTERNS)) {
            let roleMatchCount = 0;
            let taskMatchCount = 0;

            for (const kw of keywords) {
                if (roleLower.includes(kw)) {
                    roleMatchCount++;
                }
                if (taskLower.includes(kw)) {
                    taskMatchCount++;
                }
            }

            // Specialist pod assignment requires role affinity
            if (roleMatchCount > 0) {
                const score = (roleMatchCount * 5) + taskMatchCount;
                if (score > highestScore) {
                    highestScore = score;
                    bestDomain = podId;
                }
            }
        }

        return bestDomain;
    }

    /**
     * Elects the cluster lead for a given pod based on capability score and node headroom.
     */
    private electLead(
        members: SpecialistNodeInput[],
        params: DiscoverTopologyParams
    ): { leadNodeId: string; leadRole: string; electionReason: string } {
        if (members.length === 1) {
            return {
                leadNodeId: members[0].id,
                leadRole: members[0].role,
                electionReason: 'Sole specialist in pod'
            };
        }

        let bestScore = -Infinity;
        let elected = members[0];
        let chosenCapScore = 1.0;
        let chosenHeadroom = 1;

        for (const member of members) {
            const nodeKey = member.id || member.role;
            const capScore = params.capabilityScorer ? params.capabilityScorer(member.role) : 1.0;
            const headroom = params.capacityHeadroomGetter ? params.capacityHeadroomGetter(nodeKey) : 1;

            // Weighted scoring: 60% capability, 40% capacity headroom (normalized up to 5)
            const score = (capScore * 0.6) + (Math.min(headroom, 5) * 0.4);

            if (score > bestScore) {
                bestScore = score;
                elected = member;
                chosenCapScore = capScore;
                chosenHeadroom = headroom;
            }
        }

        return {
            leadNodeId: elected.id,
            leadRole: elected.role,
            electionReason: `Elected by capability score (${chosenCapScore.toFixed(2)}) and headroom (${chosenHeadroom})`
        };
    }

    /**
     * Rebalances topology when active cluster leads become saturated.
     * Elects the next healthiest member in the pod to act as temporary cluster lead.
     */
    rebalanceTopology(currentTopology: SwarmTopology, saturatedNodeIds: string[]): SwarmTopology {
        const saturatedSet = new Set(saturatedNodeIds);
        const newPods: Record<string, ClusterPodDefinition> = {};
        const newLeadNodeIds: string[] = [];

        for (const [clusterId, pod] of Object.entries(currentTopology.pods)) {
            if (saturatedSet.has(pod.leadNodeId) && pod.memberNodeIds.length > 1) {
                // Find unsaturated member
                const alternateId = pod.memberNodeIds.find(id => !saturatedSet.has(id));
                if (alternateId) {
                    const altIndex = pod.memberNodeIds.indexOf(alternateId);
                    const altRole = pod.memberRoles[altIndex] || alternateId;
                    newPods[clusterId] = {
                        ...pod,
                        leadNodeId: alternateId,
                        leadRole: altRole,
                        electionReason: `Rebalanced: Prior lead '${pod.leadRole}' saturated; promoted alternate '${altRole}'`
                    };
                    newLeadNodeIds.push(alternateId);
                    continue;
                }
            }

            newPods[clusterId] = { ...pod };
            newLeadNodeIds.push(pod.leadNodeId);
        }

        return {
            ...currentTopology,
            pods: newPods,
            leadNodeIds: newLeadNodeIds
        };
    }

    /**
     * Applies a discovered topology to a HierarchicalMessageBus, registering
     * root, cluster-lead, and specialist nodes into the bus graph.
     */
    applyTopologyToBus(
        bus: HierarchicalMessageBus,
        topology: SwarmTopology,
        rootManager: { id: string; role: string } = { id: 'manager', role: 'Manager Node' }
    ): void {
        bus.reset();

        // 1. Register Root Manager
        bus.registerNode({
            id: rootManager.id,
            role: rootManager.role,
            layer: 'root',
            clusterId: 'root-pod'
        });

        // 2. Register Pod Members with Lead Promotion
        for (const pod of Object.values(topology.pods)) {
            for (let i = 0; i < pod.memberNodeIds.length; i++) {
                const nodeId = pod.memberNodeIds[i];
                const role = pod.memberRoles[i];
                const isLead = nodeId === pod.leadNodeId;

                bus.registerNode({
                    id: nodeId,
                    role,
                    layer: isLead ? 'cluster-lead' : 'specialist',
                    clusterId: pod.clusterId,
                    parentClusterId: 'root-pod',
                    domain: pod.domain,
                    metadata: {
                        isLead,
                        electionReason: isLead ? pod.electionReason : undefined
                    }
                });
            }
        }
    }
}

export const globalClusterTopologyManager = new ClusterTopologyManager();
