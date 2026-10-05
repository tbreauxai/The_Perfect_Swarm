import type {
    PerformanceMetricsSnapshot,
    RewardSignal,
    RewardWeights,
    TunableParameters,
    DriftAlert,
    AnalysisOutcomeRecord,
    GradedOutcomeObservation,
    CalibrationResult
} from './types.ts';
import { PolicyOptimizer } from './policyOptimizer.ts';
import { ConceptDriftDetector } from './conceptDriftDetector.ts';
import { SwarmKnowledgeRepository } from './knowledgeRepository.ts';
import { QdrantLearningStore } from '../learning-persistence.ts';
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
        hardErrorCount?: number;
        failoverCount?: number;
        anomalyCount?: number;
        finalInsightSnippet?: string;
        embedding?: number[];
        inputData?: any;
        agentRoles?: string[];
        parametersUsed?: TunableParameters;
    }): Promise<{
        reward: RewardSignal;
        tunedParameters: TunableParameters;
        driftAlerts: DriftAlert[];
        outcomeId: string;
        policyUpdated: boolean;
    }> {
        const appId = params.appId || 'perfect-swarm';
        const failoverCount = params.failoverCount ?? 0;
        const hardErrorCount = params.hardErrorCount !== undefined
            ? params.hardErrorCount
            : (params.errorCount !== undefined ? Math.max(0, params.errorCount - failoverCount) : 0);

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
            errorCount: params.errorCount ?? hardErrorCount,
            hardErrorCount,
            failoverCount,
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
                    id: crypto.randomUUID(),
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
        const parametersUsed = params.parametersUsed || this.policyOptimizer.getCurrentPolicy();
        const updateResult = this.policyOptimizer.updateWithFeedback(reward, parametersUsed, proposed);

        if (updateResult.updated) {
            this.repository.recordPolicyEvolution(updateResult.generation, updateResult.currentPolicy, reward.compositeReward);
        }

        // 4. Log to Shared Knowledge Repository
        const outcomeId = `outcome-${Date.now()}-${crypto.randomUUID()}`;
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
            agentRoles: params.agentRoles || [],
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

    public getRewardWeights(): RewardWeights {
        return this.policyOptimizer.getWeights();
    }

    public setRewardWeights(weights: Partial<RewardWeights>): void {
        this.policyOptimizer.setWeights(weights);
    }

    public calibrateRewardWeights(
        observations: GradedOutcomeObservation[],
        options?: { iterations?: number; autoApply?: boolean }
    ): CalibrationResult {
        return this.policyOptimizer.calibrateRewardWeights(observations, options);
    }

    public calibrateFromKnowledgeRepository(options?: {
        appId?: string;
        minSamples?: number;
        iterations?: number;
        autoApply?: boolean;
    }): CalibrationResult | null {
        const minSamples = options?.minSamples ?? 5;
        const allOutcomes = this.repository.queryOutcomes({ appId: options?.appId, limit: 1000 });
        const graded = allOutcomes.filter((o: any) => o.feedbackProcessed && o.metrics?.accuracyScore !== undefined);
        if (graded.length < minSamples) {
            return null;
        }

        const observations: GradedOutcomeObservation[] = graded.map((o) => ({
            metrics: o.metrics,
            outcome: o.metrics.accuracyScore!
        }));

        return this.policyOptimizer.calibrateRewardWeights(observations, {
            iterations: options?.iterations,
            autoApply: options?.autoApply
        });
    }

    public reset(): void {
        this.policyOptimizer.reset();
        this.driftDetector.reset();
        this.repository.clear();
    }
}

export const globalFeedbackEngine = ContinuousFeedbackEngine.getInstance();
