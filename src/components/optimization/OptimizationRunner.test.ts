import { describe, it, expect } from 'vitest';
import {
    isModelResponseValid,
    getModelExecutionStatus,
    calculateSpeedScore,
    extractGradingScores
} from './OptimizationRunner/utils.ts';

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
});
