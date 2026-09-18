import { describe, it, expect, beforeEach } from 'vitest';
import {
    classifyAgentTier,
    identifyPrimaryDomain,
    HierarchicalSpecialistTree,
    HierarchicalRouter,
    SpecialistNode,
    DOMAIN_TAXONOMY
} from './hierarchy.ts';

describe('Hierarchical Agent Specialization & Dynamic Routing Suite', () => {
    describe('classifyAgentTier', () => {
        it('classifies manager/coordinator roles as Tier 0 root_coordinator', () => {
            expect(classifyAgentTier('Manager Node')).toEqual({ tier: 0, tierRole: 'root_coordinator' });
            expect(classifyAgentTier('System Orchestrator')).toEqual({ tier: 0, tierRole: 'root_coordinator' });
            expect(classifyAgentTier('Director of Intelligence')).toEqual({ tier: 0, tierRole: 'root_coordinator' });
        });

        it('classifies leads and architects as Tier 1 cluster_lead', () => {
            expect(classifyAgentTier('Security Architect')).toEqual({ tier: 1, tierRole: 'cluster_lead' });
            expect(classifyAgentTier('Infrastructure Lead')).toEqual({ tier: 1, tierRole: 'cluster_lead' });
            expect(classifyAgentTier('Principal Systems Engineer')).toEqual({ tier: 1, tierRole: 'cluster_lead' });
        });

        it('classifies domain analysts and specialists as Tier 2 deep_specialist', () => {
            expect(classifyAgentTier('Database Specialist')).toEqual({ tier: 2, tierRole: 'deep_specialist' });
            expect(classifyAgentTier('Performance Engineer')).toEqual({ tier: 2, tierRole: 'deep_specialist' });
            expect(classifyAgentTier('Cryptographic Analyst')).toEqual({ tier: 2, tierRole: 'deep_specialist' });
        });

        it('classifies operators and tool workers as Tier 3 leaf_operator', () => {
            expect(classifyAgentTier('Metric Calculator Tool')).toEqual({ tier: 3, tierRole: 'leaf_operator' });
            expect(classifyAgentTier('Schema Validator Operator')).toEqual({ tier: 3, tierRole: 'leaf_operator' });
        });
    });

    describe('identifyPrimaryDomain', () => {
        it('identifies security domain from auth and token keywords', () => {
            const res = identifyPrimaryDomain('Audit JWT authentication token expiration and breach exposure');
            expect(res.domainKey).toBe('security');
            expect(res.score).toBeGreaterThan(0.4);
            expect(res.matchedKeywords).toContain('token');
            expect(res.matchedKeywords).toContain('breach');
        });

        it('identifies database domain from sql and indexing keywords', () => {
            const res = identifyPrimaryDomain('Analyze PostgreSQL database connection pool deadlock and slow queries');
            expect(res.domainKey).toBe('database');
            expect(res.matchedKeywords).toContain('database');
            expect(res.matchedKeywords).toContain('query');
        });

        it('identifies performance domain from cpu and latency keywords', () => {
            const res = identifyPrimaryDomain('Diagnose CPU spike and high tail latency in memory cache');
            expect(res.domainKey).toBe('performance');
            expect(res.matchedKeywords).toContain('latency');
            expect(res.matchedKeywords).toContain('cpu');
        });

        it('falls back to general domain for non-technical queries', () => {
            const res = identifyPrimaryDomain('Provide a general status overview check');
            expect(res.domainKey).toBe('general');
        });
    });

    describe('HierarchicalSpecialistTree', () => {
        it('constructs multi-tier tree automatically from agents array', () => {
            const agents = [
                { id: 'mgr', role: 'Manager Node', provider: 'simulated' },
                { id: 'sec-lead', role: 'Security Architect', provider: 'simulated' },
                { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'simulated' },
                { id: 'db-spec', role: 'Database Analyst', provider: 'simulated' },
                { id: 'calc-tool', role: 'Calculator Tool Operator', provider: 'simulated' }
            ];

            const tree = HierarchicalSpecialistTree.buildFromAgents(agents, 'Audit authentication and databases');
            expect(tree.getAllNodes().length).toBe(5);

            // Root verification
            const root = tree.getRoot();
            expect(root?.id).toBe('mgr');
            expect(root?.tier).toBe(0);

            // Tier 1 Lead verification
            const secLead = tree.getNode('sec-lead');
            expect(secLead?.tier).toBe(1);
            expect(secLead?.parentId).toBe('mgr');
            expect(tree.getChildren('mgr').map(c => c.id)).toContain('sec-lead');

            // Tier 2 Specialist verification
            const secSpec = tree.getNode('sec-spec');
            expect(secSpec?.tier).toBe(2);
            expect(secSpec?.parentId).toBe('sec-lead');
            expect(tree.getChildren('sec-lead').map(c => c.id)).toContain('sec-spec');

            // Tree metrics
            const metrics = tree.getMetrics();
            expect(metrics.totalNodes).toBe(5);
            expect(metrics.tierCounts[0]).toBe(1); // root
            expect(metrics.tierCounts[1]).toBe(1); // lead
            expect(metrics.tierCounts[2]).toBe(2); // specialists
            expect(metrics.tierCounts[3]).toBe(1); // leaf operator
            expect(metrics.treeDepth).toBe(4);
        });

        it('handles parent/child lookups safely when nodes are missing', () => {
            const tree = new HierarchicalSpecialistTree();
            expect(tree.getNode('non-existent')).toBeUndefined();
            expect(tree.getChildren('non-existent')).toEqual([]);
            expect(tree.getParent('non-existent')).toBeUndefined();
            expect(tree.getTreeDepth()).toBe(0);
        });
    });

    describe('HierarchicalRouter', () => {
        let router: HierarchicalRouter;
        let tree: HierarchicalSpecialistTree;

        beforeEach(() => {
            router = new HierarchicalRouter();
            const agents = [
                { id: 'root', role: 'Manager Node', provider: 'simulated' },
                { id: 'sec-lead', role: 'Security Architect', provider: 'simulated' },
                { id: 'sec-spec', role: 'Vulnerability Specialist', provider: 'simulated' },
                { id: 'perf-lead', role: 'Performance Architect', provider: 'simulated' },
                { id: 'perf-spec', role: 'Latency Optimization Specialist', provider: 'simulated' },
                { id: 'calc-tool', role: 'Metrics Calculator Tool', provider: 'simulated' }
            ];
            tree = HierarchicalSpecialistTree.buildFromAgents(agents);
        });

        it('infers task complexity accurately from structural markers and lengths', () => {
            expect(router.inferComplexity('Quick status check', 'All green')).toBe('trivial');
            expect(router.inferComplexity('Analyze memory usage and diagnose garbage collection delays', 'RAM: 85%')).toBe('moderate');
            expect(router.inferComplexity('Design distributed microservice architecture with async pipeline', 'Service A calls Service B')).toBe('complex');
            expect(router.inferComplexity('URGENT: Security breach detected with CVE exploit and data corruption in production')).toBe('critical');
        });

        it('routes domain-specific tasks to matching specialists and builds delegation chain', () => {
            const decision = router.routeHierarchical(
                'Audit vulnerability in OAuth authentication token flow',
                'Payload token check',
                0,
                tree
            );

            expect(decision.targetRole).toBe('Vulnerability Specialist');
            expect(decision.targetTier).toBe(2);
            expect(decision.primaryDomain).toBe('security');
            expect(decision.routingScore).toBeGreaterThan(0.6);
            expect(decision.delegationChain).toEqual(['Manager Node', 'Security Architect', 'Vulnerability Specialist']);
            expect(decision.reason).toContain('via Delegation');

            // Verify delegation record was recorded
            const history = router.getDelegationHistory();
            expect(history.length).toBe(1);
            expect(history[0].fromNodeId).toBe('sec-lead');
            expect(history[0].toNodeId).toBe('sec-spec');
        });

        it('escalates critical anomalies up the hierarchy to cluster lead or root', () => {
            const escalation = router.escalate(
                'task-chunk-0',
                'sec-spec',
                tree,
                3,
                'Found multiple zero-day vulnerabilities requiring executive sign-off'
            );

            expect(escalation.fromNodeId).toBe('sec-spec');
            expect(escalation.toNodeId).toBe('sec-lead');
            expect(escalation.anomalyCount).toBe(3);
            expect(escalation.reason).toContain('zero-day');

            const escHistory = router.getEscalationHistory();
            expect(escHistory.length).toBe(1);
        });

        it('calculates routing score incorporating domain expertise and complexity fitness', () => {
            const secSpec = tree.getNode('sec-spec')!;
            const scoreSecurity = router.calculateRoutingScore(secSpec, 'moderate', 'security', 0.9);
            const scoreDatabase = router.calculateRoutingScore(secSpec, 'moderate', 'database', 0.9);

            // Matching domain should score significantly higher than unmatched domain
            expect(scoreSecurity).toBeGreaterThan(scoreDatabase);
            expect(scoreSecurity).toBeGreaterThan(0.7);
        });
    });
});
