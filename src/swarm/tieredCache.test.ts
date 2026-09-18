import { describe, it, expect, beforeEach } from 'vitest';
import {
    VectorQuantizer,
    SelectiveSnapshotter,
    TieredCache,
    type SQ8Vector,
    type BinaryVector
} from './tieredCache.ts';

describe('Tiered Caching & State-Compression Suite', () => {
    describe('VectorQuantizer', () => {
        it('generates unit-normalized float embeddings from text', () => {
            const emb1 = VectorQuantizer.generateEmbedding('Database connection pool timeout in postgres cluster', 64);
            expect(emb1.length).toBe(64);

            // Verify L2 unit norm (~1.0)
            let sumSq = 0;
            for (let i = 0; i < emb1.length; i++) {
                sumSq += emb1[i] * emb1[i];
            }
            expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 3);

            // Similar texts should share high dot product
            const emb2 = VectorQuantizer.generateEmbedding('PostgreSQL database connection pool exhaustion timeout', 64);
            let dot = 0;
            for (let i = 0; i < 64; i++) {
                dot += emb1[i] * emb2[i];
            }
            expect(dot).toBeGreaterThan(0.65);
        });

        it('quantizes float vectors to SQ8 with ~4x memory reduction and minimal loss', () => {
            const raw = new Float32Array([0.15, -0.45, 0.85, 0.0, -0.92, 0.54, 0.33, -0.12]);
            const sq8: SQ8Vector = VectorQuantizer.quantizeSQ8(raw);

            expect(sq8.dimension).toBe(8);
            expect(sq8.codes.length).toBe(8);
            expect(sq8.min).toBeCloseTo(-0.92, 2);
            expect(sq8.max).toBeCloseTo(0.85, 2);
            expect(sq8.compressionRatio).toBeGreaterThan(1.5); // For small vectors; > 3.5 for 64-dim

            // 64-dim compression check
            const raw64 = VectorQuantizer.generateEmbedding('Authentication JWT token validation error', 64);
            const sq8_64 = VectorQuantizer.quantizeSQ8(raw64);
            expect(sq8_64.originalByteSize).toBe(256); // 64 * 4 bytes
            expect(sq8_64.quantizedByteSize).toBe(72);  // 64 bytes + 8 bytes bounds
            expect(sq8_64.compressionRatio).toBeGreaterThanOrEqual(3.5);

            // Dequantization fidelity
            const dequant = VectorQuantizer.dequantizeSQ8(sq8);
            for (let i = 0; i < raw.length; i++) {
                expect(dequant[i]).toBeCloseTo(raw[i], 1);
            }
        });

        it('computes asymmetric cosine similarity accurately without intermediate allocations', () => {
            const embA = VectorQuantizer.generateEmbedding('Server CPU load spike critical alert', 64);
            const sq8A = VectorQuantizer.quantizeSQ8(embA);

            // Self-similarity through SQ8 quantization should be >= 0.95
            const selfSim = VectorQuantizer.asymmetricCosineSimilarity(embA, sq8A);
            expect(selfSim).toBeGreaterThan(0.95);

            const embB = VectorQuantizer.generateEmbedding('Server CPU load spike high critical alert', 64);
            const sq8B = VectorQuantizer.quantizeSQ8(embB);

            const embC = VectorQuantizer.generateEmbedding('Unrelated user billing invoice profile', 64);
            const sq8C = VectorQuantizer.quantizeSQ8(embC);

            const simSimilar = VectorQuantizer.asymmetricCosineSimilarity(embA, sq8B);
            const simDissimilar = VectorQuantizer.asymmetricCosineSimilarity(embA, sq8C);

            expect(simSimilar).toBeGreaterThan(0.70);
            expect(simDissimilar).toBeLessThan(0.30);
            expect(simSimilar).toBeGreaterThan(simDissimilar);
        });

        it('quantizes to 1-bit binary representation achieving ~32x compression', () => {
            const raw64 = VectorQuantizer.generateEmbedding('Distributed cache synchronization error', 64);
            const bin: BinaryVector = VectorQuantizer.quantizeBinary(raw64);

            expect(bin.dimension).toBe(64);
            expect(bin.bits.length).toBe(8); // 64 bits = 8 bytes
            expect(bin.originalByteSize).toBe(256); // 256 bytes
            expect(bin.quantizedByteSize).toBe(8);   // 8 bytes
            expect(bin.compressionRatio).toBe(32);   // 32x compression!

            const bin2 = VectorQuantizer.quantizeBinary(
                VectorQuantizer.generateEmbedding('Distributed cache synchronization failure', 64)
            );
            const dist = VectorQuantizer.hammingDistance(bin, bin2);
            expect(dist).toBeLessThan(15); // Close match in Hamming space

            const sim = VectorQuantizer.binaryCosineSimilarity(bin, bin2);
            expect(sim).toBeGreaterThan(0.70);
        });
    });

    describe('SelectiveSnapshotter', () => {
        it('creates base snapshot with deterministic state hash', () => {
            const state = {
                activeAgents: ['manager', 'analyst-1'],
                insights: ['Latency nominal', 'Cache hit 99%'],
                metrics: { cpu: 12, ram: 45 }
            };

            const base = SelectiveSnapshotter.createBaseSnapshot('snapshot-1', state);
            expect(base.id).toBe('snapshot-1');
            expect(base.state).toEqual(state);
            expect(base.hash.length).toBe(8);
        });

        it('tracks delta mutations between state steps without full cloning', () => {
            const baseState = {
                phase: 'init',
                anomalies: [] as string[],
                counter: 1,
                config: { timeout: 5000 }
            };
            const base = SelectiveSnapshotter.createBaseSnapshot('base-1', baseState);

            const step1State = {
                phase: 'analyzing',
                anomalies: ['Memory spike on worker-2'],
                counter: 2,
                config: { timeout: 5000 },
                newField: 'fresh_data'
            };

            const delta1 = SelectiveSnapshotter.createDeltaSnapshot(base, baseState, step1State, 0);
            expect(delta1.baseId).toBe('base-1');
            expect(delta1.deltaIndex).toBe(0);
            expect(delta1.added).toEqual({ newField: 'fresh_data' });
            expect(delta1.updated).toEqual({
                phase: { from: 'init', to: 'analyzing' },
                anomalies: { from: [], to: ['Memory spike on worker-2'] },
                counter: { from: 1, to: 2 }
            });
            expect(delta1.removed).toEqual([]);

            // Hydrate back and verify fidelity
            const hydrated = SelectiveSnapshotter.hydrateState(base, [delta1]);
            expect(hydrated).toEqual(step1State);
        });

        it('hydrates multiple sequential deltas accurately including removals', () => {
            const baseState = { a: 1, b: 2, c: 3 };
            const base = SelectiveSnapshotter.createBaseSnapshot('base-multi', baseState);

            const delta0 = SelectiveSnapshotter.createDeltaSnapshot(
                base,
                baseState,
                { a: 10, b: 2, c: 3, d: 4 },
                0
            );

            const delta1 = SelectiveSnapshotter.createDeltaSnapshot(
                base,
                { a: 10, b: 2, c: 3, d: 4 },
                { a: 10, b: 20, d: 4 }, // c removed, b updated
                1
            );

            const hydrated = SelectiveSnapshotter.hydrateState(base, [delta0, delta1]);
            expect(hydrated).toEqual({ a: 10, b: 20, d: 4 });
            expect(hydrated.c).toBeUndefined();
        });

        it('compresses payloads via dictionary deduplication and restores losslessly', () => {
            const text = 'Manager Node executed analysis on Database Specialist. Database Specialist verified. Manager Node finalized.';
            const compressed = SelectiveSnapshotter.compressPayload(text);

            expect(compressed.dictionary.length).toBeGreaterThan(0);
            expect(compressed.reductionPercent).toBeGreaterThanOrEqual(0);

            const decompressed = SelectiveSnapshotter.decompressPayload(compressed);
            expect(decompressed).toBe(text);
        });
    });

    describe('TieredCache', () => {
        let cache: TieredCache<any>;

        beforeEach(() => {
            cache = new TieredCache({
                l1MaxEntries: 3,
                l2MaxEntries: 10,
                l2SimilarityThreshold: 0.80,
                l3MaxEntries: 20,
                quantizationMode: 'sq8'
            });
        });

        it('returns L1 hot hit on exact key match', () => {
            cache.set('task-auth', { status: 'secure', score: 98 });

            const res = cache.lookup('task-auth');
            expect(res.found).toBe(true);
            expect(res.tier).toBe('L1');
            expect(res.value).toEqual({ status: 'secure', score: 98 });
            expect(res.similarity).toBe(1.0);

            const metrics = cache.getMetrics();
            expect(metrics.l1Hits).toBe(1);
            expect(metrics.misses).toBe(0);
        });

        it('falls back to L2 warm semantic match and promotes to L1', () => {
            cache.set(
                'diagnose high memory utilization',
                { report: 'Memory leak in cache daemon' },
                'diagnose high memory utilization on server node'
            );

            // Different phrasing that misses L1 exact match but hits L2 semantic match
            const res = cache.lookup('diagnose severe memory utilization on server node');
            expect(res.found).toBe(true);
            expect(res.tier).toBe('L2');
            expect(res.similarity).toBeGreaterThan(0.75);
            expect(res.value).toEqual({ report: 'Memory leak in cache daemon' });

            const metrics = cache.getMetrics();
            expect(metrics.l2Hits).toBe(1);
            expect(metrics.promotions).toBe(1);

            // Subsequent exact lookup on the matched key is now served from L1
            const secondLookup = cache.lookup('diagnose high memory utilization');
            expect(secondLookup.found).toBe(true);
            expect(secondLookup.tier).toBe('L1');
        });

        it('evicts from L1 to L3 on capacity overflow and serves L3 hits', () => {
            // L1 capacity is 3
            cache.set('item-1', 'value-1');
            cache.set('item-2', 'value-2');
            cache.set('item-3', 'value-3');
            // Adding 4th item triggers L1 eviction and demotion to L3
            cache.set('item-4', 'value-4');

            const metrics = cache.getMetrics();
            expect(metrics.demotions).toBeGreaterThanOrEqual(1);
            expect(metrics.l1Entries).toBeLessThanOrEqual(3);

            // Clear L2 to ensure item-1 can only be found in L3
            (cache as any).l2Items = [];

            const l3Lookup = cache.lookup('item-1');
            expect(l3Lookup.found).toBe(true);
            expect(l3Lookup.tier).toBe('L3');
            expect(l3Lookup.value).toBe('value-1');
        });

        it('saves, records deltas, and hydrates state snapshots', () => {
            const baseState = { session: 'session-xyz', logs: ['initialized'], count: 0 };
            const base = cache.saveSnapshot('session-xyz', baseState);
            expect(base.id).toBe('session-xyz');

            const stepState = { session: 'session-xyz', logs: ['initialized', 'worker assigned'], count: 1 };
            const delta = cache.recordStateDelta('session-xyz', baseState, stepState);
            expect(delta).toBeDefined();

            const restored = cache.hydrateSnapshot('session-xyz');
            expect(restored).toEqual(stepState);
        });

        it('tracks comprehensive telemetry including memory savings and hit ratio', () => {
            cache.set('query-1', 'result-1');
            cache.lookup('query-1'); // L1 Hit
            cache.lookup('unseen-query'); // Miss

            const metrics = cache.getMetrics();
            expect(metrics.totalLookups).toBe(2);
            expect(metrics.overallHitRatio).toBe(0.5);
            expect(metrics.savedTokens).toBeGreaterThan(0);
            expect(metrics.memorySavedBytes).toBeGreaterThan(0);
        });
    });
});
