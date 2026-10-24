import { describe, it, expect, beforeEach } from 'vitest';
import { SpecialistAffinityRouter, type SpecialistCandidate } from './specialistAffinityRouter.ts';
import { SpecialistAffinityRouter as RouterExported } from '../router.ts';
import { TokenBudgetManager } from './tokenBudgetManager.ts';
import { AdaptiveLoadBalancer } from './adaptiveLoadBalancer.ts';
import { SpecialistCapabilityProfiler } from './specialistCapabilityProfiler.ts';
import { NodeCapacityManager } from './nodeCapacityManager.ts';

describe('Context-Capacity Routing Affinity (Goal 5)', () => {
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

    it('exports SpecialistAffinityRouter from router.ts', () => {
        expect(RouterExported).toBeDefined();
        const r = new RouterExported();
        expect(r).toBeInstanceOf(SpecialistAffinityRouter);
    });

    it('filters out low-capacity providers (Groq <= 1500 tokens) when chunk exceeds 1,500 tokens despite higher role affinity', () => {
        const candidates: SpecialistCandidate[] = [
            { id: 'groq-perf', role: 'Performance Optimizer', provider: 'groq' },
            { id: 'gemini-sec', role: 'Security Auditor', provider: 'gemini' }
        ];

        // Chunk > 1500 tokens with performance keywords that would otherwise match Groq
        const largeData = 'throughput latency bottleneck profiling '.repeat(350); // ~2800 tokens
        const plan = router.planDistribution('Performance tuning', [largeData], candidates);

        expect(plan.totalChunks).toBe(1);
        expect(plan.assignments[0].provider).toBe('gemini');
        expect(plan.assignments[0].agentId).toBe('gemini-sec');
        expect(plan.assignments[0].provider).not.toBe('groq');
    });

    it('routes to low-capacity provider (Groq) when chunk is within 1,500 token limit and has higher affinity', () => {
        const candidates: SpecialistCandidate[] = [
            { id: 'groq-perf', role: 'Performance Optimizer', provider: 'groq' },
            { id: 'gemini-sec', role: 'Security Auditor', provider: 'gemini' }
        ];

        // Small chunk (< 1500 tokens) with performance keywords
        const smallData = 'throughput latency bottleneck profiling cache speed optimization';
        const plan = router.planDistribution('Performance tuning', [smallData], candidates);

        expect(plan.totalChunks).toBe(1);
        expect(plan.assignments[0].provider).toBe('groq');
        expect(plan.assignments[0].agentId).toBe('groq-perf');
    });

    it('directs heterogeneous chunks appropriately: large chunks to Gemini/NVIDIA, small chunks to Groq', () => {
        const candidates: SpecialistCandidate[] = [
            { id: 'groq-perf', role: 'Performance Optimizer', provider: 'groq' },
            { id: 'nvidia-perf', role: 'Performance Optimizer', provider: 'nvidia' }
        ];

        const smallChunk = 'latency cache profiling';
        const largeChunk = 'throughput latency memory scale io '.repeat(350); // ~2800 tokens

        const plan = router.planDistribution('Performance tuning', [smallChunk, largeChunk], candidates);
        expect(plan.totalChunks).toBe(2);

        const smallAssignment = plan.assignments.find(a => a.chunkIndex === 0);
        const largeAssignment = plan.assignments.find(a => a.chunkIndex === 1);

        // Small chunk can use Groq
        expect(smallAssignment?.provider).toBe('groq');
        // Large chunk MUST be filtered away from Groq to NVIDIA
        expect(largeAssignment?.provider).toBe('nvidia');
        expect(largeAssignment?.provider).not.toBe('groq');
    });

    it('never routes chunks > 1,500 tokens to Groq in multi-specialist clusters without blacklisting', () => {
        const candidates: SpecialistCandidate[] = [
            { id: 'groq-1', role: 'Data Modeler', provider: 'groq' },
            { id: 'groq-2', role: 'Performance Optimizer', provider: 'groq' },
            { id: 'gemini-1', role: 'General Analyst', provider: 'gemini' },
            { id: 'nvidia-1', role: 'Security Specialist', provider: 'nvidia' }
        ];

        const chunks = [
            '{"schema": "small payload", "id": 1}', // small
            '{"dataset": "' + 'x'.repeat(8000) + '"}', // large (>1500 tokens)
            '{"dataset": "' + 'y'.repeat(12000) + '"}', // large (>1500 tokens)
            '{"metric": "fast query"}' // small
        ];

        const plan = router.planDistribution('Cluster processing', chunks, candidates);
        expect(plan.totalChunks).toBe(4);

        for (const assignment of plan.assignments) {
            if (assignment.estimatedTokens > 1500) {
                expect(assignment.provider).not.toBe('groq');
                expect(['gemini', 'nvidia']).toContain(assignment.provider);
            }
        }
    });
});
