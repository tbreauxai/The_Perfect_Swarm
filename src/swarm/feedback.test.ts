import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    PolicyOptimizer,
    ConceptDriftDetector,
    SwarmKnowledgeRepository,
    ContinuousFeedbackEngine,
    DEFAULT_TUNABLE_PARAMETERS,
    PARAMETER_BOUNDS,
    AnalystLedger,
    analystLedger
} from './feedback.ts';

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

    it('discriminates latency and cost across realistic operating ranges (30-60s) without saturation', () => {
        // A 30s run (30,000ms) with 5,000 tokens consumed
        const reward30s = optimizer.calculateReward({
            workflowId: 'wf-30s',
            task: 'Realistic swarm run',
            appId: 'test-app',
            durationMs: 30000,
            targetTier: 'complex',
            tokenSavings: 2000,
            tokensConsumed: 5000,
            qualityScore: 0.90,
            accuracyScore: 0.95,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // 30,000 / 120,000 = 0.25 normalized penalty -> -0.25 * 0.15 = -0.038
        expect(reward30s.components.latencyPenalty).toBeCloseTo(-0.038, 2);
        // Cost: 5,000 / 100,000 = 0.05 normalized penalty -> -0.05 * 0.05 = -0.003
        expect(reward30s.components.costPenalty).toBeCloseTo(-0.003, 3);
        // Composite reward is not capped at ~0.60; can reach ~0.70+
        expect(reward30s.compositeReward).toBeGreaterThan(0.65);

        // A 120s run hits the full -0.15 penalty
        const reward120s = optimizer.calculateReward({
            workflowId: 'wf-120s',
            task: 'Slow swarm run',
            appId: 'test-app',
            durationMs: 120000,
            targetTier: 'complex',
            tokenSavings: 0,
            tokensConsumed: 100000,
            qualityScore: 0.90,
            accuracyScore: 0.95,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });
        expect(reward120s.components.latencyPenalty).toBe(-0.15);
        expect(reward120s.components.costPenalty).toBe(-0.05);
    });

    it('isolates hard errors from graceful failovers in accuracy and reward calculation', () => {
        // Run with 2 graceful failovers and 0 hard errors
        const failoverReward = optimizer.calculateReward({
            workflowId: 'wf-failover',
            task: 'Failover recovery run',
            appId: 'test-app',
            durationMs: 15000,
            targetTier: 'complex',
            tokenSavings: 1000,
            tokensConsumed: 4000,
            qualityScore: 0.90,
            errorCount: 2,
            failoverCount: 2,
            hardErrorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // 2 failovers incur a small -0.04 penalty on 0.90 base accuracy -> accuracy = 0.86
        // accuracyReward = 0.86 * 0.35 = ~0.301
        expect(failoverReward.components.accuracyReward).toBeCloseTo(0.301, 2);
        // failoverPenalty is reported in components
        expect(failoverReward.components.failoverPenalty).toBeCloseTo(-0.014, 2);
        // Composite reward stays high (>0.60) instead of cratering to ~0.136
        expect(failoverReward.compositeReward).toBeGreaterThan(0.60);

        // Run with 2 hard unrecovered errors and 0 failovers
        const hardErrorReward = optimizer.calculateReward({
            workflowId: 'wf-hard-error',
            task: 'Hard error run',
            appId: 'test-app',
            durationMs: 15000,
            targetTier: 'complex',
            tokenSavings: 1000,
            tokensConsumed: 4000,
            qualityScore: 0.90,
            errorCount: 2,
            failoverCount: 0,
            hardErrorCount: 2,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // 2 hard errors: 1 - 2*0.3 = 0.40 accuracy -> 0.40 * 0.35 = 0.140
        expect(hardErrorReward.components.accuracyReward).toBeCloseTo(0.140, 2);
        expect(failoverReward.compositeReward).toBeGreaterThan(hardErrorReward.compositeReward + 0.10);
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

    it('a policy value set on run N is the value used on run N+1, or mutations no longer happen', () => {
        const baselineReward = optimizer.calculateReward({
            workflowId: 'wf-base',
            task: 'T1',
            appId: 'test-app',
            durationMs: 1000,
            targetTier: 'instant',
            tokenSavings: 0,
            tokensConsumed: 1000,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        optimizer.updateWithFeedback(baselineReward, optimizer.getCurrentPolicy());

        const proposed1 = optimizer.proposeNextParameters();
        const betterReward = optimizer.calculateReward({
            workflowId: 'wf-better',
            task: 'T2',
            appId: 'test-app',
            durationMs: 500,
            targetTier: 'instant',
            tokenSavings: 500,
            tokensConsumed: 800,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // Using exactly proposed policy
        const res1 = optimizer.updateWithFeedback(betterReward, proposed1, proposed1);
        expect(res1.updated).toBe(true);
        expect(optimizer.getBestPolicy()).toEqual(proposed1);

        const proposed2 = optimizer.proposeNextParameters();
        const evenBetterReward = optimizer.calculateReward({
            workflowId: 'wf-even-better',
            task: 'T3',
            appId: 'test-app',
            durationMs: 200,
            targetTier: 'instant',
            tokenSavings: 600,
            tokensConsumed: 400,
            errorCount: 0,
            anomalyCount: 0,
            timestamp: Date.now()
        });

        // Passing a different used policy prevents mutations from updating
        const wrongUsedParams = optimizer.getCurrentPolicy();
        wrongUsedParams.schedulerMaxConcurrency = 999;

        const res2 = optimizer.updateWithFeedback(evenBetterReward, wrongUsedParams, proposed2);
        expect(res2.updated).toBe(false);
        expect(optimizer.getBestPolicy()).toEqual(proposed1);
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
        optimizer.updateWithFeedback(baselineReward, optimizer.getCurrentPolicy());

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

        const res = optimizer.updateWithFeedback(superiorReward, superiorParams, superiorParams);
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
        expect(stored?.agentRoles).toEqual([]);
    });

    it('persists agentRoles array on AnalysisOutcomeRecord when provided', async () => {
        const engine = new ContinuousFeedbackEngine();
        const expectedRoles = ['Quant Specialist', 'Market & Steam Specialist', 'Injury Analyst'];
        const result = await engine.processFeedback({
            workflowId: 'wf-roles-test-1',
            task: 'Evaluate match handicap',
            appId: 'duelodds',
            durationMs: 320,
            targetTier: 'complex',
            agentRoles: expectedRoles
        });

        const stored = engine.getKnowledgeRepository().getOutcome(result.outcomeId);
        expect(stored).toBeDefined();
        expect(stored?.agentRoles).toEqual(expectedRoles);
    });
});

describe('AnalystLedger (Per-Analyst Outcomes & File-Backed Persistence)', () => {
    const testDir = path.resolve(process.cwd(), '.test-analyst-ledger');
    const testFile = path.join(testDir, 'analyst_ledger.json');

    beforeEach(() => {
        analystLedger.clear();
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    });

    afterEach(() => {
        analystLedger.clear();
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    });

    it('records win, loss, and push outcomes keyed by appId:agentRole', () => {
        analystLedger.recordOutcome('duelodds', 'Quant Specialist', 'win');
        analystLedger.recordOutcome('duelodds', 'Quant Specialist', 'win');
        analystLedger.recordOutcome('duelodds', 'Quant Specialist', 'loss');
        analystLedger.recordOutcome('duelodds', 'Market Specialist', 'push');

        const metrics = analystLedger.getMetrics();
        expect(metrics['duelodds:Quant Specialist']).toBeDefined();
        expect(metrics['duelodds:Quant Specialist'].wins).toBe(2);
        expect(metrics['duelodds:Quant Specialist'].losses).toBe(1);
        expect(metrics['duelodds:Quant Specialist'].pushes).toBe(0);

        expect(metrics['duelodds:Market Specialist']).toBeDefined();
        expect(metrics['duelodds:Market Specialist'].wins).toBe(0);
        expect(metrics['duelodds:Market Specialist'].pushes).toBe(1);
    });

    it('exports and imports ledger records correctly', () => {
        const ledger1 = new AnalystLedger();
        ledger1.recordOutcome('app1', 'Specialist A', 'win');
        ledger1.recordOutcome('app1', 'Specialist B', 'loss');

        const exported = ledger1.export();
        const ledger2 = new AnalystLedger();
        const importedCount = ledger2.import(exported);

        expect(importedCount).toBe(2);
        expect(ledger2.getRecord('app1', 'Specialist A')?.wins).toBe(1);
        expect(ledger2.getRecord('app1', 'Specialist B')?.losses).toBe(1);
    });

    it('saves to file and restores state across simulated restart', async () => {
        const ledger1 = new AnalystLedger({ persistPath: testFile, autoSave: false });
        ledger1.recordOutcome('render-app', 'Injury Analyst', 'win');
        ledger1.recordOutcome('render-app', 'Injury Analyst', 'win');
        ledger1.recordOutcome('render-app', 'Injury Analyst', 'push');

        const saved = await ledger1.saveToFile();
        expect(saved).toBe(true);
        expect(fs.existsSync(testFile)).toBe(true);

        // Simulate server reboot with new instance loading from persistent file
        const ledger2 = new AnalystLedger({ persistPath: testFile });
        const loaded = await ledger2.loadFromFile();
        expect(loaded).toBe(true);

        const record = ledger2.getRecord('render-app', 'Injury Analyst');
        expect(record).toBeDefined();
        expect(record?.wins).toBe(2);
        expect(record?.pushes).toBe(1);
        expect(record?.losses).toBe(0);
    });

    it('auto-saves debounced writes when autoSave and persistPath are active', async () => {
        const ledger = new AnalystLedger({ persistPath: testFile, autoSave: true, debounceMs: 50 });
        ledger.recordOutcome('auto-app', 'Quant Lead', 'win');

        // Verify debounced save writes to disk after timeout
        await new Promise((r) => setTimeout(r, 120));
        expect(fs.existsSync(testFile)).toBe(true);

        const raw = fs.readFileSync(testFile, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(parsed['auto-app:Quant Lead']).toBeDefined();
        expect(parsed['auto-app:Quant Lead'].wins).toBe(1);
    });

    it('calculates average accuracy across participating analyst roles', () => {
        const ledger = new AnalystLedger();
        // Zero outcomes
        const empty = ledger.getAverageAccuracy('app1', ['Role A', 'Role B']);
        expect(empty.totalOutcomes).toBe(0);
        expect(empty.accuracy).toBe(0.5);

        // Record outcomes: Role A has 3 wins, 1 loss; Role B has 1 push
        ledger.recordOutcome('app1', 'Role A', 'win');
        ledger.recordOutcome('app1', 'Role A', 'win');
        ledger.recordOutcome('app1', 'Role A', 'win');
        ledger.recordOutcome('app1', 'Role A', 'loss');
        ledger.recordOutcome('app1', 'Role B', 'push');

        // Total: 3 wins (3.0), 1 loss, 1 push (0.5) = 3.5 / 5 = 0.70
        const stats = ledger.getAverageAccuracy('app1', ['Role A', 'Role B']);
        expect(stats.totalOutcomes).toBe(5);
        expect(stats.accuracy).toBe(0.70);

        // Only query Role A
        const statsA = ledger.getAverageAccuracy('app1', ['Role A']);
        expect(statsA.totalOutcomes).toBe(4);
        expect(statsA.accuracy).toBe(0.75);
    });
});

describe('Reward Weights Calibration & Outcome Correlation (Phase 1)', () => {
    it('manages reward weights with getWeights and setWeights', () => {
        const optimizer = new PolicyOptimizer();
        const initial = optimizer.getWeights();
        expect(initial.quality).toBe(0.35);
        expect(initial.accuracy).toBe(0.35);
        expect(initial.latency).toBe(0.15);
        expect(initial.cost).toBe(0.05);
        expect(initial.tokenSavings).toBe(0.10);

        optimizer.setWeights({ accuracy: 0.45, latency: 0.10 });
        const updated = optimizer.getWeights();
        expect(updated.accuracy).toBe(0.45);
        expect(updated.latency).toBe(0.10);
        expect(updated.quality).toBe(0.35);
    });

    it('computes Pearson correlation and MSE between composite rewards and graded outcomes', () => {
        const optimizer = new PolicyOptimizer();

        const observations = [
            // Strong runs -> Wins
            {
                metrics: {
                    workflowId: 'wf-1',
                    task: 'pick 1',
                    appId: 'test',
                    durationMs: 12000,
                    targetTier: 'complex' as const,
                    tokenSavings: 2000,
                    tokensConsumed: 4000,
                    qualityScore: 0.95,
                    accuracyScore: 0.95,
                    errorCount: 0,
                    anomalyCount: 0,
                    timestamp: Date.now()
                },
                outcome: 'win' as const
            },
            {
                metrics: {
                    workflowId: 'wf-2',
                    task: 'pick 2',
                    appId: 'test',
                    durationMs: 15000,
                    targetTier: 'complex' as const,
                    tokenSavings: 1800,
                    tokensConsumed: 5000,
                    qualityScore: 0.90,
                    accuracyScore: 0.90,
                    errorCount: 0,
                    anomalyCount: 0,
                    timestamp: Date.now()
                },
                outcome: 'win' as const
            },
            // Weak runs -> Losses
            {
                metrics: {
                    workflowId: 'wf-3',
                    task: 'pick 3',
                    appId: 'test',
                    durationMs: 65000,
                    targetTier: 'complex' as const,
                    tokenSavings: 200,
                    tokensConsumed: 25000,
                    qualityScore: 0.40,
                    accuracyScore: 0.30,
                    errorCount: 2,
                    anomalyCount: 1,
                    timestamp: Date.now()
                },
                outcome: 'loss' as const
            },
            {
                metrics: {
                    workflowId: 'wf-4',
                    task: 'pick 4',
                    appId: 'test',
                    durationMs: 80000,
                    targetTier: 'complex' as const,
                    tokenSavings: 0,
                    tokensConsumed: 30000,
                    qualityScore: 0.35,
                    accuracyScore: 0.20,
                    errorCount: 3,
                    anomalyCount: 2,
                    timestamp: Date.now()
                },
                outcome: 'loss' as const
            }
        ];

        const { correlation, mse } = optimizer.computeCorrelation(observations);
        expect(correlation).toBeGreaterThan(0.70);
        expect(mse).toBeLessThan(0.20);
    });

    it('calibrates reward weights to optimize correlation and minimize MSE across historical outcomes', () => {
        const optimizer = new PolicyOptimizer();

        // 10 historical graded picks with varying performance
        const historicalPicks = [
            // Strong picks (wins)
            { durationMs: 14000, tokens: 3500, quality: 0.92, accuracy: 0.98, outcome: 'win' as const },
            { durationMs: 18000, tokens: 4200, quality: 0.88, accuracy: 0.95, outcome: 'win' as const },
            { durationMs: 11000, tokens: 2900, quality: 0.96, accuracy: 0.99, outcome: 'win' as const },
            { durationMs: 22000, tokens: 6000, quality: 0.85, accuracy: 0.90, outcome: 'win' as const },
            { durationMs: 16000, tokens: 4000, quality: 0.90, accuracy: 0.92, outcome: 'win' as const },
            // Moderate pick (push)
            { durationMs: 35000, tokens: 9000, quality: 0.70, accuracy: 0.65, outcome: 'push' as const },
            // Weak picks (losses)
            { durationMs: 55000, tokens: 18000, quality: 0.45, accuracy: 0.40, outcome: 'loss' as const },
            { durationMs: 70000, tokens: 25000, quality: 0.35, accuracy: 0.25, outcome: 'loss' as const },
            { durationMs: 60000, tokens: 22000, quality: 0.40, accuracy: 0.30, outcome: 'loss' as const },
            { durationMs: 85000, tokens: 32000, quality: 0.30, accuracy: 0.15, outcome: 'loss' as const }
        ].map((p, idx) => ({
            metrics: {
                workflowId: `wf-pick-${idx + 1}`,
                task: `Historical pick analysis ${idx + 1}`,
                appId: 'duelodds',
                durationMs: p.durationMs,
                targetTier: 'complex' as const,
                tokenSavings: Math.max(0, 10000 - p.tokens),
                tokensConsumed: p.tokens,
                qualityScore: p.quality,
                accuracyScore: p.accuracy,
                errorCount: p.outcome === 'loss' ? 1 : 0,
                anomalyCount: 0,
                timestamp: Date.now() - (10 - idx) * 3600000
            },
            outcome: p.outcome
        }));

        const result = optimizer.calibrateRewardWeights(historicalPicks, { iterations: 500, autoApply: true });

        expect(result.sampleSize).toBe(10);
        expect(result.calibratedCorrelation).toBeGreaterThanOrEqual(result.initialCorrelation);
        expect(result.calibratedMse).toBeLessThanOrEqual(result.initialMse + 0.05);

        // Verify calibrated weights remain valid probability distribution (sum ≈ 1.0)
        const totalWeight =
            result.optimalWeights.quality +
            result.optimalWeights.accuracy +
            result.optimalWeights.latency +
            result.optimalWeights.cost +
            result.optimalWeights.tokenSavings;
        expect(totalWeight).toBeCloseTo(1.0, 1);
        expect(result.optimalWeights.accuracy).toBeGreaterThan(0.10);
    });

    it('integrates calibration with ContinuousFeedbackEngine and knowledge repository', async () => {
        const engine = new ContinuousFeedbackEngine();

        // 1. Process 3 workflows
        for (let i = 1; i <= 3; i++) {
            await engine.processFeedback({
                workflowId: `repo-wf-${i}`,
                task: `Market prediction task ${i}`,
                appId: 'test-repo-app',
                durationMs: 15000 * i,
                targetTier: 'complex',
                qualityScore: 0.9 - (i * 0.15),
                accuracyScore: 0.95 - (i * 0.20),
                tokenSavings: 1500,
                tokensConsumed: 4000 * i
            });
        }

        // 2. Mark them as feedback processed (graded outcomes)
        const outcomes = engine.getKnowledgeRepository().queryOutcomes({ appId: 'test-repo-app' });
        expect(outcomes.length).toBe(3);

        for (let i = 0; i < outcomes.length; i++) {
            (outcomes[i] as any).feedbackProcessed = true;
            outcomes[i].metrics.accuracyScore = i === 0 ? 1.0 : (i === 1 ? 0.5 : 0.0);
        }

        // 3. Calibrate directly from knowledge repository
        const calibration = engine.calibrateFromKnowledgeRepository({
            appId: 'test-repo-app',
            minSamples: 2,
            iterations: 200,
            autoApply: true
        });

        expect(calibration).not.toBeNull();
        expect(calibration!.sampleSize).toBe(3);
        expect(calibration!.applied).toBeDefined();

        const weights = engine.getRewardWeights();
        expect(weights.accuracy).toBeGreaterThan(0);
        expect(weights.quality).toBeGreaterThan(0);
    });
});
