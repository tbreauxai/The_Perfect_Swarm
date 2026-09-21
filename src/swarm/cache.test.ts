import { describe, it, expect, beforeEach } from 'vitest';
import {
    SemanticSimilarityEngine,
    SemanticBaselineCache,
    PayloadCache,
    globalSemanticCache,
    globalPayloadCache
} from './cache.ts';
import { executeSwarmWorkflow } from './engine/index.ts';
import { ProviderRegistry } from './providers/registry.ts';

describe('SemanticSimilarityEngine', () => {
    it('normalizes text and strips punctuation correctly', () => {
        const text = '  Hello, WORLD! Analyze auth-tokens; fast... ';
        const normalized = SemanticSimilarityEngine.normalizeText(text);
        expect(normalized).toBe('hello world analyze auth tokens fast');
    });

    it('tokenizes text and removes standard stop words', () => {
        const text = 'What is the security of this authentication token and why is it failing?';
        const tokens = SemanticSimilarityEngine.tokenize(text);
        expect(tokens).toContain('security');
        expect(tokens).toContain('authentication');
        expect(tokens).toContain('token');
        expect(tokens).toContain('failing');
        expect(tokens).not.toContain('what');
        expect(tokens).not.toContain('the');
        expect(tokens).not.toContain('of');
        expect(tokens).not.toContain('this');
        expect(tokens).not.toContain('and');
    });

    it('extracts character trigrams', () => {
        const trigrams = SemanticSimilarityEngine.extractTrigrams('tokens');
        expect(trigrams.has('tok')).toBe(true);
        expect(trigrams.has('oke')).toBe(true);
        expect(trigrams.has('ken')).toBe(true);
        expect(trigrams.has('ens')).toBe(true);
        expect(trigrams.size).toBe(4);
    });

    it('computes high similarity for reworded tasks and low similarity for disjoint tasks', () => {
        const task1 = 'Audit authentication token security and JWT expiration';
        const task2 = 'Auditing auth token security & JWT expiry';
        const unrelated = 'Calculate financial ledger tax depreciation for quarterly earnings';

        const simHigh = SemanticSimilarityEngine.computeSimilarity(task1, task2);
        const simLow = SemanticSimilarityEngine.computeSimilarity(task1, unrelated);

        expect(simHigh).toBeGreaterThanOrEqual(0.75);
        expect(simLow).toBeLessThan(0.20);
    });
});

describe('SemanticBaselineCache', () => {
    let cache: SemanticBaselineCache;

    beforeEach(() => {
        cache = new SemanticBaselineCache({ maxEntries: 10, defaultTtlMs: 5000, similarityThreshold: 0.80 });
    });

    it('stores and retrieves an exact match with similarity 1.0', () => {
        const task = 'Audit system performance under high concurrency';
        const payload = { result: 'p99 latency 12ms' };

        cache.set(task, payload);
        const match = cache.findMatch(task);

        expect(match.hit).toBe(true);
        expect(match.similarity).toBe(1.0);
        expect(match.entry?.payload).toEqual(payload);
    });

    it('retrieves near-identical query above 0.80 threshold and tracks saved tokens', () => {
        const baseTask = 'Audit authentication token security and JWT expiration';
        const rewordedTask = 'Audit auth token security and JWT expiration';
        const payload = { analysis: 'Security baseline verified' };

        cache.set(baseTask, payload, { data: 'sample data block' });
        const match = cache.findMatch(rewordedTask);

        expect(match.hit).toBe(true);
        expect(match.similarity).toBeGreaterThanOrEqual(0.80);
        expect(match.entry?.payload).toEqual(payload);

        const stats = cache.getStats();
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(0);
        expect(stats.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it('rejects match below threshold and registers a cache miss', () => {
        cache.set('Analyze database query indexing bottlenecks', { optimized: true });
        const match = cache.findMatch('Render frontend react buttons in dark mode');

        expect(match.hit).toBe(false);
        expect(match.similarity).toBeLessThan(0.80);

        const stats = cache.getStats();
        expect(stats.hits).toBe(0);
        expect(stats.misses).toBe(1);
    });

    it('evicts oldest entries when exceeding maxEntries limit (LRU)', () => {
        for (let i = 0; i < 12; i++) {
            cache.set(`Task query number ${i}`, { id: i });
        }

        const stats = cache.getStats();
        expect(stats.size).toBe(10);
        expect(stats.evictions).toBe(2);
    });

    it('expires stale entries after TTL', async () => {
        const shortLru = new SemanticBaselineCache({ maxEntries: 10, defaultTtlMs: 20 });
        shortLru.set('Transient query task', { ok: true });

        await new Promise(r => setTimeout(r, 40));
        const match = shortLru.findMatch('Transient query task');
        expect(match.hit).toBe(false);
    });
});

describe('PayloadCache Integration with Semantic Baseline Cache', () => {
    it('delegates to internal semantic cache via findSemanticMatch and setSemantic', () => {
        const pc = new PayloadCache({ maxEntries: 50 });
        const task = 'Optimize memory consumption in worker pool';
        const payload = { memoryScore: 98 };

        pc.setSemantic(task, payload);
        const match = pc.findSemanticMatch('Optimizing memory consumption in worker pool');

        expect(match.hit).toBe(true);
        expect(match.entry?.payload).toEqual(payload);
    });
});

describe('Engine Step 0c Semantic Cache Integration', () => {
    beforeEach(() => {
        globalSemanticCache.clear();
        globalPayloadCache.clear();
    });

    it('serves near-identical workflow queries via Semantic Baseline Cache', async () => {
        let executionCount = 0;
        ProviderRegistry.register({
            providerName: 'custom-mock',
            async call() {
                executionCount++;
                return JSON.stringify({
                    insights: ['Mock analysis insight'],
                    anomalies: [],
                    summary: 'Mock analysis completed'
                });
            }
        });

        const initialTask = 'Audit authentication token security and JWT expiration';
        const result1 = await executeSwarmWorkflow({
            task: initialTask,
            data: 'test payload',
            forceFullSwarm: false,
            settings: {
                appId: 'test-semantic-cache',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mgr', model: 'mock-mgr' },
                    { id: 'sec', role: 'Security Analyst', provider: 'custom-mock', apiKey: 'k-sec', model: 'mock-sec' }
                ]
            }
        });

        expect(result1.finalAnalysis).toBeDefined();
        expect(executionCount).toBeGreaterThan(0);
        const initialCount = executionCount;

        // Second run with slightly reworded task
        const rewordedTask = 'Audit auth token security and JWT expiration';
        const result2 = await executeSwarmWorkflow({
            task: rewordedTask,
            data: 'test payload',
            forceFullSwarm: false,
            settings: {
                appId: 'test-semantic-cache',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mgr', model: 'mock-mgr' },
                    { id: 'sec', role: 'Security Analyst', provider: 'custom-mock', apiKey: 'k-sec', model: 'mock-sec' }
                ]
            }
        });

        // Provider should NOT have been called again!
        expect(executionCount).toBe(initialCount);
        const semanticHitEvent = result2.events.find(e => e.action === 'Cache Hit (Semantic Zero-Drift Baseline)');
        expect(semanticHitEvent).toBeDefined();
        expect(semanticHitEvent?.agentRole).toBe('Semantic Baseline Cache');
        expect(result2.finalAnalysis).toEqual(result1.finalAnalysis);
    });

    it('bypasses semantic cache when forceFullSwarm is true', async () => {
        let executionCount = 0;
        ProviderRegistry.register({
            providerName: 'custom-mock',
            async call() {
                executionCount++;
                return JSON.stringify({
                    insights: ['Mock analysis insight'],
                    anomalies: [],
                    summary: 'Mock analysis completed'
                });
            }
        });

        const task = 'Audit system bottleneck metrics';
        await executeSwarmWorkflow({
            task,
            data: 'test payload',
            forceFullSwarm: false,
            settings: {
                appId: 'test-semantic-bypass',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mgr', model: 'mock-mgr' },
                    { id: 'analyst', role: 'Performance Analyst', provider: 'custom-mock', apiKey: 'k-perf', model: 'mock-perf' }
                ]
            }
        });

        const countAfterFirst = executionCount;

        // Run again with forceFullSwarm: true
        await executeSwarmWorkflow({
            task,
            data: 'test payload',
            forceFullSwarm: true,
            settings: {
                appId: 'test-semantic-bypass',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'custom-mock', apiKey: 'k-mgr', model: 'mock-mgr' },
                    { id: 'analyst', role: 'Performance Analyst', provider: 'custom-mock', apiKey: 'k-perf', model: 'mock-perf' }
                ]
            }
        });

        expect(executionCount).toBeGreaterThan(countAfterFirst);
    });
});
