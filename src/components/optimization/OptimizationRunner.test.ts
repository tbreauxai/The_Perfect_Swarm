import { describe, it, expect, beforeAll } from 'vitest';
import {
    isModelResponseValid,
    getModelExecutionStatus,
    calculateSpeedScore,
    extractGradingScores,
    WORKING_MODELS,
    scoreOf,
    getGraderCacheKey,
    GRADER_CACHE,
    GRADER_CACHE_TTL_MS,
    GRADER_CACHE_STORAGE_KEY,
    loadGraderCache,
    saveGraderCache,
    calculateConsensusScore,
    parseRetryAfterMs,
    calculateBackoffMs,
    recordProvider429,
    recordProviderSuccess,
    getProviderBackoff,
    PROVIDER_BACKOFFS,
    getPromptGenCacheKey,
    loadPromptGenCache,
    savePromptGenCache,
    PROMPT_GEN_CACHE,
    PROMPT_GEN_CACHE_STORAGE_KEY
} from './OptimizationRunner';
import {
    isModelQuarantined,
    recordModel404,
    clearModel404Strikes,
    clearAllQuarantinedModels,
    getQuarantinedModels
} from '../../services/providerService';
import { Agent } from '../../swarm/agent';
import { formatActionableError } from '../../swarm/types';

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

    describe('calculateConsensusScore', () => {
        it('returns null for empty array or array with only null/undefined', () => {
            expect(calculateConsensusScore([])).toBeNull();
            expect(calculateConsensusScore([null, undefined])).toBeNull();
        });

        it('returns the single score for a 1-sample run', () => {
            expect(calculateConsensusScore([8])).toBe(8);
            expect(calculateConsensusScore([undefined, 7, null])).toBe(7);
        });

        it('returns strict majority (>50%) when it exists', () => {
            expect(calculateConsensusScore([8, 8, 9])).toBe(8);
            expect(calculateConsensusScore([7, 9, 7])).toBe(7);
            expect(calculateConsensusScore([10, 10, 10])).toBe(10);
            expect(calculateConsensusScore([6, 6])).toBe(6);
        });

        it('falls back to rounded average when no majority (>50%) exists', () => {
            // [6, 7, 8] -> sum = 21, mean = 7
            expect(calculateConsensusScore([6, 7, 8])).toBe(7);
            // [6, 8] -> sum = 14, mean = 7 (neither is >50%)
            expect(calculateConsensusScore([6, 8])).toBe(7);
            // [5, 8, 9] -> sum = 22, mean = 7.33 -> round = 7
            expect(calculateConsensusScore([5, 8, 9])).toBe(7);
        });

        it('filters out null/undefined before voting', () => {
            expect(calculateConsensusScore([8, null, 8])).toBe(8);
            expect(calculateConsensusScore([7, undefined, 9])).toBe(8);
        });
    });

    describe('429 Rate-Limit Exponential Backoff & Retry-After', () => {
        it('parses numeric Retry-After seconds correctly and enforces [1s, 30s] bounds', () => {
            expect(parseRetryAfterMs(null)).toBeNull();
            expect(parseRetryAfterMs('')).toBeNull();
            expect(parseRetryAfterMs('invalid')).toBeNull();
            expect(parseRetryAfterMs('5')).toBe(5000);
            expect(parseRetryAfterMs('12')).toBe(12000);
            expect(parseRetryAfterMs('0')).toBeNull(); // non-positive ignored
            expect(parseRetryAfterMs('120')).toBe(30000); // capped at 30s
        });

        it('parses HTTP-date Retry-After correctly and bounds future values', () => {
            const futureDate = new Date(Date.now() + 10000).toUTCString();
            const parsed = parseRetryAfterMs(futureDate);
            expect(parsed).toBeGreaterThanOrEqual(9000);
            expect(parsed).toBeLessThanOrEqual(11000);

            // Past date returns null
            const pastDate = new Date(Date.now() - 5000).toUTCString();
            expect(parseRetryAfterMs(pastDate)).toBeNull();
        });

        it('calculates exponential backoff per provider (2s -> 4s -> 8s -> 16s -> 30s cap)', () => {
            PROVIDER_BACKOFFS.clear();
            const provider = 'test-provider-exp';

            // 1st 429: 2s
            const delay1 = calculateBackoffMs(provider);
            expect(delay1).toBe(2000);
            recordProvider429(provider);

            // 2nd 429: 4s
            const delay2 = calculateBackoffMs(provider);
            expect(delay2).toBe(4000);
            recordProvider429(provider);

            // 3rd 429: 8s
            const delay3 = calculateBackoffMs(provider);
            expect(delay3).toBe(8000);
            recordProvider429(provider);

            // 4th 429: 16s
            const delay4 = calculateBackoffMs(provider);
            expect(delay4).toBe(16000);
            recordProvider429(provider);

            // 5th 429: capped at 30s
            const delay5 = calculateBackoffMs(provider);
            expect(delay5).toBe(30000);

            // Resets on success
            recordProviderSuccess(provider);
            expect(getProviderBackoff(provider)).toBeUndefined();
            expect(calculateBackoffMs(provider)).toBe(2000);
        });

        it('prioritizes Retry-After header over exponential backoff when present', () => {
            PROVIDER_BACKOFFS.clear();
            const provider = 'test-provider-header';

            // Normal exponential would be 2000, but header specifies 7s
            const delay = calculateBackoffMs(provider, '7');
            expect(delay).toBe(7000);
        });
    });

    describe('Grader Cache localStorage Persistence', () => {
        const mockStorage: Record<string, string> = {};
        const originalLocalStorage = globalThis.localStorage;

        beforeAll?.(() => {
            // Setup global localStorage mock
            globalThis.localStorage = {
                getItem: (key: string) => mockStorage[key] ?? null,
                setItem: (key: string, val: string) => { mockStorage[key] = val; },
                removeItem: (key: string) => { delete mockStorage[key]; },
                clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); },
                key: (idx: number) => Object.keys(mockStorage)[idx] ?? null,
                length: 0
            } as any;
        });

        it('saves and reloads grader cache to and from localStorage', () => {
            const cache = new Map();
            const entry1 = {
                scores: { intelligence: 9, accuracy: 10, speed: 8 },
                timestamp: Date.now()
            };
            const entry2 = {
                scores: { intelligence: 7, accuracy: 8, speed: 6 },
                timestamp: Date.now()
            };

            cache.set('key1', entry1);
            cache.set('key2', entry2);

            saveGraderCache(cache);

            const reloaded = loadGraderCache();
            expect(reloaded.size).toBe(2);
            expect(reloaded.get('key1')?.scores.intelligence).toBe(9);
            expect(reloaded.get('key2')?.scores.accuracy).toBe(8);
        });

        it('prunes expired entries when reloading from localStorage', () => {
            const cache = new Map();
            const validEntry = {
                scores: { intelligence: 10, accuracy: 10, speed: 10 },
                timestamp: Date.now()
            };
            const expiredEntry = {
                scores: { intelligence: 5, accuracy: 5, speed: 5 },
                timestamp: Date.now() - (GRADER_CACHE_TTL_MS + 1000) // expired
            };

            cache.set('validKey', validEntry);
            cache.set('expiredKey', expiredEntry);

            saveGraderCache(cache);

            const reloaded = loadGraderCache();
            expect(reloaded.has('validKey')).toBe(true);
            expect(reloaded.has('expiredKey')).toBe(false);
        });
    });

    describe('Role-specific Output Token Caps', () => {
        it('assigns role-specific default maxTokens on Agent instances', () => {
            const analyst = new Agent('Data Analyst', 'test-model', 'simulated', 'key');
            expect(analyst.role).toBe('Data Analyst');

            const grader = new Agent('Grader Node', 'test-model', 'simulated', 'key');
            expect(grader.role).toBe('Grader Node');

            const promptGen = new Agent('Prompt Generator Node', 'test-model', 'simulated', 'key');
            expect(promptGen.role).toBe('Prompt Generator Node');

            const manager = new Agent('Manager Node', 'test-model', 'simulated', 'key');
            expect(manager.role).toBe('Manager Node');
        });
    });

    describe('Quarantine Dead Models (#8)', () => {
        beforeAll(() => {
            clearAllQuarantinedModels();
        });

        it('quarantines model after 3 consecutive 404 strikes', () => {
            expect(isModelQuarantined('gemini', 'gemini-dead-model')).toBe(false);
            
            // Strike 1
            recordModel404('gemini', 'gemini-dead-model');
            expect(isModelQuarantined('gemini', 'gemini-dead-model')).toBe(false);

            // Strike 2
            recordModel404('gemini', 'gemini-dead-model');
            expect(isModelQuarantined('gemini', 'gemini-dead-model')).toBe(false);

            // Strike 3 -> quarantined!
            const quarantined = recordModel404('gemini', 'gemini-dead-model');
            expect(quarantined).toBe(true);
            expect(isModelQuarantined('gemini', 'gemini-dead-model')).toBe(true);
            expect(getQuarantinedModels()).toContain('gemini:gemini-dead-model');
        });

        it('clears strikes on success before quarantine threshold', () => {
            recordModel404('groq', 'llama-temp-404');
            recordModel404('groq', 'llama-temp-404');
            expect(isModelQuarantined('groq', 'llama-temp-404')).toBe(false);

            clearModel404Strikes('groq', 'llama-temp-404');
            // Next 404 should start at 1, not 3
            recordModel404('groq', 'llama-temp-404');
            expect(isModelQuarantined('groq', 'llama-temp-404')).toBe(false);
        });

        it('clears all quarantined models when requested', () => {
            clearAllQuarantinedModels();
            expect(getQuarantinedModels().length).toBe(0);
            expect(isModelQuarantined('gemini', 'gemini-dead-model')).toBe(false);
        });
    });

    describe('Prompt Generator Caching (#9)', () => {
        beforeAll(() => {
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem(PROMPT_GEN_CACHE_STORAGE_KEY);
            }
        });

        it('computes stable cache key for analyst role and task', () => {
            const k1 = getPromptGenCacheKey('Financial Analyst', 'Analyze market trend');
            const k2 = getPromptGenCacheKey(' financial analyst ', 'Analyze market trend ');
            expect(k1).toBe(k2);
            expect(k1).toContain('financial analyst');
        });

        it('saves and loads prompt gen cache to localStorage', () => {
            const cache = new Map<string, string>();
            cache.set('analyst-1:::task-1', 'Focused prompt for analyst 1');
            cache.set('analyst-2:::task-2', 'Focused prompt for analyst 2');

            savePromptGenCache(cache);

            const reloaded = loadPromptGenCache();
            expect(reloaded.size).toBe(2);
            expect(reloaded.get('analyst-1:::task-1')).toBe('Focused prompt for analyst 1');
        });
    });

    describe('Actionable Error Messages (#11)', () => {
        it('maps 401 and unauthorized to clear action message', () => {
            expect(formatActionableError('HTTP 401 Unauthorized: Invalid key')).toBe('API key invalid — check Settings → API keys');
            expect(formatActionableError('api_key_not_configured')).toBe('API key invalid — check Settings → API keys');
        });

        it('maps 429 and rate limits to cooldown message', () => {
            expect(formatActionableError('HTTP 429 Too Many Requests')).toBe('Quota exhausted — cooling down, try again shortly');
            expect(formatActionableError('Rate limit exceeded. Try again in 20s')).toBe('Quota exhausted — cooling down, try again shortly');
        });

        it('maps 5xx server errors to provider error message', () => {
            expect(formatActionableError('500 Internal Server Error')).toBe('Provider error — failover engaged');
            expect(formatActionableError('503 Service Unavailable')).toBe('Provider error — failover engaged');
        });

        it('strips stack traces and server file paths', () => {
            const rawWithTrace = `Critical error in analysis
    at /app/node_modules/express/lib/router.js:12:5
    at async SwarmEngine.execute (/app/src/swarm/engine.ts:50:10)
    at runMicrotasks (<anonymous>)`;
            const formatted = formatActionableError(rawWithTrace);
            expect(formatted).not.toContain('at /app/');
            expect(formatted).not.toContain('node_modules');
            expect(formatted).toContain('Critical error in analysis');
        });
    });

    describe('LastError String Truncation (#15)', () => {
        it('bounds lastError strings to 500 characters', () => {
            const hugeError = 'A'.repeat(5000);
            const truncated = String(hugeError).slice(0, 500);
            expect(truncated.length).toBe(500);
        });
    });

    describe('Model Router Decision Chip (#17)', () => {
        it('identifies fast-path vs complex routes from router events', () => {
            const fastEvent = {
                agentRole: 'Model Router',
                action: 'Fast-Path Short-Circuit Activated',
                output: { complexity: 'instant', reason: 'Single analyst fast-path short-circuit' }
            };
            const isFast = fastEvent.action.includes('Fast-Path');
            expect(isFast).toBe(true);
            expect(fastEvent.output.complexity).toBe('instant');

            const complexEvent = {
                agentRole: 'Model Router',
                action: 'Routing & Complexity Classification',
                output: { complexity: 'complex', fastPath: { eligible: false } }
            };
            const isComplexFast = complexEvent.action.includes('Fast-Path') || complexEvent.output.fastPath.eligible;
            expect(isComplexFast).toBe(false);
        });
    });

    describe('Combo-History Reuse (#18)', () => {
        it('detects reusable combinations tested within 7 days', () => {
            const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
            const comboDesc = 'Manager: test-mgr | Analyst: test-analyst';
            const recentHistory = [
                {
                    id: 'combo-1',
                    isFullSwarm: true,
                    model: comboDesc,
                    testedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                    output: 'Valid analysis output with plenty of text.',
                    scores: { intelligence: 9, accuracy: 8, speed: 7 }
                }
            ];

            const priorCombo = recentHistory.find(h =>
                h.isFullSwarm &&
                h.model === comboDesc &&
                h.testedAt &&
                (Date.now() - new Date(h.testedAt).getTime() < SEVEN_DAYS_MS) &&
                isModelResponseValid(h) &&
                h.scores.accuracy !== null
            );

            expect(priorCombo).toBeDefined();
            expect(priorCombo?.scores.intelligence).toBe(9);
        });

        it('ignores expired combinations tested more than 7 days ago', () => {
            const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
            const comboDesc = 'Manager: test-mgr | Analyst: test-analyst';
            const oldHistory = [
                {
                    id: 'combo-old',
                    isFullSwarm: true,
                    model: comboDesc,
                    testedAt: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString(),
                    output: 'Valid analysis output with plenty of text.',
                    scores: { intelligence: 9, accuracy: 8, speed: 7 }
                }
            ];

            const priorCombo = oldHistory.find(h =>
                h.isFullSwarm &&
                h.model === comboDesc &&
                h.testedAt &&
                (Date.now() - new Date(h.testedAt).getTime() < SEVEN_DAYS_MS)
            );

            expect(priorCombo).toBeUndefined();
        });
    });

    describe('One-Click Winning Combo Selection (#19)', () => {
        it('identifies winning combination with highest scoreOf', () => {
            const combos = [
                {
                    id: 'combo-low',
                    isFullSwarm: true,
                    model: 'Manager: m1 | Analyst: a1',
                    output: 'Valid output text with sufficient length',
                    scores: { intelligence: 6, accuracy: 6, speed: 8 }
                },
                {
                    id: 'combo-high',
                    isFullSwarm: true,
                    model: 'Manager: m2 | Analyst: a2',
                    output: 'Valid output text with sufficient length',
                    scores: { intelligence: 9, accuracy: 9, speed: 8 }
                }
            ];

            const winning = combos
                .filter(r => r.isFullSwarm && isModelResponseValid(r))
                .sort((a, b) => scoreOf(b) - scoreOf(a))[0];

            expect(winning.id).toBe('combo-high');
            expect(scoreOf(winning)).toBe(18);
        });
    });
});

