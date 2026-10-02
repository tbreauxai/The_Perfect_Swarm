import type { AnalysisOutcomeRecord, TunableParameters } from './types.ts';
import { DEFAULT_TUNABLE_PARAMETERS } from './types.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';
export class SwarmKnowledgeRepository {
    private outcomes: Map<string, AnalysisOutcomeRecord> = new Map();
    private appIndices: Map<string, string[]> = new Map();
    private policyGenealogy: Array<{
        timestamp: number;
        generation: number;
        policy: TunableParameters;
        reward: number;
    }> = [];
    private learningStore: QdrantLearningStore | null = null;

    /** Attach durable persistence (Qdrant). Writes become fire-and-forget; reads stay in-memory. */
    public setLearningStore(store: QdrantLearningStore | null): void {
        this.learningStore = store;
    }

    public getLearningStore(): QdrantLearningStore | null {
        return this.learningStore;
    }

    public async recordOutcome(record: AnalysisOutcomeRecord): Promise<string> {
        this.outcomes.set(record.id, record);

        if (!this.appIndices.has(record.appId)) {
            this.appIndices.set(record.appId, []);
        }
        const ids = this.appIndices.get(record.appId)!;
        if (!ids.includes(record.id)) {
            ids.push(record.id);
        }

        this.persistOutcome(record);
        return record.id;
    }

    /** Re-persist an already-recorded outcome (e.g. after feedback mutates it). Idempotent. */
    public persistOutcome(record: AnalysisOutcomeRecord): void {
        if (!this.learningStore || !record) return;
        this.learningStore.saveOutcome(record as unknown as Record<string, any>)
            .catch((err) => console.warn('[SwarmKnowledgeRepository] Outcome persist failed:', err?.message || err));
    }

    public recordPolicyEvolution(generation: number, policy: TunableParameters, reward: number): void {
        this.policyGenealogy.push({
            timestamp: Date.now(),
            generation,
            policy: { ...policy },
            reward
        });
        if (this.policyGenealogy.length > 200) {
            this.policyGenealogy.shift();
        }
        if (this.learningStore) {
            this.learningStore.savePolicyGeneration(generation, policy, reward)
                .catch((err) => console.warn('[SwarmKnowledgeRepository] Policy persist failed:', err?.message || err));
        }
    }

    /**
     * Restore outcomes + policy genealogy from durable storage into the in-memory maps.
     * Safe to call on a fresh boot; merges without duplicating existing entries.
     * Returns the number of outcome records restored.
     */
    public async restoreFromLearningStore(): Promise<number> {
        if (!this.learningStore) return 0;
        const state = await this.learningStore.loadAll();
        let restored = 0;
        for (const raw of state.outcomes) {
            if (!raw || !raw.id || this.outcomes.has(String(raw.id))) continue;
            const record = raw as AnalysisOutcomeRecord;
            this.outcomes.set(record.id, record);
            if (!this.appIndices.has(record.appId)) {
                this.appIndices.set(record.appId, []);
            }
            const ids = this.appIndices.get(record.appId)!;
            if (!ids.includes(record.id)) {
                ids.push(record.id);
            }
            restored++;
        }
        for (const p of state.policies) {
            if (this.policyGenealogy.some((g) => g.generation === p.generation)) continue;
            this.policyGenealogy.push({
                timestamp: p.timestamp || Date.now(),
                generation: p.generation,
                policy: p.policy,
                reward: p.reward
            });
        }
        this.policyGenealogy.sort((a, b) => a.generation - b.generation);
        while (this.policyGenealogy.length > 200) {
            this.policyGenealogy.shift();
        }
        return restored;
    }

    public getOutcome(id: string): AnalysisOutcomeRecord | undefined {
        return this.outcomes.get(id);
    }

    public queryOutcomes(filter?: {
        appId?: string;
        minQuality?: number;
        minReward?: number;
        limit?: number;
    }): AnalysisOutcomeRecord[] {
        let list: AnalysisOutcomeRecord[];

        if (filter?.appId && this.appIndices.has(filter.appId)) {
            const ids = this.appIndices.get(filter.appId)!;
            list = ids.map(id => this.outcomes.get(id)!).filter(Boolean);
        } else {
            list = Array.from(this.outcomes.values());
        }

        if (filter?.minQuality !== undefined) {
            list = list.filter(r => (r.metrics.qualityScore ?? 0) >= filter.minQuality!);
        }

        if (filter?.minReward !== undefined) {
            list = list.filter(r => r.reward.compositeReward >= filter.minReward!);
        }

        // Sort descending by timestamp
        list.sort((a, b) => b.timestamp - a.timestamp);

        if (filter?.limit && filter.limit > 0) {
            list = list.slice(0, filter.limit);
        }

        return list;
    }

    public getAggregatedInsights(appId?: string): {
        totalRuns: number;
        avgReward: number;
        avgDurationMs: number;
        totalTokensSaved: number;
        driftAlertsCount: number;
        bestParameters: TunableParameters;
    } {
        const outcomes = this.queryOutcomes({ appId });
        if (outcomes.length === 0) {
            return {
                totalRuns: 0,
                avgReward: 0,
                avgDurationMs: 0,
                totalTokensSaved: 0,
                driftAlertsCount: 0,
                bestParameters: { ...DEFAULT_TUNABLE_PARAMETERS }
            };
        }

        let totalReward = 0;
        let totalDuration = 0;
        let totalSaved = 0;
        let driftCount = 0;
        let bestScore = -Infinity;
        let bestParams = { ...DEFAULT_TUNABLE_PARAMETERS };

        for (const o of outcomes) {
            totalReward += o.reward.compositeReward;
            totalDuration += o.metrics.durationMs;
            totalSaved += o.metrics.tokenSavings;
            driftCount += o.driftAlerts.length;

            if (o.reward.compositeReward > bestScore) {
                bestScore = o.reward.compositeReward;
                bestParams = { ...o.parametersUsed };
            }
        }

        return {
            totalRuns: outcomes.length,
            avgReward: Math.round((totalReward / outcomes.length) * 1000) / 1000,
            avgDurationMs: Math.round(totalDuration / outcomes.length),
            totalTokensSaved: totalSaved,
            driftAlertsCount: driftCount,
            bestParameters: bestParams
        };
    }

    public getPolicyGenealogy(): Array<{ timestamp: number; generation: number; policy: TunableParameters; reward: number }> {
        return [...this.policyGenealogy];
    }

    public clear(): void {
        this.outcomes.clear();
        this.appIndices.clear();
        this.policyGenealogy = [];
    }
}
