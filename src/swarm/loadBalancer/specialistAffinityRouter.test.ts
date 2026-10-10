import { describe, it, expect, beforeEach } from 'vitest';
import {
    TokenBudgetManager,
    SpecialistAffinityRouter,
    AdaptiveLoadBalancer,
    NodeCapacityManager,
    SpecialistCapabilityProfiler
} from '../loadBalancer';


describe('SpecialistAffinityRouter', () => {
    let tokenManager: TokenBudgetManager;
    let loadBalancer: AdaptiveLoadBalancer;
    let router: SpecialistAffinityRouter;
    let capacityManager: NodeCapacityManager;
    let profiler: SpecialistCapabilityProfiler;

    beforeEach(() => {
        tokenManager = new TokenBudgetManager({
            defaultTpmLimit: 30000,
            providerTpmLimits: {
                groq: 6000,
                mistral: 30000,
                gemini: 1000000,
                simulated: 5000000
            }
        });
        loadBalancer = new AdaptiveLoadBalancer();
        capacityManager = new NodeCapacityManager();
        profiler = new SpecialistCapabilityProfiler();
        router = new SpecialistAffinityRouter(tokenManager, loadBalancer, profiler, capacityManager);
    });

        it('calculates higher affinity for domain-relevant specialist roles', () => {
            const secAffinity = router.scoreAffinity('Security Specialist', 'Investigate JWT token injection and unauthorized access');
            expect(secAffinity.score).toBeGreaterThan(0.6);
            expect(secAffinity.matchedDomain).toBe('Security & Auth');

            const perfAffinity = router.scoreAffinity('Performance Optimizer', 'Analyze latency bottlenecks, CPU spike, and memory leaks');
            expect(perfAffinity.score).toBeGreaterThan(0.6);
            expect(perfAffinity.matchedDomain).toBe('Performance & Latency');

            const dataAffinity = router.scoreAffinity('Data Analyst', 'Parse CSV schema and calculate aggregate metrics on rows');
            expect(dataAffinity.score).toBeGreaterThan(0.5);
            expect(dataAffinity.matchedDomain).toBe('Data & Schema');

            const codeAffinity = router.scoreAffinity('TypeScript Developer', 'Debug syntax runtime TypeError stack trace in function handler');
            expect(codeAffinity.score).toBeGreaterThan(0.6);
            expect(codeAffinity.matchedDomain).toBe('Code & Syntax');
        });

        it('dynamically distributes chunks to best-suited specialists based on task keywords and capacity', () => {
            const specialists = [
                { id: 'a1', role: 'Security Specialist', provider: 'gemini' },
                { id: 'a2', role: 'Performance Optimizer', provider: 'groq' },
                { id: 'a3', role: 'Data Analyst', provider: 'mistral' }
            ];

            const chunks = [
                'SQL injection detected on login endpoint with leaked bearer tokens and credentials.',
                'Throughput dropped by 60% and response latency increased to 4200ms due to memory leak.',
                'Aggregated 100,000 transaction records across table columns with schema discrepancies.'
            ];

            const plan = router.planDistribution('Audit microservice cluster', chunks, specialists);

            expect(plan.totalChunks).toBe(3);
            expect(plan.assignments).toHaveLength(3);

            // Chunk 0 (security) routed to Security Specialist
            expect(plan.assignments[0].agentRole).toBe('Security Specialist');
            expect(plan.assignments[0].reason).toContain('Security & Auth');

            // Chunk 1 (latency/memory) routed to Performance Optimizer
            expect(plan.assignments[1].agentRole).toBe('Performance Optimizer');
            expect(plan.assignments[1].reason).toContain('Performance & Latency');

            // Chunk 2 (schema/records) routed to Data Analyst
            expect(plan.assignments[2].agentRole).toBe('Data Analyst');
            expect(plan.assignments[2].reason).toContain('Data & Schema');
        });

        it('reroutes to alternate available specialists when a provider approaches token budget bottleneck', () => {
            const specialists = [
                { id: 'g1', role: 'Security Analyst', provider: 'groq' },
                { id: 'm1', role: 'Compliance Auditor', provider: 'mistral' }
            ];

            // Deplete Groq token budget (limit: 6000)
            tokenManager.recordUsage('groq', 5800);

            const chunks = [
                'Audit authorization permissions and TLS encryption certificates'
            ];

            const plan = router.planDistribution('Security verification', chunks, specialists);
            expect(plan.assignments).toHaveLength(1);

            // Because Groq is nearly depleted, Compliance Auditor on Mistral receives the chunk
            expect(plan.assignments[0].provider).toBe('mistral');
            expect(plan.assignments[0].agentRole).toBe('Compliance Auditor');
        });

        it('throws an error if agents array is empty during planDistribution', () => {
            expect(() => {
                router.planDistribution('task', ['chunk1'], []);
            }).toThrow('No agents available for dynamic specialist routing');
        });

        it('handles undefined or empty string roles and contents gracefully in scoreAffinity', () => {
            const emptyRoleAffinity = router.scoreAffinity('', 'Investigate JWT token injection');
            expect(emptyRoleAffinity.score).toBe(0.1); // No role match

            const emptyContentAffinity = router.scoreAffinity('Security Specialist', '');
            expect(emptyContentAffinity.score).toBe(0.3); // Role matched but no content matched

            const undefinedAffinity = router.scoreAffinity(undefined as any, undefined as any);
            expect(undefinedAffinity.score).toBe(0.1); // default lowest score
        });

        it('assigns generic analyst role a base score even if no domains match', () => {
            const genericAffinity = router.scoreAffinity('General Analyst', 'Some random content without keywords');
            expect(genericAffinity.score).toBe(0.3);

            const unknownAffinity = router.scoreAffinity('Unknown Role', 'Some random content');
            expect(unknownAffinity.score).toBe(0.1);
        });

        it('assigns 0.25 fallback score if role contains specialist/analyst but no domain rules match', () => {
            const genericSpecialist = router.scoreAffinity('Generic Specialist', 'Some unknown content');
            expect(genericSpecialist.score).toBe(0.25);
        });
});
