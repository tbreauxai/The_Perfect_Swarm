import { describe, it, expect, beforeEach } from 'vitest';
import {
    StatisticalAnalyzer,
    AgentExperiment,
    AgentExperimentManager,
    globalAgentExperimentManager
} from './experiment.ts';

describe('StatisticalAnalyzer', () => {
    it('calculates mean, variance, and standard deviation accurately', () => {
        const sample = [10, 20, 30, 40, 50];
        const mean = StatisticalAnalyzer.calculateMean(sample);
        expect(mean).toBe(30);

        const variance = StatisticalAnalyzer.calculateVariance(sample, mean);
        expect(variance).toBe(250);

        const stdDev = StatisticalAnalyzer.calculateStdDev(sample, mean);
        expect(stdDev).toBeCloseTo(15.811, 3);
    });

    it('approximates standard normal CDF correctly', () => {
        expect(StatisticalAnalyzer.normalCdf(0)).toBeCloseTo(0.5, 3);
        expect(StatisticalAnalyzer.normalCdf(1.96)).toBeCloseTo(0.975, 2);
        expect(StatisticalAnalyzer.normalCdf(-1.96)).toBeCloseTo(0.025, 2);
    });

    it('computes Welch t-test for identical samples with p=1.0', () => {
        const a = [5, 5, 5, 5, 5];
        const b = [5, 5, 5, 5, 5];
        const result = StatisticalAnalyzer.welchTTest(a, b);
        expect(result.tStat).toBe(0);
        expect(result.pValue).toBe(1.0);
    });

    it('computes Welch t-test for distinctly separated distributions with p < 0.001', () => {
        const treatment = [10.2, 10.5, 9.8, 10.1, 10.4, 10.3, 9.9, 10.6, 10.2, 10.0];
        const control = [5.1, 5.3, 4.9, 5.2, 5.0, 4.8, 5.4, 5.1, 5.0, 5.2];
        const result = StatisticalAnalyzer.welchTTest(treatment, control);

        expect(result.tStat).toBeGreaterThan(20);
        expect(result.pValue).toBeLessThan(0.001);
        expect(result.ci95[0]).toBeGreaterThan(4.5);
        expect(result.ci95[1]).toBeLessThan(5.8);
    });

    it('computes composite utility score with latency and quality balancing', () => {
        const highPerf = StatisticalAnalyzer.calculateCompositeScore({
            durationMs: 500,
            tokensTotal: 1000,
            rlaifScore: 0.95
        });

        const lowPerf = StatisticalAnalyzer.calculateCompositeScore({
            durationMs: 3500,
            tokensTotal: 7000,
            rlaifScore: 0.60
        });

        expect(highPerf).toBeGreaterThan(lowPerf);
        expect(highPerf).toBeGreaterThan(0.80);

        const errorPerf = StatisticalAnalyzer.calculateCompositeScore({
            durationMs: 500,
            error: true
        });
        expect(errorPerf).toBe(0.05);
    });
});

describe('AgentExperiment', () => {
    let experiment: AgentExperiment;

    beforeEach(() => {
        experiment = new AgentExperiment({
            id: 'exp-prompt-opt',
            name: 'Specialist Prompt Optimization',
            allocationStrategy: 'deterministic_hash',
            variants: [
                {
                    variantId: 'control',
                    name: 'Default V1 Prompts',
                    trafficWeight: 0.5,
                    isBaseline: true
                },
                {
                    variantId: 'treatment-concise',
                    name: 'Concise Structured Prompts',
                    trafficWeight: 0.5
                }
            ],
            circuitBreaker: {
                maxErrorRate: 0.20,
                minRlaifScore: 0.60,
                maxLatencyDegradationPercent: 50,
                minSamplesBeforeTrigger: 5
            },
            promotionCriteria: {
                minSampleSize: 10,
                confidenceLevel: 0.95,
                minImprovementPercent: 5,
                primaryMetric: 'composite'
            }
        });
    });

    it('consistently maps routing keys using deterministic hashing', () => {
        const v1 = experiment.allocateVariant('app-1:audit-task-auth');
        const v2 = experiment.allocateVariant('app-1:audit-task-auth');
        expect(v1.variantId).toBe(v2.variantId);
    });

    it('trips error rate circuit breaker and rolls back to baseline', () => {
        // Record 5 samples with 3 errors (60% error rate > 20% limit)
        for (let i = 0; i < 2; i++) {
            experiment.recordOutcome('treatment-concise', { durationMs: 400, rlaifScore: 0.90, error: false });
        }
        for (let i = 0; i < 3; i++) {
            const res = experiment.recordOutcome('treatment-concise', { durationMs: 400, error: true, errorMessage: 'Crash' });
            if (i === 2) {
                expect(res.action).toBe('circuit_breaker_rollback');
                expect(res.status).toBe('rolled_back');
                expect(res.winningVariantId).toBe('control');
                expect(experiment.status).toBe('rolled_back');
            }
        }
    });

    it('trips minimum RLAIF quality score circuit breaker', () => {
        for (let i = 0; i < 5; i++) {
            const res = experiment.recordOutcome('treatment-concise', {
                durationMs: 500,
                rlaifScore: 0.45 // below 0.60 floor
            });
            if (i === 4) {
                expect(res.action).toBe('circuit_breaker_rollback');
                expect(res.status).toBe('rolled_back');
                expect(res.winningVariantId).toBe('control');
            }
        }
    });

    it('automatically promotes candidate variant upon reaching statistical significance', () => {
        // Populate baseline control (mean composite ~0.65)
        for (let i = 0; i < 12; i++) {
            experiment.recordOutcome('control', {
                durationMs: 1800,
                tokensTotal: 3500,
                rlaifScore: 0.80
            });
        }

        // Populate treatment with superior metrics (mean composite ~0.85)
        const decisions = [];
        for (let i = 0; i < 12; i++) {
            const decision = experiment.recordOutcome('treatment-concise', {
                durationMs: 600,
                tokensTotal: 1200,
                rlaifScore: 0.95
            });
            decisions.push(decision);
        }

        const promotedDecision = decisions.find(d => d.action === 'promoted');
        expect(promotedDecision).toBeDefined();
        expect(promotedDecision?.winningVariantId).toBe('treatment-concise');
        expect(experiment.status).toBe('concluded');
        expect(experiment.getActiveVariant().variantId).toBe('treatment-concise');
    });

    it('trips latency degradation circuit breaker when candidate is >50% slower', () => {
        // 5 baseline samples at 1000ms
        for (let i = 0; i < 5; i++) {
            experiment.recordOutcome('control', { durationMs: 1000, rlaifScore: 0.90 });
        }

        // 5 treatment samples at 2200ms (120% slower > 50% limit)
        for (let i = 0; i < 5; i++) {
            const res = experiment.recordOutcome('treatment-concise', { durationMs: 2200, rlaifScore: 0.90 });
            if (i === 4) {
                expect(res.action).toBe('circuit_breaker_rollback');
                expect(res.status).toBe('rolled_back');
            }
        }
    });

    it('supports Thompson sampling bandit allocation', () => {
        const banditExp = new AgentExperiment({
            id: 'bandit-exp',
            name: 'Bandit Allocation',
            allocationStrategy: 'thompson_sampling',
            promotionCriteria: {
                minSampleSize: 100
            },
            circuitBreaker: {
                minRlaifScore: 0.50
            },
            variants: [
                { variantId: 'arm-1', name: 'Arm 1', trafficWeight: 1, isBaseline: true },
                { variantId: 'arm-2', name: 'Arm 2', trafficWeight: 1 }
            ]
        });

        // Give arm-2 high rewards and arm-1 low rewards
        for (let i = 0; i < 10; i++) {
            banditExp.recordOutcome('arm-2', { durationMs: 500, rlaifScore: 0.99 });
            banditExp.recordOutcome('arm-1', { durationMs: 3000, rlaifScore: 0.65 });
        }

        // Thompson sampling should overwhelmingly favor arm-2
        let arm2Count = 0;
        for (let i = 0; i < 50; i++) {
            const v = banditExp.allocateVariant();
            if (v.variantId === 'arm-2') arm2Count++;
        }
        expect(arm2Count).toBeGreaterThan(40);
    });
});

describe('AgentExperimentManager', () => {
    let manager: AgentExperimentManager;

    beforeEach(() => {
        manager = new AgentExperimentManager();
    });

    it('registers, manages lifecycle, and serializes state correctly', () => {
        const exp = manager.createExperiment({
            id: 'exp-model-mix',
            name: 'Model Mix Optimization',
            variants: [
                { variantId: 'v1', name: 'Gemini Baseline', trafficWeight: 1, isBaseline: true },
                { variantId: 'v2', name: 'Mistral Fast', trafficWeight: 1 }
            ]
        });

        expect(manager.getActiveExperiment()?.id).toBe('exp-model-mix');

        const resolved = manager.resolveVariantForTask('audit security', 'app-fintech');
        expect(resolved.experiment?.id).toBe('exp-model-mix');
        expect(resolved.variant).toBeDefined();

        manager.recordExecutionMetrics('exp-model-mix', 'v1', {
            durationMs: 800,
            rlaifScore: 0.92
        });

        const state = manager.exportState();
        expect(state).toHaveProperty('experiments');

        const newManager = new AgentExperimentManager();
        newManager.importState(state);
        expect(newManager.getExperiment('exp-model-mix')).toBeDefined();
        expect(newManager.getExperiment('exp-model-mix')?.getPerformance('v1').sampleCount).toBe(1);
    });
});
