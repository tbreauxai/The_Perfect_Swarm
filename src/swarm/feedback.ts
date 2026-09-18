/**
 * @file feedback.ts
 * @description Continuous feedback loops, reinforcement learning and evolutionary policy adaptation,
 * concept drift detection (Page-Hinkley test and embedding divergence), and shared knowledge repository.
 */

export interface PerformanceMetricsSnapshot {
    workflowId: string;
    task: string;
    appId: string;
    durationMs: number;
    targetTier: 'instant' | 'complex' | 'hierarchical';
    tokenSavings: number;
    tokensConsumed: number;
    qualityScore?: number; // 0.0 - 1.0
    accuracyScore?: number; // 0.0 - 1.0
    errorCount: number;
    anomalyCount: number;
    timestamp: number;
    metadata?: Record<string, any>;
}

export interface RewardWeights {
    quality: number;
    accuracy: number;
    latency: number;
    cost: number;
    tokenSavings: number;
}

export interface RewardSignal {
    compositeReward: number; // Normalized -1.0 to 1.0
    components: {
        qualityReward: number;
        accuracyReward: number;
        latencyPenalty: number;
        costPenalty: number;
        savingsReward: number;
    };
    weights: RewardWeights;
    timestamp: number;
}

export interface TunableParameters {
    cacheL1MaxEntries: number;
    cacheSemanticThreshold: number;
    compressionTargetReductionRatio: number;
    compressionSimilarityThreshold: number;
    schedulerMaxConcurrency: number;
    schedulerStarvationAgeMs: number;
    speculativeBatchThreshold: number;
    explorationFactor: number;
}

export const DEFAULT_TUNABLE_PARAMETERS: TunableParameters = {
    cacheL1MaxEntries: 100,
    cacheSemanticThreshold: 0.82,
    compressionTargetReductionRatio: 0.35,
    compressionSimilarityThreshold: 0.72,
    schedulerMaxConcurrency: 4,
    schedulerStarvationAgeMs: 5000,
    speculativeBatchThreshold: 3,
    explorationFactor: 0.15
};

export interface ParameterBounds {
    min: number;
    max: number;
    step: number;
    isInteger?: boolean;
}

export const PARAMETER_BOUNDS: Record<keyof TunableParameters, ParameterBounds> = {
    cacheL1MaxEntries: { min: 20, max: 1000, step: 10, isInteger: true },
    cacheSemanticThreshold: { min: 0.60, max: 0.98, step: 0.02 },
    compressionTargetReductionRatio: { min: 0.15, max: 0.65, step: 0.05 },
    compressionSimilarityThreshold: { min: 0.50, max: 0.95, step: 0.02 },
    schedulerMaxConcurrency: { min: 1, max: 16, step: 1, isInteger: true },
    schedulerStarvationAgeMs: { min: 1000, max: 15000, step: 500, isInteger: true },
    speculativeBatchThreshold: { min: 2, max: 10, step: 1, isInteger: true },
    explorationFactor: { min: 0.01, max: 0.50, step: 0.02 }
};

export type DriftType =
    | 'page-hinkley-latency'
    | 'page-hinkley-quality'
    | 'embedding-centroid-shift'
    | 'schema-validation-failure';

export interface DriftAlert {
    id: string;
    driftType: DriftType;
    severity: 'warning' | 'critical';
    metric: string;
    currentValue: number;
    baselineValue: number;
    threshold: number;
    recommendedAction: 're-index-memory' | 'reset-policy' | 'tighten-thresholds' | 'retrain-weights';
    timestamp: number;
    message: string;
}

export interface AnalysisOutcomeRecord {
    id: string;
    workflowId: string;
    task: string;
    appId: string;
    finalInsightSnippet: string;
    metrics: PerformanceMetricsSnapshot;
    reward: RewardSignal;
    parametersUsed: TunableParameters;
    driftAlerts: DriftAlert[];
    timestamp: number;
}

/**
 * Evaluates composite reward signals and tunes swarm policy parameters using evolutionary mutation
 * ((1+lambda)-ES) and contextual exploration-exploitation.
 */
export class PolicyOptimizer {
    private currentPolicy: TunableParameters;
    private bestPolicy: TunableParameters;
    private bestReward: number = -Infinity;
    private rewardHistory: number[] = [];
    private generation: number = 0;
    private mutationStep: number = 0.1; // Adapts via 1/5th success rule
    private successfulMutations: number = 0;
    private totalMutations: number = 0;

    private weights: RewardWeights = {
        quality: 0.35,
        accuracy: 0.35,
        latency: 0.15,
        cost: 0.05,
        tokenSavings: 0.10
    };

    public constructor(initialParameters?: Partial<TunableParameters>, weights?: Partial<RewardWeights>) {
        this.currentPolicy = { ...DEFAULT_TUNABLE_PARAMETERS, ...initialParameters };
        this.bestPolicy = { ...this.currentPolicy };
        if (weights) {
            this.weights = { ...this.weights, ...weights };
        }
    }

    public calculateReward(metrics: PerformanceMetricsSnapshot): RewardSignal {
        const quality = metrics.qualityScore ?? 0.8;
        const accuracy = metrics.accuracyScore ?? (metrics.errorCount === 0 ? 0.9 : Math.max(0.1, 1 - metrics.errorCount * 0.3));
        const normalizedLatencyPenalty = Math.min(1.0, metrics.durationMs / 3000);
        const normalizedCostPenalty = Math.min(1.0, metrics.tokensConsumed / 10000);
        const normalizedSavingsReward = Math.min(1.0, metrics.tokenSavings / 4000);

        const qualityPart = quality * this.weights.quality;
        const accuracyPart = accuracy * this.weights.accuracy;
        const latencyPart = -normalizedLatencyPenalty * this.weights.latency;
        const costPart = -normalizedCostPenalty * this.weights.cost;
        const savingsPart = normalizedSavingsReward * this.weights.tokenSavings;

        const rawReward = qualityPart + accuracyPart + latencyPart + costPart + savingsPart;
        // Bound to [-1.0, 1.0]
        const compositeReward = Math.max(-1.0, Math.min(1.0, Math.round(rawReward * 1000) / 1000));

        return {
            compositeReward,
            components: {
                qualityReward: Math.round(qualityPart * 1000) / 1000,
                accuracyReward: Math.round(accuracyPart * 1000) / 1000,
                latencyPenalty: Math.round(latencyPart * 1000) / 1000,
                costPenalty: Math.round(costPart * 1000) / 1000,
                savingsReward: Math.round(savingsPart * 1000) / 1000
            },
            weights: { ...this.weights },
            timestamp: Date.now()
        };
    }

    /**
     * Mutates a parent parameter set within defined bounds.
     */
    public mutate(parent: TunableParameters, rate: number = this.mutationStep): TunableParameters {
        const child: TunableParameters = { ...parent };
        const keys = Object.keys(PARAMETER_BOUNDS) as Array<keyof TunableParameters>;

        for (const key of keys) {
            // Apply probabilistic mutation
            if (Math.random() < 0.5) {
                const bounds = PARAMETER_BOUNDS[key];
                const span = bounds.max - bounds.min;
                // Gaussian-like perturbation (-1 to 1)
                const delta = (Math.random() - 0.5) * 2 * rate * span;
                let val = child[key] + delta;
                val = Math.max(bounds.min, Math.min(bounds.max, val));

                if (bounds.isInteger) {
                    val = Math.round(val);
                } else {
                    val = Math.round(val * 100) / 100;
                }
                child[key] = val;
            }
        }
        return child;
    }

    /**
     * Updates policy using evolutionary selection and Rechenberg's 1/5th adaptation rule.
     */
    public updateWithFeedback(reward: RewardSignal, proposedParams?: TunableParameters): {
        updated: boolean;
        currentPolicy: TunableParameters;
        generation: number;
        mutationStep: number;
    } {
        const score = reward.compositeReward;
        this.rewardHistory.push(score);
        this.generation++;
        this.totalMutations++;

        let updated = false;

        if (proposedParams && score > this.bestReward) {
            this.bestReward = score;
            this.bestPolicy = { ...proposedParams };
            this.currentPolicy = { ...proposedParams };
            this.successfulMutations++;
            updated = true;
        } else if (!proposedParams) {
            // Baseline observation
            if (score > this.bestReward || this.bestReward === -Infinity) {
                this.bestReward = score;
                this.bestPolicy = { ...this.currentPolicy };
            }
        }

        // Rechenberg 1/5 rule every 10 iterations
        if (this.totalMutations % 10 === 0) {
            const successRatio = this.successfulMutations / 10;
            if (successRatio > 0.2) {
                this.mutationStep = Math.min(0.5, this.mutationStep * 1.2);
            } else {
                this.mutationStep = Math.max(0.02, this.mutationStep * 0.8);
            }
            this.successfulMutations = 0;
        }

        return {
            updated,
            currentPolicy: { ...this.currentPolicy },
            generation: this.generation,
            mutationStep: Math.round(this.mutationStep * 1000) / 1000
        };
    }

    public proposeNextParameters(): TunableParameters {
        // Epsilon-greedy evolutionary exploration
        if (Math.random() < this.currentPolicy.explorationFactor) {
            return this.mutate(this.bestPolicy, this.mutationStep);
        }
        return { ...this.bestPolicy };
    }

    public getCurrentPolicy(): TunableParameters {
        return { ...this.currentPolicy };
    }

    public getBestPolicy(): TunableParameters {
        return { ...this.bestPolicy };
    }

    public setPolicy(params: Partial<TunableParameters>): void {
        this.currentPolicy = { ...this.currentPolicy, ...params };
        this.bestPolicy = { ...this.currentPolicy };
    }

    public reset(): void {
        this.currentPolicy = { ...DEFAULT_TUNABLE_PARAMETERS };
        this.bestPolicy = { ...this.currentPolicy };
        this.bestReward = -Infinity;
        this.rewardHistory = [];
        this.generation = 0;
        this.mutationStep = 0.1;
        this.successfulMutations = 0;
        this.totalMutations = 0;
    }
}

/**
 * Sequential statistical change-point detection (Page-Hinkley test) and embedding centroid divergence detector.
 */
export class ConceptDriftDetector {
    // Page-Hinkley parameters for latency
    private latencyMean: number = 0;
    private latencyCount: number = 0;
    private latencyCumulativeDev: number = 0;
    private latencyMinCumulative: number = 0;
    private latencyDelta: number = 5; // tolerance parameter
    private latencyThreshold: number = 60; // detection threshold

    // Page-Hinkley parameters for quality
    private qualityMean: number = 0;
    private qualityCount: number = 0;
    private qualityCumulativeDev: number = 0;
    private qualityMaxCumulative: number = 0;
    private qualityDelta: number = 0.05;
    private qualityThreshold: number = 0.35;

    // Embedding centroid tracking
    private referenceCentroid: number[] | null = null;
    private recentCentroidWindow: number[][] = [];
    private windowCapacity: number = 20;
    private centroidDriftThreshold: number = 0.80; // Cosine similarity drop below this is drift

    private alerts: DriftAlert[] = [];

    public constructor(options?: {
        latencyThreshold?: number;
        qualityThreshold?: number;
        centroidDriftThreshold?: number;
        windowCapacity?: number;
    }) {
        if (options?.latencyThreshold) this.latencyThreshold = options.latencyThreshold;
        if (options?.qualityThreshold) this.qualityThreshold = options.qualityThreshold;
        if (options?.centroidDriftThreshold) this.centroidDriftThreshold = options.centroidDriftThreshold;
        if (options?.windowCapacity) this.windowCapacity = options.windowCapacity;
    }

    /**
     * Page-Hinkley test for upward latency drift.
     */
    public recordLatencyObservation(durationMs: number): DriftAlert | null {
        this.latencyCount++;
        this.latencyMean += (durationMs - this.latencyMean) / this.latencyCount;
        this.latencyCumulativeDev += (durationMs - this.latencyMean - this.latencyDelta);

        if (this.latencyCumulativeDev < this.latencyMinCumulative) {
            this.latencyMinCumulative = this.latencyCumulativeDev;
        }

        const phStatistic = this.latencyCumulativeDev - this.latencyMinCumulative;

        if (phStatistic > this.latencyThreshold) {
            const alert: DriftAlert = {
                id: Math.random().toString(36).substring(2, 9),
                driftType: 'page-hinkley-latency',
                severity: phStatistic > this.latencyThreshold * 1.5 ? 'critical' : 'warning',
                metric: 'durationMs',
                currentValue: durationMs,
                baselineValue: Math.round(this.latencyMean),
                threshold: this.latencyThreshold,
                recommendedAction: 'tighten-thresholds',
                timestamp: Date.now(),
                message: `Latency concept drift detected: PH-statistic ${Math.round(phStatistic)} exceeded threshold ${this.latencyThreshold}`
            };
            this.alerts.push(alert);
            // Reset sequential detector
            this.latencyCumulativeDev = 0;
            this.latencyMinCumulative = 0;
            return alert;
        }
        return null;
    }

    /**
     * Page-Hinkley test for downward quality drift.
     */
    public recordQualityObservation(qualityScore: number): DriftAlert | null {
        this.qualityCount++;
        this.qualityMean += (qualityScore - this.qualityMean) / this.qualityCount;
        // Tracking downward drop
        this.qualityCumulativeDev += (this.qualityMean - qualityScore - this.qualityDelta);

        if (this.qualityCumulativeDev < this.qualityMaxCumulative) {
            this.qualityMaxCumulative = this.qualityCumulativeDev;
        }

        const phStatistic = this.qualityCumulativeDev - this.qualityMaxCumulative;

        if (phStatistic > this.qualityThreshold) {
            const alert: DriftAlert = {
                id: Math.random().toString(36).substring(2, 9),
                driftType: 'page-hinkley-quality',
                severity: phStatistic > this.qualityThreshold * 1.5 ? 'critical' : 'warning',
                metric: 'qualityScore',
                currentValue: Math.round(qualityScore * 100) / 100,
                baselineValue: Math.round(this.qualityMean * 100) / 100,
                threshold: this.qualityThreshold,
                recommendedAction: 'reset-policy',
                timestamp: Date.now(),
                message: `Quality degradation drift detected: PH-statistic ${Math.round(phStatistic * 100) / 100} exceeded threshold ${this.qualityThreshold}`
            };
            this.alerts.push(alert);
            this.qualityCumulativeDev = 0;
            this.qualityMaxCumulative = 0;
            return alert;
        }
        return null;
    }

    /**
     * Records embedding and evaluates vector divergence from reference centroid.
     */
    public recordEmbeddingObservation(vector: number[]): DriftAlert | null {
        if (!vector || vector.length === 0) return null;

        if (!this.referenceCentroid) {
            this.referenceCentroid = [...vector];
            return null;
        }

        this.recentCentroidWindow.push(vector);
        if (this.recentCentroidWindow.length > this.windowCapacity) {
            this.recentCentroidWindow.shift();
        }

        if (this.recentCentroidWindow.length >= 5) {
            const currentCentroid = this.calculateCentroid(this.recentCentroidWindow);
            const sim = this.cosineSimilarity(this.referenceCentroid, currentCentroid);

            if (sim < this.centroidDriftThreshold) {
                const alert: DriftAlert = {
                    id: Math.random().toString(36).substring(2, 9),
                    driftType: 'embedding-centroid-shift',
                    severity: sim < this.centroidDriftThreshold - 0.15 ? 'critical' : 'warning',
                    metric: 'centroidCosineSimilarity',
                    currentValue: Math.round(sim * 1000) / 1000,
                    baselineValue: 1.0,
                    threshold: this.centroidDriftThreshold,
                    recommendedAction: 're-index-memory',
                    timestamp: Date.now(),
                    message: `Semantic concept drift detected: Centroid similarity ${Math.round(sim * 1000) / 1000} fell below ${this.centroidDriftThreshold}`
                };
                this.alerts.push(alert);
                // Update reference centroid to absorb new regime
                this.referenceCentroid = currentCentroid;
                return alert;
            }
        }
        return null;
    }

    /**
     * Validates incoming data payload for structural soundness and anomaly limits.
     */
    public validateDataPayload(data: any): { valid: boolean; issues: string[] } {
        const issues: string[] = [];

        if (data === undefined || data === null) {
            issues.push('Payload is null or undefined');
            return { valid: false, issues };
        }

        if (typeof data === 'string') {
            if (data.trim().length === 0) {
                issues.push('Payload string is empty');
            } else if (data.length > 2_000_000) {
                issues.push(`Payload length (${data.length} chars) exceeds maximum safety limit`);
            }
        } else if (typeof data === 'object') {
            const keys = Object.keys(data);
            if (keys.length === 0 && !Array.isArray(data)) {
                issues.push('Payload object is empty');
            }
        }

        return {
            valid: issues.length === 0,
            issues
        };
    }

    private calculateCentroid(vectors: number[][]): number[] {
        const dim = vectors[0].length;
        const centroid = new Array(dim).fill(0);
        for (const v of vectors) {
            for (let d = 0; d < dim; d++) {
                centroid[d] += (v[d] || 0) / vectors.length;
            }
        }
        return centroid;
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = vecA[i] || 0;
            const b = vecB[i] || 0;
            dot += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    public getAlerts(): DriftAlert[] {
        return [...this.alerts];
    }

    public clearAlerts(): void {
        this.alerts = [];
    }

    public reset(): void {
        this.latencyMean = 0;
        this.latencyCount = 0;
        this.latencyCumulativeDev = 0;
        this.latencyMinCumulative = 0;
        this.qualityMean = 0;
        this.qualityCount = 0;
        this.qualityCumulativeDev = 0;
        this.qualityMaxCumulative = 0;
        this.referenceCentroid = null;
        this.recentCentroidWindow = [];
        this.alerts = [];
    }
}

/**
 * Shared knowledge repository that persists and indexes analysis outcomes, rewards, and policy evolutions.
 */
export class SwarmKnowledgeRepository {
    private outcomes: Map<string, AnalysisOutcomeRecord> = new Map();
    private appIndices: Map<string, string[]> = new Map();
    private policyGenealogy: Array<{
        timestamp: number;
        generation: number;
        policy: TunableParameters;
        reward: number;
    }> = [];

    public async recordOutcome(record: AnalysisOutcomeRecord): Promise<string> {
        this.outcomes.set(record.id, record);

        if (!this.appIndices.has(record.appId)) {
            this.appIndices.set(record.appId, []);
        }
        this.appIndices.get(record.appId)!.push(record.id);

        return record.id;
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

/**
 * Master coordinator orchestrating the continuous feedback loop, parameter auto-tuning,
 * concept drift detection, and shared knowledge repository.
 */
export class ContinuousFeedbackEngine {
    private static instance: ContinuousFeedbackEngine;
    private policyOptimizer: PolicyOptimizer;
    private driftDetector: ConceptDriftDetector;
    private repository: SwarmKnowledgeRepository;

    public constructor(options?: {
        initialParameters?: Partial<TunableParameters>;
        rewardWeights?: Partial<RewardWeights>;
    }) {
        this.policyOptimizer = new PolicyOptimizer(options?.initialParameters, options?.rewardWeights);
        this.driftDetector = new ConceptDriftDetector();
        this.repository = new SwarmKnowledgeRepository();
    }

    public static getInstance(): ContinuousFeedbackEngine {
        if (!ContinuousFeedbackEngine.instance) {
            ContinuousFeedbackEngine.instance = new ContinuousFeedbackEngine();
        }
        return ContinuousFeedbackEngine.instance;
    }

    public async processFeedback(params: {
        workflowId: string;
        task: string;
        appId?: string;
        durationMs: number;
        targetTier: 'instant' | 'complex' | 'hierarchical';
        tokenSavings?: number;
        tokensConsumed?: number;
        qualityScore?: number;
        accuracyScore?: number;
        errorCount?: number;
        anomalyCount?: number;
        finalInsightSnippet?: string;
        embedding?: number[];
        inputData?: any;
    }): Promise<{
        reward: RewardSignal;
        tunedParameters: TunableParameters;
        driftAlerts: DriftAlert[];
        outcomeId: string;
        policyUpdated: boolean;
    }> {
        const appId = params.appId || 'perfect-swarm';
        const metrics: PerformanceMetricsSnapshot = {
            workflowId: params.workflowId,
            task: params.task,
            appId,
            durationMs: params.durationMs,
            targetTier: params.targetTier,
            tokenSavings: params.tokenSavings ?? 0,
            tokensConsumed: params.tokensConsumed ?? 0,
            qualityScore: params.qualityScore,
            accuracyScore: params.accuracyScore,
            errorCount: params.errorCount ?? 0,
            anomalyCount: params.anomalyCount ?? 0,
            timestamp: Date.now()
        };

        // 1. Calculate Reward Signal
        const reward = this.policyOptimizer.calculateReward(metrics);

        // 2. Evaluate Concept Drift
        const activeAlerts: DriftAlert[] = [];
        const latAlert = this.driftDetector.recordLatencyObservation(metrics.durationMs);
        if (latAlert) activeAlerts.push(latAlert);

        if (metrics.qualityScore !== undefined) {
            const qualAlert = this.driftDetector.recordQualityObservation(metrics.qualityScore);
            if (qualAlert) activeAlerts.push(qualAlert);
        }

        if (params.embedding) {
            const embAlert = this.driftDetector.recordEmbeddingObservation(params.embedding);
            if (embAlert) activeAlerts.push(embAlert);
        }

        if (params.inputData) {
            const valRes = this.driftDetector.validateDataPayload(params.inputData);
            if (!valRes.valid) {
                activeAlerts.push({
                    id: Math.random().toString(36).substring(2, 9),
                    driftType: 'schema-validation-failure',
                    severity: 'warning',
                    metric: 'inputData',
                    currentValue: 0,
                    baselineValue: 1,
                    threshold: 1,
                    recommendedAction: 'tighten-thresholds',
                    timestamp: Date.now(),
                    message: `Data validation failure: ${valRes.issues.join(', ')}`
                });
            }
        }

        // 3. Propose & Update Policy
        const proposed = this.policyOptimizer.proposeNextParameters();
        const updateResult = this.policyOptimizer.updateWithFeedback(reward, proposed);

        if (updateResult.updated) {
            this.repository.recordPolicyEvolution(updateResult.generation, updateResult.currentPolicy, reward.compositeReward);
        }

        // 4. Log to Shared Knowledge Repository
        const outcomeId = `outcome-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const record: AnalysisOutcomeRecord = {
            id: outcomeId,
            workflowId: params.workflowId,
            task: params.task,
            appId,
            finalInsightSnippet: params.finalInsightSnippet || '',
            metrics,
            reward,
            parametersUsed: updateResult.currentPolicy,
            driftAlerts: activeAlerts,
            timestamp: Date.now()
        };

        await this.repository.recordOutcome(record);

        return {
            reward,
            tunedParameters: updateResult.currentPolicy,
            driftAlerts: activeAlerts,
            outcomeId,
            policyUpdated: updateResult.updated
        };
    }

    public getPolicyOptimizer(): PolicyOptimizer {
        return this.policyOptimizer;
    }

    public getDriftDetector(): ConceptDriftDetector {
        return this.driftDetector;
    }

    public getKnowledgeRepository(): SwarmKnowledgeRepository {
        return this.repository;
    }

    public reset(): void {
        this.policyOptimizer.reset();
        this.driftDetector.reset();
        this.repository.clear();
    }
}

export const globalFeedbackEngine = ContinuousFeedbackEngine.getInstance();
