import { ProviderTelemetry, LoadBalancerConfig, TokenBudgetConfig, TokenUsageRecord, TokenBudgetMetrics, NodeCapacityConfig, CapacitySlot, NodeCapacityMetrics, SpecialistOutcomeFeedback, DomainCapabilityStats, SpecialistCapabilityProfile, CapabilityProfilerConfig, SpecialistDomainRule, ChunkAssignment, SpecialistRoutingPlan, SpecialistCandidate, ProviderHealthStatus } from "./types.ts";

/**
 * Reinforcement Learning Specialist Capability Profiler.
 * Uses Multi-Armed Bandit with Upper Confidence Bound (UCB1) reward scoring
 * to adaptively schedule specialist agents based on historical verification ratings,
 * task completion rates, domain affinity outcomes, and latency.
 */
export class SpecialistCapabilityProfiler {
    private profiles: Map<string, SpecialistCapabilityProfile> = new Map();
    private explorationConstant: number;
    private emaAlpha: number;
    private defaultLatencyBaselineMs: number;
    private totalTrials: number = 0;

    constructor(config?: CapabilityProfilerConfig) {
        this.explorationConstant = config?.explorationConstant ?? 0.707;
        this.emaAlpha = config?.emaAlpha ?? 0.25;
        this.defaultLatencyBaselineMs = config?.defaultLatencyBaselineMs ?? 1500;
    }

    private getOrCreateProfile(agentRole: string): SpecialistCapabilityProfile {
        const key = (agentRole || '').trim();
        let profile = this.profiles.get(key);
        if (!profile) {
            profile = {
                agentRole: key,
                trials: 0,
                successes: 0,
                failures: 0,
                completionRate: 1.0,
                totalReward: 0,
                averageReward: 0.85,
                latencyEmaMs: this.defaultLatencyBaselineMs,
                domainStats: {},
                lastUpdated: Date.now()
            };
            this.profiles.set(key, profile);
        }

        return profile;
    }

    /**
     * Computes the normalized reinforcement learning reward R in [0.0, 1.0]
     * factoring in task completion, verification quality rating, and execution latency.
     */
    calculateReward(feedback: SpecialistOutcomeFeedback): number {
        if (!feedback.success) {
            return 0.05; // heavily penalized for failures/exceptions
        }

        const quality = Math.min(1.0, Math.max(0.0, feedback.qualityRating ?? 0.85));
        const latency = feedback.durationMs ?? this.defaultLatencyBaselineMs;
        const latencyRatio = Math.max(0, 1.0 - (latency / (this.defaultLatencyBaselineMs * 3)));
        const reward = 0.50 + (quality * 0.35) + (latencyRatio * 0.15);
        return Math.min(1.0, Math.max(0.05, Math.round(reward * 1000) / 1000));
    }

    /**
     * Records execution outcome feedback and updates reinforcement learning capability profiles.
     */
    recordOutcome(agentRole: string, feedback: SpecialistOutcomeFeedback | number): void {
        const key = (agentRole || '').trim();
        if (!key) return;
        const profile = this.getOrCreateProfile(key);
        const fb: SpecialistOutcomeFeedback = typeof feedback === 'number'
                        ? { success: feedback > 0.3, qualityRating: feedback }
                        : feedback;
        const reward = this.calculateReward(fb);
        const now = Date.now();
        profile.trials++;
        this.totalTrials++;
        if (fb.success) {
            profile.successes++;
        } else {
            profile.failures++;
        }

        profile.completionRate = profile.trials > 0
        ? Math.round((profile.successes / profile.trials) * 100) / 100
        : 1.0;
        profile.totalReward += reward;
        profile.averageReward = Math.round((profile.totalReward / profile.trials) * 1000) / 1000;
        if (fb.durationMs !== undefined && fb.durationMs > 0) {
            profile.latencyEmaMs = Math.round(
                (profile.latencyEmaMs * (1 - this.emaAlpha)) + (fb.durationMs * this.emaAlpha)
            );
        }

        if (fb.domain) {
            let ds = profile.domainStats[fb.domain];
            if (!ds) {
                ds = {
                    trials: 0,
                    successes: 0,
                    totalReward: 0,
                    averageReward: 0.85,
                    lastUpdated: now
                };
                profile.domainStats[fb.domain] = ds;
            }
            ds.trials++;
            if (fb.success) ds.successes++;
            ds.totalReward += reward;
            ds.averageReward = Math.round((ds.totalReward / ds.trials) * 1000) / 1000;
            ds.lastUpdated = now;
        }

        profile.lastUpdated = now;
    }

    /**
     * Calculates Upper Confidence Bound (UCB1) capability score for an agent role.
     * Balances empirical performance (exploitation) with exploration uncertainty.
     */
    getUcb1Score(agentRole: string, domain?: string): number {
        const profile = this.getOrCreateProfile(agentRole);
        if (profile.trials === 0) {
            return 1.0 + this.explorationConstant;
        }

        const totalN = Math.max(1, this.totalTrials);
        const agentN = profile.trials;
        let meanReward = profile.averageReward;
        if (domain && profile.domainStats[domain] && profile.domainStats[domain].trials > 0) {
            const ds = profile.domainStats[domain];
            meanReward = (ds.averageReward * 0.70) + (profile.averageReward * 0.30);
        }

        const explorationBonus = this.explorationConstant * Math.sqrt((2 * Math.log(totalN)) / agentN);
        const ucb = meanReward + explorationBonus;
        return Math.round(ucb * 1000) / 1000;
    }

    /**
     * Calculates empirical capability score based on verification rewards and task completion rate
     * without Multi-Armed Bandit exploration inflation. Ideal for stable cluster lead election.
     */
    getCapabilityScore(agentRole: string, domain?: string): number {
        const profile = this.profiles.get((agentRole || '').trim());
        if (!profile || profile.trials === 0) {
            return 0.85;
        }

        let meanReward = profile.averageReward;
        if (domain && profile.domainStats[domain] && profile.domainStats[domain].trials > 0) {
            const ds = profile.domainStats[domain];
            meanReward = (ds.averageReward * 0.70) + (profile.averageReward * 0.30);
        }

        return Math.round(meanReward * profile.completionRate * 1000) / 1000;
    }

    getProfile(agentRole: string): SpecialistCapabilityProfile | undefined {
        const p = this.profiles.get((agentRole || '').trim());
        if (!p) return undefined;
        return {
            ...p,
            domainStats: { ...p.domainStats }
        };
    }

    getAllProfiles(): Record<string, SpecialistCapabilityProfile> {
        const result: Record<string, SpecialistCapabilityProfile> = {};
        for (const [k, p] of this.profiles.entries()) {
            result[k] = {
                ...p,
                domainStats: { ...p.domainStats }
            };
        }

        return result;
    }

    reset(): void {
        this.profiles.clear();
        this.totalTrials = 0;
    }
}
