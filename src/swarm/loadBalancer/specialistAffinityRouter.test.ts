import { describe, it, expect, beforeEach } from 'vitest';
import { SpecialistAffinityRouter, type SpecialistCandidate } from './specialistAffinityRouter.ts';
import { TokenBudgetManager } from './tokenBudgetManager.ts';
import { AdaptiveLoadBalancer } from './adaptiveLoadBalancer.ts';
import { SpecialistCapabilityProfiler } from './specialistCapabilityProfiler.ts';
import { NodeCapacityManager } from './nodeCapacityManager.ts';

describe('SpecialistAffinityRouter', () => {
    let router: SpecialistAffinityRouter;
    let tokenManager: TokenBudgetManager;
    let loadBalancer: AdaptiveLoadBalancer;
    let profiler: SpecialistCapabilityProfiler;
    let capacityManager: NodeCapacityManager;

    beforeEach(() => {
        tokenManager = new TokenBudgetManager();
        loadBalancer = new AdaptiveLoadBalancer();
        profiler = new SpecialistCapabilityProfiler();
        capacityManager = new NodeCapacityManager();
        router = new SpecialistAffinityRouter(tokenManager, loadBalancer, profiler, capacityManager);
    });

    describe('scoreAffinity', () => {
        it('scores high affinity when role and task keywords align strongly', () => {
            const result = router.scoreAffinity('Security Auditor', 'Investigate JWT token authentication breach and sql injection vulnerability');
            expect(result.score).toBeGreaterThanOrEqual(0.70);
            expect(result.matchedDomain).toBe('Security & Auth');
        });

        it('returns 0.30 baseline when role matches a domain but task keywords do not', () => {
            const result = router.scoreAffinity('Security Specialist', 'Generic unrelated business logic calculation');
            expect(result.score).toBe(0.30);
            expect(result.matchedDomain).toBe('Security & Auth');
        });

        it('returns 0.25 for generic specialist role without domain keyword hits', () => {
            const result = router.scoreAffinity('Operations Specialist', 'Some unspecified process');
            expect(result.score).toBe(0.25);
            expect(result.matchedDomain).toBeUndefined();
        });

        it('returns 0.10 baseline for unrecognized roles with no keyword matches', () => {
            const result = router.scoreAffinity('Random Worker Node', 'Some unspecified process');
            expect(result.score).toBe(0.10);
            expect(result.matchedDomain).toBeUndefined();
        });

        it('handles undefined, null, or empty string edge cases safely', () => {
            const emptyResult = router.scoreAffinity('', '');
            expect(emptyResult.score).toBe(0.10);
            expect(emptyResult.matchedDomain).toBeUndefined();

            const nullRole = router.scoreAffinity(null as any, 'Security check');
            expect(nullRole.score).toBe(0.10);

            const nullContent = router.scoreAffinity('Security Auditor', null as any);
            expect(nullContent.score).toBe(0.30);
        });
    });

    describe('planDistribution', () => {
        it('throws an error when agents array is empty', () => {
            expect(() => router.planDistribution('task', ['chunk1'], [])).toThrow('No agents available');
        });

        it('returns an empty plan when given empty chunks array', () => {
            const candidates: SpecialistCandidate[] = [{ role: 'Analyst', provider: 'gemini' }];
            const plan = router.planDistribution('task', [], candidates);
            expect(plan.totalChunks).toBe(0);
            expect(plan.assignments).toEqual([]);
        });

        it('routes chunks to candidate with highest affinity score', () => {
            const candidates: SpecialistCandidate[] = [
                { id: 'sec-1', role: 'Security Engineer', provider: 'gemini' },
                { id: 'perf-1', role: 'Performance Optimizer', provider: 'groq' }
            ];

            const chunks = [
                'Analyze latency bottleneck, CPU memory leak, and throughput optimization'
            ];

            const plan = router.planDistribution('Performance tuning', chunks, candidates);
            expect(plan.totalChunks).toBe(1);
            expect(plan.assignments).toHaveLength(1);
            expect(plan.assignments[0].agentId).toBe('perf-1');
            expect(plan.assignments[0].agentRole).toBe('Performance Optimizer');
            expect(plan.assignments[0].isSpillover).toBe(false);
        });

        it('spills over to secondary candidate when primary node capacity is saturated', () => {
            const candidates: SpecialistCandidate[] = [
                { id: 'sec-primary', role: 'Security Auditor', provider: 'gemini' },
                { id: 'sec-backup', role: 'Security Reviewer', provider: 'openrouter' }
            ];

            // Set primary node concurrency limit to 1 and acquire slot to saturate it
            capacityManager.setMaxConcurrency('sec-primary', 1);
            capacityManager.tryAcquireSlot('sec-primary');

            const chunks = [
                'JWT authentication vulnerability CVE patch review'
            ];

            const plan = router.planDistribution('Security Audit', chunks, candidates);
            expect(plan.assignments[0].agentId).toBe('sec-backup');
            expect(plan.assignments[0].isSpillover).toBe(true);
            expect(plan.assignments[0].reason).toContain('capacity saturated');
        });

        it('incorporates RL capability profiler score into candidate routing', () => {
            const candidates: SpecialistCandidate[] = [
                { id: 'analyst-a', role: 'Data Modeler', provider: 'gemini' },
                { id: 'analyst-b', role: 'Data Modeler', provider: 'openrouter' }
            ];

            profiler.recordAccuracy('Data Modeler', 'win');
            profiler.recordAccuracy('Data Modeler', 'win');

            const chunks = ['SQL schema database migration and indexing table'];
            const plan = router.planDistribution('Data Modeling', chunks, candidates);
            expect(plan.totalChunks).toBe(1);
            expect(plan.assignments[0].agentRole).toBe('Data Modeler');
            expect(plan.assignments[0].rlScore).toBeDefined();
        });
    });
});
