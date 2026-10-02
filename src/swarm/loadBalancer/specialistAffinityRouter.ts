import { TokenBudgetManager, globalTokenBudgetManager } from './tokenBudgetManager.ts';
import { SpecialistCapabilityProfiler, globalSpecialistProfiler } from './specialistCapabilityProfiler.ts';
import { NodeCapacityManager, globalNodeCapacityManager } from './nodeCapacityManager.ts';
import { AdaptiveLoadBalancer, globalLoadBalancer } from './adaptiveLoadBalancer.ts';
export interface SpecialistDomainRule {
    domain: string;
    roleKeywords: string[];
    taskKeywords: string[];
}

export interface ChunkAssignment {
    chunkIndex: number;
    estimatedTokens: number;
    agentId: string;
    agentRole: string;
    provider: string;
    affinityScore: number;
    rlScore?: number;
    nodeHeadroom?: number;
    isSpillover?: boolean;
    allocatedTokens: number;
    reason: string;
}

export interface SpecialistRoutingPlan {
    totalChunks: number;
    totalEstimatedTokens: number;
    assignments: ChunkAssignment[];
    specialistSummary: Record<string, {
        role: string;
        chunksAssigned: number;
        tokensAllocated: number;
        nodeHeadroom?: number;
        isSaturated?: boolean;
    }>;
}

export interface SpecialistCandidate {
    id?: string;
    role: string;
    provider: string;
}

/**
 * Evaluates semantic affinity between task content and specialist roles,
 * factoring in token budgets and load to produce optimal chunk distributions.
 */
export class SpecialistAffinityRouter {
    private domainRules: SpecialistDomainRule[] = [
        {
            domain: 'Security & Auth',
            roleKeywords: ['security', 'auth', 'secops', 'crypt', 'compliance', 'cve', 'vulnerability', 'auditor'],
            taskKeywords: ['security', 'auth', 'token', 'jwt', 'vulnerability', 'cve', 'exploit', 'injection', 'permission', 'credential', 'attack', 'firewall', 'secret', 'breach', 'xss', 'csrf', 'tls', 'ssl', 'sanitize', 'password', 'oauth', 'acl', 'encryption']
        },
        {
            domain: 'Performance & Latency',
            roleKeywords: ['performance', 'optimization', 'latency', 'speed', 'scale', 'resource', 'infra', 'profiler'],
            taskKeywords: ['latency', 'throughput', 'memory', 'cpu', 'bottleneck', 'slow', 'cache', 'speed', 'profiling', 'optimization', 'tpm', 'timeout', 'concurrency', 'leak', 'benchmark', 'load', 'allocat', 'scale', 'io']
        },
        {
            domain: 'Data & Schema',
            roleKeywords: ['data', 'schema', 'sql', 'database', 'etl', 'analyst', 'modeler'],
            taskKeywords: ['schema', 'csv', 'json', 'sql', 'database', 'query', 'table', 'columns', 'records', 'aggregat', 'metrics', 'rows', 'transform', 'field', 'migration', 'index', 'relational', 'document', 'dataset']
        },
        {
            domain: 'Architecture & System Design',
            roleKeywords: ['architect', 'design', 'lead', 'system', 'core', 'orchestrator'],
            taskKeywords: ['architecture', 'design', 'system', 'orchestrat', 'state', 'pipeline', 'component', 'workflow', 'service', 'event', 'microservice', 'distributed', 'consensus', 'cluster', 'failover', 'topology']
        },
        {
            domain: 'Code & Syntax',
            roleKeywords: ['developer', 'engineer', 'code', 'syntax', 'debugger', 'tester'],
            taskKeywords: ['function', 'syntax', 'typescript', 'python', 'code', 'stack trace', 'error', 'bug', 'exception', 'compile', 'lint', 'class', 'method', 'runtime', 'nullpointer', 'typeerror', 'import', 'export']
        }
    ];

    private tokenManager: TokenBudgetManager;
    private loadBalancer: AdaptiveLoadBalancer;
    private capabilityProfiler: SpecialistCapabilityProfiler;
    private capacityManager: NodeCapacityManager;

    constructor(
        tokenManager?: TokenBudgetManager,
        loadBalancer?: AdaptiveLoadBalancer,
        capabilityProfiler?: SpecialistCapabilityProfiler,
        capacityManager?: NodeCapacityManager
    ) {
        this.tokenManager = tokenManager || globalTokenBudgetManager;
        this.loadBalancer = loadBalancer || globalLoadBalancer;
        this.capabilityProfiler = capabilityProfiler || globalSpecialistProfiler;
        this.capacityManager = capacityManager || globalNodeCapacityManager;
    }

    /**
     * Calculates affinity score (0.0 to 1.0) between an agent's role and a task / data payload.
     */
    scoreAffinity(agentRole: string, content: string): { score: number; matchedDomain?: string } {
        const roleLower = (agentRole || '').toLowerCase();
        const contentLower = (content || '').toLowerCase();

        let bestScore = 0.1;
        let matchedDomain: string | undefined = undefined;

        for (const rule of this.domainRules) {
            const roleMatches = rule.roleKeywords.some(rk => roleLower.includes(rk));
            if (!roleMatches) continue;

            let matchHits = 0;
            for (const tk of rule.taskKeywords) {
                if (contentLower.includes(tk)) {
                    matchHits++;
                }
            }

            if (matchHits > 0) {
                const keywordStrength = matchHits / (matchHits + 2);
                const score = 0.4 + (keywordStrength * 0.6);
                if (score > bestScore) {
                    bestScore = score;
                    matchedDomain = rule.domain;
                }
            } else {
                if (0.3 > bestScore) {
                    bestScore = 0.3;
                    matchedDomain = rule.domain;
                }
            }
        }

        if (bestScore === 0.1 && (roleLower.includes('analyst') || roleLower.includes('specialist'))) {
            bestScore = 0.25;
        }

        return { score: Math.round(bestScore * 100) / 100, matchedDomain };
    }

    /**
     * Generates a balanced, token-aware, capacity-governed assignment plan for chunks across specialist agents.
     * Prevents node saturation and dynamically spills over tasks to available candidate nodes.
     */
    planDistribution<T extends SpecialistCandidate>(task: string, chunks: string[], agents: T[]): SpecialistRoutingPlan {
        if (!agents || agents.length === 0) {
            throw new Error('No agents available for dynamic specialist routing');
        }

        const assignments: ChunkAssignment[] = [];
        const specialistSummary: Record<string, {
            role: string;
            chunksAssigned: number;
            tokensAllocated: number;
            nodeHeadroom?: number;
            isSaturated?: boolean;
        }> = {};
        
        for (const a of agents) {
            const nodeKey = a.id || a.role;
            const initHeadroom = Math.min(
                this.capacityManager.getCapacityHeadroom(nodeKey),
                this.capacityManager.getCapacityHeadroom(a.provider)
            );
            specialistSummary[a.role] = {
                role: a.role,
                chunksAssigned: 0,
                tokensAllocated: 0,
                nodeHeadroom: initHeadroom,
                isSaturated: initHeadroom <= 0
            };
        }

        let totalEstTokens = 0;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const estTokens = Math.max(10, Math.ceil(chunk.length / 4));
            totalEstTokens += estTokens;
            const combinedContent = `${task}\n${chunk}`;

            const candidates = agents.map(agent => {
                const nodeKey = agent.id || agent.role;
                const { score: affinity, matchedDomain } = this.scoreAffinity(agent.role, combinedContent);

                const currentAssigned = specialistSummary[agent.role]?.chunksAssigned || 0;
                const rawNodeHeadroom = this.capacityManager.getCapacityHeadroom(nodeKey);
                const rawProvHeadroom = this.capacityManager.getCapacityHeadroom(agent.provider);
                const baseHeadroom = Math.min(rawNodeHeadroom, rawProvHeadroom);
                const effectiveHeadroom = Math.max(0, baseHeadroom - currentAssigned);

                const maxConcurrency = Math.min(
                    this.capacityManager.getMaxConcurrency(nodeKey),
                    this.capacityManager.getMaxConcurrency(agent.provider)
                );
                const activeInFlight = Math.max(
                    this.capacityManager.getActiveInFlight(nodeKey),
                    this.capacityManager.getActiveInFlight(agent.provider)
                );
                const effectiveUtilization = maxConcurrency > 0
                    ? Math.min(1.0, (activeInFlight + currentAssigned) / maxConcurrency)
                    : 1.0;

                const isNodeSaturated = effectiveHeadroom <= 0 ||
                    this.capacityManager.isSaturated(nodeKey) ||
                    this.capacityManager.isSaturated(agent.provider);

                // Node capacity score: heavily downrank saturated nodes to spill over
                const nodeCapacityScore = isNodeSaturated ? 0.01 : Math.max(0.1, 1.0 - effectiveUtilization);

                // Token budget capacity score
                const provRemaining = this.tokenManager.getRemainingBudget(agent.provider);
                const provUtilization = this.tokenManager.getUtilizationRatio(agent.provider);
                const tokenCapacityScore = provRemaining < estTokens ? 0.05 : (1.0 - provUtilization * 0.5);

                // Combined capacity score (50% node concurrency headroom + 50% token budget)
                const capacityScore = (nodeCapacityScore * 0.50) + (tokenCapacityScore * 0.50);

                // Workload distribution: balance number of chunks assigned per agent
                const balanceScore = 1.0 / (1 + currentAssigned * 0.5);

                // RL Capability Score (UCB1)
                const ucbScore = this.capabilityProfiler.getUcb1Score(agent.role, matchedDomain);
                const normalizedUcb = Math.min(1.0, Math.max(0.05, ucbScore / 1.5));

                // 30% affinity + 25% RL capability (UCB1) + 30% capacity (node + token) + 15% workload distribution
                const combinedScore = (affinity * 0.30) + (normalizedUcb * 0.25) + (capacityScore * 0.30) + (balanceScore * 0.15);

                return {
                    agent,
                    nodeKey,
                    affinity,
                    matchedDomain,
                    effectiveHeadroom,
                    isNodeSaturated,
                    nodeCapacityScore,
                    tokenCapacityScore,
                    capacityScore,
                    combinedScore,
                    normalizedUcb,
                    ucbScore,
                    provRemaining
                };
            });

            candidates.sort((a, b) => b.combinedScore - a.combinedScore);
            const best = candidates[0];
            const chosen = best.agent;

            // Detect whether spillover occurred from a saturated candidate with equal or higher affinity
            const saturatedCandidates = candidates.filter(c => c.isNodeSaturated);
            const spilloverFrom = saturatedCandidates.find(c => c.agent !== chosen && c.affinity >= best.affinity - 0.05);
            const isSpillover = !!spilloverFrom;

            let reason = '';
            if (isSpillover && spilloverFrom) {
                reason = `Spillover reroute: '${spilloverFrom.agent.role}' capacity saturated (0 headroom); allocated to '${chosen.role}' (headroom ${best.effectiveHeadroom})`;
            } else if (best.matchedDomain) {
                reason = `Matched '${best.matchedDomain}' (affinity ${(best.affinity * 100).toFixed(0)}%, headroom ${best.effectiveHeadroom}, RL UCB ${(best.normalizedUcb * 100).toFixed(0)}%)`;
            } else {
                reason = `Capacity allocation (headroom ${best.effectiveHeadroom}, RL UCB ${(best.normalizedUcb * 100).toFixed(0)}%)`;
            }

            assignments.push({
                chunkIndex: i,
                estimatedTokens: estTokens,
                agentId: chosen.id || chosen.role,
                agentRole: chosen.role,
                provider: chosen.provider,
                affinityScore: best.affinity,
                rlScore: Math.round(best.normalizedUcb * 100) / 100,
                nodeHeadroom: best.effectiveHeadroom,
                isSpillover,
                allocatedTokens: estTokens,
                reason
            });

            specialistSummary[chosen.role].chunksAssigned++;
            specialistSummary[chosen.role].tokensAllocated += estTokens;
            specialistSummary[chosen.role].nodeHeadroom = Math.max(0, best.effectiveHeadroom - 1);
            specialistSummary[chosen.role].isSaturated = specialistSummary[chosen.role].nodeHeadroom <= 0;

            this.tokenManager.recordUsage(chosen.provider, estTokens, chosen.role);
        }

        return {
            totalChunks: chunks.length,
            totalEstimatedTokens: totalEstTokens,
            assignments,
            specialistSummary
        };
    }
}

export const globalSpecialistRouter = new SpecialistAffinityRouter();
