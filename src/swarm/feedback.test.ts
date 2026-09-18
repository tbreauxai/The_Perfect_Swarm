import { describe, it, expect, beforeEach } from 'vitest';
import {
    PolicyOptimizer,
    ConceptDriftDetector,
    SwarmKnowledgeRepository,
    ContinuousFeedbackEngine,
    DEFAULT_TUNABLE_PARAMETERS,
    PARAMETER_BOUNDS
} from './feedback.js';

describe('PolicyOptimizer (Evolutionary Strategies & RL Reward Tuning)', () => {
    let optimizer: PolicyOptimizer;

    beforeEach(() => {
        optimizer = new PolicyOptimizer();
    });

    it('calculates bounded composite reward based on metrics and weights', () => {
        const reward = optimizer.calculateReward({
            workflowId: 'wf-1',
            task: 'Latency optimization',
            appId: 'test-app',
            durationMs: 150,
            targetTier: 'instant',
            tokenSavings: 500,
            tokensConsumed: 1200,
            qualityScore: 0.95,
            accuracyScore: 0.98,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        expect(reward.compositeReward).toBeGreaterThan(0.5);
        expect(reward.compositeReward).toBeLessThanOrEqual(1.0);
        expect(reward.components.qualityReward).toBeGreaterThan(0);
        expect(reward.components.accuracyReward).toBeGreaterThan(0);
        expect(reward.components.latencyPenalty).toBeLessThanOrEqual(0);
    });

    it('mutates parameters within strict upper and lower bounds', () => {
        const parent = { ...DEFAULT_TUNABLE_PARAMETERS };
        for (let i = 0; i < 20; i++) {
            const child = optimizer.mutate(parent, 0.25);
            for (const key of Object.keys(PARAMETER_BOUNDS) as Array<keyof typeof PARAMETER_BOUNDS>) {
                const bounds = PARAMETER_BOUNDS[key];
                expect(child[key]).toBeGreaterThanOrEqual(bounds.min);
                expect(child[key]).toBeLessThanOrEqual(bounds.max);
                if (bounds.isInteger) {
                    expect(Number.isInteger(child[key])).toBe(true);
                }
            }
        }
    });

    it('adapts policy when proposed parameters achieve higher reward', () => {
        const baselineReward = optimizer.calculateReward({
            workflowId: 'wf-base',
            task: 'Bench',
            appId: 'test-app',
            durationMs: 800,
            targetTier: 'complex',
            tokenSavings: 100,
            tokensConsumed: 5000,
            qualityScore: 0.60,
            accuracyScore: 0.60,
            errorCount: 1,
            anomalyCount: 1,
            timestamp: Date.now()
        });
        optimizer.updateWithFeedback(baselineReward);

        const superiorParams = {
            ...DEFAULT_TUNABLE_PARAMETERS,
            cacheL1MaxEntries: 300,
            schedulerMaxConcurrency: 8
        };

        const superiorReward = optimizer.calculateReward({
            workflowId: 'wf-sup',
            task: 'Bench',
            appId: 'test-app',
            durationMs: 120,
            targetTier: 'instant',
            tokenSavings: 800,
            tokensConsumed: 800,
            qualityScore: 0.98,
            accuracyScore: 0.99,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        const res = optimizer.updateWithFeedback(superiorReward, superiorParams);
        expect(res.updated).toBe(true);
        expect(res.currentPolicy.cacheL1MaxEntries).toBe(300);
        expect(res.currentPolicy.schedulerMaxConcurrency).toBe(8);
        expect(optimizer.getBestPolicy().cacheL1MaxEntries).toBe(300);
    });
});

describe('ConceptDriftDetector (Page-Hinkley & Embedding Divergence)', () => {
    let detector: ConceptDriftDetector;

    beforeEach(() => {
        detector = new ConceptDriftDetector({
            latencyThreshold: 30,
            qualityThreshold: 0.20,
            centroidDriftThreshold: 0.85
        });
    });

    it('detects latency drift via sequential Page-Hinkley cumulative sum', () => {
        // Feed normal low latencies
        for (let i = 0; i < 10; i++) {
            const alert = detector.recordLatencyObservation(50 + (i % 3) * 5);
            expect(alert).toBeNull();
        }

        // Induce sudden high latency surge
        let driftDetected = false;
        for (let i = 0; i < 5; i++) {
            const alert = detector.recordLatencyObservation(350 + i * 20);
            if (alert && alert.driftType === 'page-hinkley-latency') {
                driftDetected = true;
                expect(alert.recommendedAction).toBe('tighten-thresholds');
                break;
            }
        }
        expect(driftDetected).toBe(true);
    });

    it('detects quality degradation drift via Page-Hinkley test', () => {
        // Normal high quality
        for (let i = 0; i < 10; i++) {
            const alert = detector.recordQualityObservation(0.95);
            expect(alert).toBeNull();
        }

        // Sudden drop in quality
        let driftDetected = false;
        for (let i = 0; i < 5; i++) {
            const alert = detector.recordQualityObservation(0.30);
            if (alert && alert.driftType === 'page-hinkley-quality') {
                driftDetected = true;
                expect(alert.recommendedAction).toBe('reset-policy');
                break;
            }
        }
        expect(driftDetected).toBe(true);
    });

    it('detects semantic concept drift when embedding centroid diverges', () => {
        const reference = [1, 0, 0, 0];
        detector.recordEmbeddingObservation(reference);

        // Feed similar vectors
        for (let i = 0; i < 6; i++) {
            detector.recordEmbeddingObservation([0.98, 0.02, 0, 0]);
        }

        // Feed orthogonal/diverged vectors to shift centroid
        let driftDetected = false;
        for (let i = 0; i < 15; i++) {
            const alert = detector.recordEmbeddingObservation([0, 1, 0, 0]);
            if (alert && alert.driftType === 'embedding-centroid-shift') {
                driftDetected = true;
                expect(alert.recommendedAction).toBe('re-index-memory');
                break;
            }
        }
        expect(driftDetected).toBe(true);
    });

    it('validates incoming data payloads', () => {
        expect(detector.validateDataPayload(null).valid).toBe(false);
        expect(detector.validateDataPayload('').valid).toBe(false);
        expect(detector.validateDataPayload('Valid telemetry payload string').valid).toBe(true);
        expect(detector.validateDataPayload({ data: 'valid object' }).valid).toBe(true);
    });
});

describe('SwarmKnowledgeRepository', () => {
    let repo: SwarmKnowledgeRepository;

    beforeEach(() => {
        repo = new SwarmKnowledgeRepository();
    });

    it('records and queries outcome records with filters', async () => {
        await repo.recordOutcome({
            id: 'out-1',
            workflowId: 'wf-1',
            task: 'App 1 Task',
            appId: 'app-alpha',
            finalInsightSnippet: 'Alpha nominal',
            metrics: {
                workflowId: 'wf-1',
                task: 'App 1 Task',
                appId: 'app-alpha',
                durationMs: 100,
                targetTier: 'instant',
                tokenSavings: 200,
                tokensConsumed: 300,
                qualityScore: 0.90,
                errorCount: 0,
                anomalyCount: 0,
                timestamp: Date.now()
            },
            reward: {
                compositeReward: 0.85,
                components: { qualityReward: 0.3, accuracyReward: 0.3, latencyPenalty: 0, costPenalty: 0, savingsReward: 0.05 },
                weights: { quality: 0.35, accuracy: 0.35, latency: 0.15, cost: 0.05, tokenSavings: 0.10 },
                timestamp: Date.now()
            },
            parametersUsed: { ...DEFAULT_TUNABLE_PARAMETERS },
            driftAlerts: [],
            timestamp: Date.now()
        });

        await repo.recordOutcome({
            id: 'out-2',
            workflowId: 'wf-2',
            task: 'App 2 Task',
            appId: 'app-beta',
            finalInsightSnippet: 'Beta nominal',
            metrics: {
                workflowId: 'wf-2',
                task: 'App 2 Task',
                appId: 'app-beta',
                durationMs: 300,
                targetTier: 'complex',
                tokenSavings: 50,
                tokensConsumed: 1200,
                qualityScore: 0.65,
                errorCount: 0,
                anomalyCount: 0,
                timestamp: Date.now()
            },
            reward: {
                compositeReward: 0.40,
                components: { qualityReward: 0.2, accuracyReward: 0.2, latencyPenalty: -0.05, costPenalty: -0.02, savingsReward: 0.01 },
                weights: { quality: 0.35, accuracy: 0.35, latency: 0.15, cost: 0.05, tokenSavings: 0.10 },
                timestamp: Date.now()
            },
            parametersUsed: { ...DEFAULT_TUNABLE_PARAMETERS, cacheL1MaxEntries: 200 },
            driftAlerts: [],
            timestamp: Date.now()
        });

        const alphaOutcomes = repo.queryOutcomes({ appId: 'app-alpha' });
        expect(alphaOutcomes.length).toBe(1);
        expect(alphaOutcomes[0].id).toBe('out-1');

        const highRewardOutcomes = repo.queryOutcomes({ minReward: 0.50 });
        expect(highRewardOutcomes.length).toBe(1);
        expect(highRewardOutcomes[0].id).toBe('out-1');

        const insights = repo.getAggregatedInsights();
        expect(insights.totalRuns).toBe(2);
        expect(insights.avgReward).toBeCloseTo(0.625, 2);
        expect(insights.totalTokensSaved).toBe(250);
        expect(insights.bestParameters.cacheL1MaxEntries).toBe(DEFAULT_TUNABLE_PARAMETERS.cacheL1MaxEntries);
    });
});

describe('ContinuousFeedbackEngine (Unified Feedback Loop)', () => {
    let engine: ContinuousFeedbackEngine;

    beforeEach(() => {
        engine = new ContinuousFeedbackEngine();
    });

    it('processes feedback, tunes parameters, detects drift, and logs outcome', async () => {
        const result = await engine.processFeedback({
            workflowId: 'wf-loop-1',
            task: 'Tune Cache & Concurrency',
            appId: 'feedback-app',
            durationMs: 95,
            targetTier: 'instant',
            tokenSavings: 450,
            tokensConsumed: 600,
            qualityScore: 0.96,
            accuracyScore: 0.99,
            errorCount: 0,
            finalInsightSnippet: 'Throughput optimal under tuned concurrency',
            embedding: [0.8, 0.2, 0.1]
        });

        expect(result.reward.compositeReward).toBeGreaterThan(0.6);
        expect(result.outcomeId).toBeDefined();
        expect(result.tunedParameters).toBeDefined();

        const stored = engine.getKnowledgeRepository().getOutcome(result.outcomeId);
        expect(stored).toBeDefined();
        expect(stored?.task).toBe('Tune Cache & Concurrency');
        expect(stored?.appId).toBe('feedback-app');
    });
});
