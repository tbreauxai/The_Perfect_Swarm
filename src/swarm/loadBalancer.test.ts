import { describe, it, expect, beforeEach } from 'vitest';
import { 
    TokenBudgetManager, 
    SpecialistAffinityRouter, 
    AdaptiveLoadBalancer,
    SpecialistCapabilityProfiler,
    NodeCapacityManager
} from './loadBalancer.ts';

describe('TokenBudgetManager & SpecialistAffinityRouter', () => {
    let tokenManager: TokenBudgetManager;
    let loadBalancer: AdaptiveLoadBalancer;
    let router: SpecialistAffinityRouter;

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
        router = new SpecialistAffinityRouter(tokenManager, loadBalancer);
    });

    describe('TokenBudgetManager', () => {
        it('initializes with expected default and provider-specific TPM limits', () => {
            expect(tokenManager.getTpmLimit('groq')).toBe(6000);
            expect(tokenManager.getTpmLimit('mistral')).toBe(30000);
            expect(tokenManager.getTpmLimit('gemini')).toBe(1000000);
            expect(tokenManager.getTpmLimit('unknown-provider')).toBe(30000);
        });

        it('tracks token usage within sliding window and calculates remaining budget accurately', () => {
            expect(tokenManager.getRemainingBudget('groq')).toBe(6000);
            expect(tokenManager.canAllocate('groq', 5000)).toBe(true);
            expect(tokenManager.canAllocate('groq', 7000)).toBe(false);

            tokenManager.recordUsage('groq', 4500, 'agent-1');

            expect(tokenManager.getTokensUsedInWindow('groq')).toBe(4500);
            expect(tokenManager.getRemainingBudget('groq')).toBe(1500);
            expect(tokenManager.canAllocate('groq', 2000)).toBe(false);
            expect(tokenManager.canAllocate('groq', 1000)).toBe(true);
            expect(tokenManager.getUtilizationRatio('groq')).toBeCloseTo(0.75, 2);
        });

        it('generates structured metrics across all active providers', () => {
            tokenManager.recordUsage('mistral', 6000, 'analyst-1');
            tokenManager.recordUsage('groq', 3000, 'analyst-2');

            const metrics = tokenManager.getMetrics();
            expect(metrics.mistral).toBeDefined();
            expect(metrics.mistral.tokensUsedInWindow).toBe(6000);
            expect(metrics.mistral.tokensRemainingInWindow).toBe(24000);
            expect(metrics.mistral.utilizationPercent).toBe(20);

            expect(metrics.groq).toBeDefined();
            expect(metrics.groq.tokensUsedInWindow).toBe(3000);
            expect(metrics.groq.utilizationPercent).toBe(50);
        });

        it('resets usage records and metrics on reset()', () => {
            tokenManager.recordUsage('groq', 5000);
            tokenManager.reset();
            expect(tokenManager.getTokensUsedInWindow('groq')).toBe(0);
            expect(tokenManager.getRemainingBudget('groq')).toBe(6000);
        });
    });

    describe('SpecialistAffinityRouter', () => {
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
    });

    describe('SpecialistCapabilityProfiler & Adaptive RL Routing', () => {
        let profiler: SpecialistCapabilityProfiler;

        beforeEach(() => {
            profiler = new SpecialistCapabilityProfiler({
                explorationConstant: 0.707,
                emaAlpha: 0.25,
                defaultLatencyBaselineMs: 1500
            });
        });

        it('calculates reward accurately based on success, verification quality, and latency', () => {
            // Success with high verification rating and low latency
            const rHigh = profiler.calculateReward({
                success: true,
                qualityRating: 0.95,
                durationMs: 300
            });
            expect(rHigh).toBeGreaterThan(0.85);

            // Failure should result in heavy penalty
            const rFail = profiler.calculateReward({
                success: false,
                qualityRating: 0.95,
                durationMs: 300
            });
            expect(rFail).toBe(0.05);

            // Success with low verification rating and high latency
            const rLow = profiler.calculateReward({
                success: true,
                qualityRating: 0.50,
                durationMs: 5000
            });
            expect(rLow).toBeLessThan(rHigh);
            expect(rLow).toBeGreaterThan(0.50);
        });

        it('records outcomes and updates trials, completion rate, reward EMA, and domain statistics', () => {
            profiler.recordOutcome('Security Specialist', {
                success: true,
                qualityRating: 0.95,
                durationMs: 450,
                domain: 'Security & Auth'
            });
            profiler.recordOutcome('Security Specialist', {
                success: true,
                qualityRating: 0.90,
                durationMs: 500,
                domain: 'Security & Auth'
            });

            const profile = profiler.getProfile('Security Specialist');
            expect(profile).toBeDefined();
            expect(profile?.trials).toBe(2);
            expect(profile?.successes).toBe(2);
            expect(profile?.completionRate).toBe(1.0);
            expect(profile?.averageReward).toBeGreaterThan(0.85);
            expect(profile?.domainStats['Security & Auth']).toBeDefined();
            expect(profile?.domainStats['Security & Auth'].trials).toBe(2);
        });

        it('calculates UCB1 score with exploration bonus for untried vs experienced specialists', () => {
            // Untried agent gets optimistic exploration bonus
            const untriedScore = profiler.getUcb1Score('New Specialist');
            expect(untriedScore).toBeGreaterThanOrEqual(1.5);

            // Record many successful trials for Agent A
            for (let i = 0; i < 10; i++) {
                profiler.recordOutcome('Elite Specialist', {
                    success: true,
                    qualityRating: 0.98,
                    durationMs: 200
                });
            }

            // Record repeated failures for Agent B
            for (let i = 0; i < 10; i++) {
                profiler.recordOutcome('Struggling Specialist', {
                    success: false,
                    durationMs: 3000
                });
            }

            const eliteScore = profiler.getUcb1Score('Elite Specialist');
            const strugglingScore = profiler.getUcb1Score('Struggling Specialist');

            expect(eliteScore).toBeGreaterThan(strugglingScore);
        });

        it('adaptively steers chunk routing toward specialists with higher reinforcement learning rewards', () => {
            // Configure two specialists with equal domain affinity
            const routerWithRL = new SpecialistAffinityRouter(tokenManager, loadBalancer, profiler);

            const specialists = [
                { id: 's1', role: 'Security Specialist A', provider: 'gemini' },
                { id: 's2', role: 'Security Specialist B', provider: 'gemini' }
            ];

            // Train profiler: Specialist A performs exceptionally well, Specialist B fails frequently
            for (let i = 0; i < 6; i++) {
                profiler.recordOutcome('Security Specialist A', {
                    success: true,
                    qualityRating: 0.99,
                    durationMs: 200,
                    domain: 'Security & Auth'
                });
                profiler.recordOutcome('Security Specialist B', {
                    success: false,
                    durationMs: 2500,
                    domain: 'Security & Auth'
                });
            }

            const chunks = [
                'Audit authentication JWT tokens and API keys'
            ];

            const plan = routerWithRL.planDistribution('Security verification', chunks, specialists);

            expect(plan.assignments).toHaveLength(1);
            expect(plan.assignments[0].agentRole).toBe('Security Specialist A');
            expect(plan.assignments[0].rlScore).toBeDefined();
            expect(plan.assignments[0].reason).toContain('RL UCB');
        });
    });

    describe('NodeCapacityManager', () => {
        let capacityManager: NodeCapacityManager;

        beforeEach(() => {
            capacityManager = new NodeCapacityManager({
                defaultMaxConcurrency: 4,
                nodeConcurrencyLimits: {
                    groq: 2,
                    mistral: 3,
                    gemini: 8
                }
            });
        });

        it('initializes with default and node-specific concurrency limits', () => {
            expect(capacityManager.getMaxConcurrency('groq')).toBe(2);
            expect(capacityManager.getMaxConcurrency('mistral')).toBe(3);
            expect(capacityManager.getMaxConcurrency('gemini')).toBe(8);
            expect(capacityManager.getMaxConcurrency('unregistered-node')).toBe(4);

            capacityManager.setMaxConcurrency('custom-analyst', 6);
            expect(capacityManager.getMaxConcurrency('custom-analyst')).toBe(6);
        });

        it('acquires capacity slots and decrements available headroom accurately', () => {
            expect(capacityManager.getCapacityHeadroom('groq')).toBe(2);
            expect(capacityManager.hasCapacity('groq')).toBe(true);

            const slot1 = capacityManager.tryAcquireSlot('groq');
            expect(slot1).toBeDefined();
            expect(slot1?.nodeKey).toBe('groq');
            expect(capacityManager.getActiveInFlight('groq')).toBe(1);
            expect(capacityManager.getCapacityHeadroom('groq')).toBe(1);
            expect(capacityManager.getUtilizationRatio('groq')).toBe(0.5);
            expect(capacityManager.isSaturated('groq')).toBe(false);

            const slot2 = capacityManager.tryAcquireSlot('groq');
            expect(slot2).toBeDefined();
            expect(capacityManager.getActiveInFlight('groq')).toBe(2);
            expect(capacityManager.getCapacityHeadroom('groq')).toBe(0);
            expect(capacityManager.getUtilizationRatio('groq')).toBe(1.0);
            expect(capacityManager.isSaturated('groq')).toBe(true);

            // Third acquisition should be rejected
            const slot3 = capacityManager.tryAcquireSlot('groq');
            expect(slot3).toBeNull();
        });

        it('releases slots and restores headroom via slot.release() and manager.releaseSlot()', () => {
            const slot1 = capacityManager.tryAcquireSlot('mistral');
            const slot2 = capacityManager.tryAcquireSlot('mistral');
            expect(capacityManager.getActiveInFlight('mistral')).toBe(2);

            // Release via slot helper
            slot1?.release();
            expect(capacityManager.getActiveInFlight('mistral')).toBe(1);
            expect(capacityManager.getCapacityHeadroom('mistral')).toBe(2);

            // Multiple releases on same slot are idempotent
            slot1?.release();
            expect(capacityManager.getActiveInFlight('mistral')).toBe(1);

            // Release via manager
            capacityManager.releaseSlot(slot2!);
            expect(capacityManager.getActiveInFlight('mistral')).toBe(0);
            expect(capacityManager.getCapacityHeadroom('mistral')).toBe(3);
        });

        it('reports structured metrics across nodes and resets cleanly', () => {
            const slot = capacityManager.tryAcquireSlot('gemini');
            const metrics = capacityManager.getNodeMetrics('gemini');

            expect(metrics.nodeKey).toBe('gemini');
            expect(metrics.maxConcurrency).toBe(8);
            expect(metrics.activeInFlight).toBe(1);
            expect(metrics.availableHeadroom).toBe(7);
            expect(metrics.utilizationPercent).toBe(13);
            expect(metrics.totalSlotsAcquired).toBe(1);
            expect(metrics.isSaturated).toBe(false);

            slot?.release();
            const afterRelease = capacityManager.getNodeMetrics('gemini');
            expect(afterRelease.totalSlotsReleased).toBe(1);
            expect(afterRelease.activeInFlight).toBe(0);

            capacityManager.reset();
            expect(capacityManager.getActiveInFlight('gemini')).toBe(0);
            expect(capacityManager.getNodeMetrics('gemini').totalSlotsAcquired).toBe(0);
        });
    });

    describe('Capacity-Aware Task Allocation & Spillover Routing', () => {
        let tokenManager: TokenBudgetManager;
        let loadBalancer: AdaptiveLoadBalancer;
        let profiler: SpecialistCapabilityProfiler;
        let capacityManager: NodeCapacityManager;
        let router: SpecialistAffinityRouter;

        beforeEach(() => {
            tokenManager = new TokenBudgetManager();
            loadBalancer = new AdaptiveLoadBalancer();
            profiler = new SpecialistCapabilityProfiler();
            capacityManager = new NodeCapacityManager({
                defaultMaxConcurrency: 4,
                nodeConcurrencyLimits: {
                    'sec-spec': 1, // Constrained to 1 concurrent slot
                    'sec-standby': 5,
                    groq: 2,
                    gemini: 10
                }
            });
            router = new SpecialistAffinityRouter(tokenManager, loadBalancer, profiler, capacityManager);
        });

        it('dynamically spills over tasks when primary specialist node is saturated', () => {
            const specialists = [
                { id: 'sec-spec', role: 'Security Specialist', provider: 'groq' },
                { id: 'sec-standby', role: 'Security Auditor Standby', provider: 'gemini' }
            ];

            // Saturate primary specialist node
            const activeSlot = capacityManager.tryAcquireSlot('sec-spec');
            expect(activeSlot).toBeDefined();
            expect(capacityManager.isSaturated('sec-spec')).toBe(true);

            const chunks = ['Audit authentication tokens and JWT expiration'];
            const plan = router.planDistribution('Security verification', chunks, specialists);

            expect(plan.assignments).toHaveLength(1);
            // Saturated primary specialist is bypassed, spilling over to standby node
            expect(plan.assignments[0].agentId).toBe('sec-standby');
            expect(plan.assignments[0].isSpillover).toBe(true);
            expect(plan.assignments[0].reason).toContain('Spillover reroute');

            // Free slot and verify primary is selected again
            activeSlot?.release();
            expect(capacityManager.isSaturated('sec-spec')).toBe(false);

            const normalPlan = router.planDistribution('Security verification', chunks, specialists);
            expect(normalPlan.assignments[0].agentId).toBe('sec-spec');
            expect(normalPlan.assignments[0].isSpillover).toBe(false);
        });

        it('balances multi-chunk distribution across nodes respecting concurrency limits per batch', () => {
            const specialists = [
                { id: 'sec-spec', role: 'Security Specialist', provider: 'groq' },
                { id: 'sec-standby', role: 'Security Auditor Standby', provider: 'gemini' }
            ];

            // Primary node limit is 1, so assigning 2 security chunks must distribute chunk 0 to primary and chunk 1 to standby
            const chunks = [
                'Chunk 1: Audit auth tokens and API keys',
                'Chunk 2: Verify TLS certificates and cryptographic keys'
            ];

            const plan = router.planDistribution('Security verification multi-chunk', chunks, specialists);

            expect(plan.totalChunks).toBe(2);
            expect(plan.assignments).toHaveLength(2);

            // Chunk 0 goes to primary
            expect(plan.assignments[0].agentId).toBe('sec-spec');

            // Chunk 1 spills over to standby due to primary node reaching batch capacity limit
            expect(plan.assignments[1].agentId).toBe('sec-standby');

            // Verify specialist summary reports nodeHeadroom and saturation
            expect(plan.specialistSummary['Security Specialist'].chunksAssigned).toBe(1);
            expect(plan.specialistSummary['Security Specialist'].isSaturated).toBe(true);
            expect(plan.specialistSummary['Security Auditor Standby'].chunksAssigned).toBe(1);
        });
    });
});
