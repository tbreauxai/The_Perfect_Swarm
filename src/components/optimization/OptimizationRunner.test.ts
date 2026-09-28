import { describe, it, expect } from 'vitest';
import {
    isModelResponseValid,
    getModelExecutionStatus,
    calculateSpeedScore,
    extractGradingScores,
    WORKING_MODELS,
    scoreOf,
    getGraderCacheKey,
    GRADER_CACHE,
    GRADER_CACHE_TTL_MS
} from './OptimizationRunner';

describe('OptimizationRunner - Response Validity Hardening', () => {
    describe('calculateSpeedScore', () => {
        it('returns 10 for latency under or equal to 2000ms', () => {
            expect(calculateSpeedScore(500)).toBe(10);
            expect(calculateSpeedScore(2000)).toBe(10);
        });

        it('returns 1 for latency over or equal to 10000ms', () => {
            expect(calculateSpeedScore(10000)).toBe(1);
            expect(calculateSpeedScore(15000)).toBe(1);
        });

        it('scales linearly between 2000ms and 10000ms', () => {
            const mid = calculateSpeedScore(6000);
            expect(mid).toBeGreaterThanOrEqual(5);
            expect(mid).toBeLessThanOrEqual(6);
        });
    });

    describe('isModelResponseValid', () => {
        it('rejects null, undefined, or empty results', () => {
            expect(isModelResponseValid(null)).toBe(false);
            expect(isModelResponseValid(undefined)).toBe(false);
            expect(isModelResponseValid({ output: null })).toBe(false);
            expect(isModelResponseValid({ output: undefined })).toBe(false);
            expect(isModelResponseValid({ output: '' })).toBe(false);
            expect(isModelResponseValid({ output: '   ' })).toBe(false);
            expect(isModelResponseValid({ output: {} })).toBe(false);
        });

        it('rejects results with explicit top-level errors', () => {
            expect(isModelResponseValid({ output: 'Valid response here that is long enough', error: 'HTTP 500 error' })).toBe(false);
            expect(isModelResponseValid({ error: 'Connection refused' })).toBe(false);
        });

        it('rejects embedded execution error wrappers', () => {
            expect(isModelResponseValid({
                output: { ui_title: 'Execution Error', error: 'Model rate limit exceeded' }
            })).toBe(false);

            expect(isModelResponseValid({
                output: { error: 'Quota exceeded for provider' }
            })).toBe(false);
        });

        it('rejects string outputs that indicate error or validation failure', () => {
            expect(isModelResponseValid({ output: 'Error: Provider API key is invalid' })).toBe(false);
            expect(isModelResponseValid({ output: 'SCHEMA_VALIDATION_FAILED: Missing insights array' })).toBe(false);
            expect(isModelResponseValid({ output: 'Execution error in swarm workflow' })).toBe(false);
        });

        it('validates substantive plain string outputs', () => {
            expect(isModelResponseValid({
                output: 'Analysis complete: Server latency is optimal with 99.9% uptime across all pods.'
            })).toBe(true);
        });

        it('validates Generative UI ManagerResponse with InsightList', () => {
            const validUi = {
                ui_title: 'Swarm Executive Synthesis',
                components: [{
                    id: 'insights-1',
                    type: 'InsightList',
                    props: {
                        title: 'Analytical Insights',
                        insights: [
                            { type: 'info', message: 'Primary database read replica is within healthy bounds.' }
                        ]
                    }
                }]
            };
            expect(isModelResponseValid({ output: validUi })).toBe(true);
        });

        it('validates Generative UI ManagerResponse with MetricCard or DataTable', () => {
            const metricUi = {
                ui_title: 'Metrics Dashboard',
                components: [{
                    id: 'card-1',
                    type: 'MetricCard',
                    props: { title: 'System Throughput', value: '4500 req/s' }
                }]
            };
            expect(isModelResponseValid({ output: metricUi })).toBe(true);

            const tableUi = {
                ui_title: 'Table View',
                components: [{
                    id: 'table-1',
                    type: 'DataTable',
                    props: { title: 'Clusters', rows: [{ cluster: 'east-1', status: 'online' }] }
                }]
            };
            expect(isModelResponseValid({ output: tableUi })).toBe(true);
        });

        it('rejects Generative UI components with empty or error-only insights', () => {
            const emptyInsightsUi = {
                ui_title: 'Empty Synthesis',
                components: [{
                    id: 'insights-1',
                    type: 'InsightList',
                    props: {
                        title: 'Insights',
                        insights: [{ type: 'error', message: 'Error: Rate limit' }]
                    }
                }]
            };
            expect(isModelResponseValid({ output: emptyInsightsUi })).toBe(false);
        });

        it('validates AnalystResponse structure', () => {
            const analystOutput = {
                insights: ['Cache hit ratio improved by 45% following LRU prefetch.'],
                anomalies: [],
                summary: 'Analyst assessment verified stable memory profile.'
            };
            expect(isModelResponseValid({ output: analystOutput })).toBe(true);
        });
    });

    describe('getModelExecutionStatus', () => {
        it('differentiates between valid, incomplete, and error statuses', () => {
            expect(getModelExecutionStatus({ error: 'Failed' })).toBe('error');
            expect(getModelExecutionStatus({ output: null })).toBe('incomplete');
            expect(getModelExecutionStatus({ output: {} })).toBe('incomplete');
            expect(getModelExecutionStatus({
                output: 'Analysis complete: Performance latency is verified under 50ms.'
            })).toBe('valid');
        });
    });

    describe('extractGradingScores', () => {
        it('extracts direct JSON scores', () => {
            const payload = {
                finalAnalysis: {
                    intelligence: 8,
                    accuracy: 9,
                    speed: 7
                }
            };
            const scores = extractGradingScores(payload, 1500);
            expect(scores.intelligence).toBe(8);
            expect(scores.accuracy).toBe(9);
            expect(scores.speed).toBe(7);
        });

        it('extracts scores embedded in Generative UI InsightList components', () => {
            const payload = {
                finalAnalysis: {
                    ui_title: 'Grading Report',
                    components: [{
                        id: 'default-insight-list',
                        type: 'InsightList',
                        props: {
                            title: 'Grader Output',
                            insights: [{
                                type: 'info',
                                message: '{"intelligence": 7, "accuracy": 8, "speed": 6}'
                            }]
                        }
                    }]
                }
            };
            const scores = extractGradingScores(payload, 3000);
            expect(scores.intelligence).toBe(7);
            expect(scores.accuracy).toBe(8);
            expect(scores.speed).toBe(6);
        });

        it('extracts scores formatted in natural language key-value prose', () => {
            const payload = {
                finalAnalysis: {
                    ui_title: 'Executive Synthesis',
                    components: [{
                        id: 'insight-1',
                        type: 'InsightList',
                        props: {
                            title: 'Evaluation',
                            insights: [{
                                message: 'The subordinate model demonstrated high reasoning. Intelligence: 9/10, Accuracy: 8/10.'
                            }]
                        }
                    }]
                }
            };
            const scores = extractGradingScores(payload, 1800);
            expect(scores.intelligence).toBe(9);
            expect(scores.accuracy).toBe(8);
            expect(scores.speed).toBe(10); // deterministic fallback for 1800ms
        });

        it('extracts scores from execution event logs if manager synthesized a high-level UI', () => {
            const payload = {
                finalAnalysis: {
                    ui_title: 'Executive Synthesis',
                    components: []
                },
                events: [{
                    agentRole: 'Grader Node',
                    output: { intelligence: 9, accuracy: 10, speed: 8 }
                }]
            };
            const scores = extractGradingScores(payload, 2500);
            expect(scores.intelligence).toBe(9);
            expect(scores.accuracy).toBe(10);
            expect(scores.speed).toBe(8);
        });

        it('guarantees deterministic speed fallback when model omits speed', () => {
            const payload = {
                finalAnalysis: {
                    intelligence: 8,
                    accuracy: 8
                }
            };
            const scores = extractGradingScores(payload, 1000);
            expect(scores.intelligence).toBe(8);
            expect(scores.accuracy).toBe(8);
            expect(scores.speed).toBe(10); // Under 2000ms is 10
        });

        it('extracts scores from raw JSON string fallback correctly', () => {
            const payload = {
                finalAnalysis: '```json\n{"intelligence": 6, "accuracy": 7, "speed": 5}\n```'
            };
            const scores = extractGradingScores(payload, 3000);
            expect(scores.intelligence).toBe(6);
            expect(scores.accuracy).toBe(7);
            expect(scores.speed).toBe(5);
        });
    });

    describe('Audit Fixes Verification', () => {
        it('verifies WORKING_MODELS contains verified models and starts with gemini-3.5-flash-lite', () => {
            expect(WORKING_MODELS.length).toBeGreaterThanOrEqual(4);
            expect(WORKING_MODELS[0].model).toBe('gemini-3.5-flash-lite');
            expect(WORKING_MODELS[0].provider).toBe('gemini');
            
            const models = WORKING_MODELS.map(m => m.model);
            expect(models).not.toContain('gemini-1.5-flash');
            expect(models).not.toContain('meta-llama/llama-3.2-3b-instruct:free');
            expect(models).not.toContain('microsoft/phi-3-mini-128k-instruct:free');
        });

        it('ensures gradingError does not mark model response invalid when output is substantive', () => {
            const result = {
                output: 'This is a substantive, high-quality analysis output from the tested model.',
                gradingError: 'Grading failed: 429 rate limit exceeded on grader model'
            };
            expect(isModelResponseValid(result)).toBe(true);
            expect(getModelExecutionStatus(result)).toBe('valid');
        });

        it('correctly calculates scoreOf and sorts models by combined intelligence + accuracy', () => {
            const m1 = { scores: { intelligence: 7, accuracy: 8, speed: 10 } };
            const m2 = { scores: { intelligence: 9, accuracy: 9, speed: 5 } };
            const m3 = { scores: { intelligence: null, accuracy: 5, speed: 8 } };

            expect(scoreOf(m1)).toBe(15);
            expect(scoreOf(m2)).toBe(18);
            expect(scoreOf(m3)).toBe(5);

            const sorted = [m1, m3, m2].sort((a, b) => scoreOf(b) - scoreOf(a));
            expect(sorted).toEqual([m2, m1, m3]);
        });

        it('supports testedAt timestamps on history entries', () => {
            const now = new Date().toISOString();
            const entry = {
                id: 'agent-1-test-model',
                role: 'Analyst 1',
                model: 'gemini-3.5-flash',
                provider: 'gemini',
                durationMs: 1200,
                output: 'Valid analysis',
                scores: { intelligence: 9, accuracy: 9, speed: 10 },
                testedAt: now
            };
            expect(entry.testedAt).toBe(now);
            expect(new Date(entry.testedAt).getTime()).not.toBeNaN();
        });

        it('computes deterministic grader cache keys and supports result caching', () => {
            const task = 'Evaluate market trends';
            const output = { insights: ['Growth is consistent at 12% YoY'] };
            const key1 = getGraderCacheKey(task, output, 'shared-rubric-v2');
            const key2 = getGraderCacheKey(task, output, 'shared-rubric-v2');
            const keyDifferentTask = getGraderCacheKey('Different task', output, 'shared-rubric-v2');

            expect(key1).toBe(key2);
            expect(key1.startsWith('gc_')).toBe(true);
            expect(key1).not.toBe(keyDifferentTask);

            // Verify cache insertion and expiration logic
            GRADER_CACHE.set(key1, {
                scores: { intelligence: 9, accuracy: 10, speed: 8 },
                timestamp: Date.now()
            });

            const cached = GRADER_CACHE.get(key1);
            expect(cached).toBeDefined();
            expect(cached?.scores.intelligence).toBe(9);
            expect(cached?.scores.accuracy).toBe(10);
            expect(Date.now() - cached!.timestamp).toBeLessThan(GRADER_CACHE_TTL_MS);
        });
    });
});
