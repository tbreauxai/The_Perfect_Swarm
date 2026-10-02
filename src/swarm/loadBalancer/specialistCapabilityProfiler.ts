import { QdrantLearningStore } from '../learning-persistence.ts';
export interface SpecialistOutcomeFeedback {
    success: boolean;
    qualityRating?: number;   // 0.0 to 1.0 (from critic or default 0.85)
    durationMs?: number;      // Execution latency
    domain?: string;          // Matched domain (e.g. 'Security & Auth', 'Performance & Latency')
    tokensUsed?: number;
    error?: string;
}

export interface DomainCapabilityStats {
    trials: number;
    successes: number;
    totalReward: number;
    averageReward: number;
    lastUpdated: number;
}

export interface SpecialistCapabilityProfile {
    agentRole: string;
    trials: number;
    successes: number;
    failures: number;
    completionRate: number;      // 0.0 to 1.0
    totalReward: number;
    averageReward: number;       // Empirical mean reward
    latencyEmaMs: number;
    domainStats: Record<string, DomainCapabilityStats>;
    accuracyWins: number;
    accuracyLosses: number;
    accuracyPushes: number;
    accuracyScore: number;       // 0.0 to 1.0 (historical accuracy from win/loss/push outcomes)
    totalAccreditedOutcomes: number;
    lastUpdated: number;
}

export interface CapabilityProfilerConfig {
    explorationConstant?: number;      // c in UCB1 formula: UCB1 = mu_i + c * sqrt(2 * ln(N) / N_i), default 0.707
    emaAlpha?: number;                 // Smoothing factor for latency EMA (default 0.25)
    defaultLatencyBaselineMs?: number; // Latency normalization baseline (default 1500ms)
    defaultAccuracyWeight?: number;    // Weight of prediction accuracy in capability score [0.0, 1.0] (default 0.30)
}

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
    private defaultAccuracyWeight: number;
    private totalTrials: number = 0;
    private learningStore: QdrantLearningStore | null = null;

    constructor(config?: CapabilityProfilerConfig) {
        this.explorationConstant = config?.explorationConstant ?? 0.707;
        this.emaAlpha = config?.emaAlpha ?? 0.25;
        this.defaultLatencyBaselineMs = config?.defaultLatencyBaselineMs ?? 1500;
        this.defaultAccuracyWeight = config?.defaultAccuracyWeight ?? 0.30;
    }

    /** Attach durable persistence (Qdrant). Writes become fire-and-forget; reads stay in-memory. */
    public setLearningStore(store: QdrantLearningStore | null): void {
        this.learningStore = store;
    }

    public getLearningStore(): QdrantLearningStore | null {
        return this.learningStore;
    }

    /**
     * Merge persisted profiles into the in-memory map. For each role, keeps the
     * entry with the most accredited outcomes (safe against double-restore).
     * Returns the number of roles restored.
     */
    public importProfiles(profiles: Record<string, SpecialistCapabilityProfile>): number {
        let count = 0;
        for (const [role, incoming] of Object.entries(profiles || {})) {
            if (!role || !incoming || typeof incoming !== 'object') continue;
            const existing = this.profiles.get(role);
            const incomingOutcomes = Number((incoming as any).totalAccreditedOutcomes || 0);
            const existingOutcomes = Number(existing?.totalAccreditedOutcomes || 0);
            if (!existing || incomingOutcomes >= existingOutcomes) {
                this.profiles.set(role, {
                    ...(incoming as SpecialistCapabilityProfile),
                    domainStats: { ...((incoming as any).domainStats || {}) }
                });
                count++;
            }
        }
        return count;
    }

    /**
     * Restore accuracy profiles from durable storage into the in-memory map.
     * Safe to call on a fresh boot. Returns the number of roles restored.
     */
    public async restoreFromLearningStore(): Promise<number> {
        if (!this.learningStore) return 0;
        const state = await this.learningStore.loadAll();
        return this.importProfiles(state.profiles as Record<string, SpecialistCapabilityProfile>);
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
                accuracyWins: 0,
                accuracyLosses: 0,
                accuracyPushes: 0,
                accuracyScore: 0.85,
                totalAccreditedOutcomes: 0,
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

        // Reward composition: 50% success base + 35% verification quality + 15% latency efficiency
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
     * Records prediction/bet outcome accuracy (win, loss, push) for an analyst role.
     * Distinct from execution reliability: does not penalize execution completion rate or mark failures.
     */
    recordAccuracy(agentRole: string, outcome: 'win' | 'loss' | 'push' | number): void {
        const key = (agentRole || '').trim();
        if (!key) return;

        const profile = this.getOrCreateProfile(key);

        if (outcome === 'win' || outcome === 1) {
            profile.accuracyWins++;
        } else if (outcome === 'loss' || outcome === 0) {
            profile.accuracyLosses++;
        } else if (outcome === 'push' || outcome === 0.5) {
            profile.accuracyPushes++;
        } else if (typeof outcome === 'number') {
            if (outcome >= 0.7) profile.accuracyWins++;
            else if (outcome <= 0.3) profile.accuracyLosses++;
            else profile.accuracyPushes++;
        } else {
            return;
        }

        profile.totalAccreditedOutcomes++;
        const total = profile.totalAccreditedOutcomes;
        const totalScore = (profile.accuracyWins * 1.0) + (profile.accuracyPushes * 0.5);
        profile.accuracyScore = Math.round((totalScore / Math.max(1, total)) * 1000) / 1000;
        profile.lastUpdated = Date.now();

        if (this.learningStore) {
            this.learningStore.saveProfile(key, profile as unknown as Record<string, any>)
                .catch((err) => console.warn('[SpecialistCapabilityProfiler] Profile persist failed:', err?.message || err));
        }
    }

    /**
     * Calculates Upper Confidence Bound (UCB1) capability score for an agent role.
     * Balances empirical performance (exploitation) with exploration uncertainty.
     */
    getUcb1Score(agentRole: string, domain?: string): number {
        const profile = this.getOrCreateProfile(agentRole);

        // Untried specialists receive an optimistic exploration bonus to ensure trial
        if (profile.trials === 0) {
            return 1.0 + this.explorationConstant;
        }

        const totalN = Math.max(1, this.totalTrials);
        const agentN = profile.trials;

        // Exploitation component: blend domain-specific performance with overall average
        let meanReward = profile.averageReward;
        if (domain && profile.domainStats[domain] && profile.domainStats[domain].trials > 0) {
            const ds = profile.domainStats[domain];
            meanReward = (ds.averageReward * 0.70) + (profile.averageReward * 0.30);
        }

        if (profile.totalAccreditedOutcomes > 0 && this.defaultAccuracyWeight > 0) {
            meanReward = (meanReward * (1 - this.defaultAccuracyWeight)) + (profile.accuracyScore * this.defaultAccuracyWeight);
        }

        // Exploration component: c * sqrt(2 * ln(N) / N_i)
        const explorationBonus = this.explorationConstant * Math.sqrt((2 * Math.log(totalN)) / agentN);
        const ucb = meanReward + explorationBonus;

        return Math.round(ucb * 1000) / 1000;
    }

    /**
     * Calculates empirical capability score based on verification rewards and task completion rate
     * without Multi-Armed Bandit exploration inflation. Blends prediction accuracy when historical outcomes exist.
     */
    getCapabilityScore(agentRole: string, domain?: string, options?: { accuracyWeight?: number }): number {
        const profile = this.profiles.get((agentRole || '').trim());
        if (!profile || profile.trials === 0) {
            if (profile && profile.totalAccreditedOutcomes > 0) {
                return profile.accuracyScore;
            }
            return 0.85;
        }

        let meanReward = profile.averageReward;
        if (domain && profile.domainStats[domain] && profile.domainStats[domain].trials > 0) {
            const ds = profile.domainStats[domain];
            meanReward = (ds.averageReward * 0.70) + (profile.averageReward * 0.30);
        }

        const executionScore = meanReward * profile.completionRate;
        const weight = options?.accuracyWeight ?? this.defaultAccuracyWeight;

        if (profile.totalAccreditedOutcomes > 0 && weight > 0) {
            const blended = (executionScore * (1 - weight)) + (profile.accuracyScore * weight);
            return Math.round(blended * 1000) / 1000;
        }

        return Math.round(executionScore * 1000) / 1000;
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

export const globalSpecialistProfiler = new SpecialistCapabilityProfiler();
