/**
 * learning-persistence.test.ts
 * Tests for Qdrant-backed durable learning state (no live Qdrant needed).
 */
import { describe, it, expect, vi } from 'vitest';
import { QdrantLearningStore, LEARNING_COLLECTION } from './learning-persistence.ts';
import { SwarmKnowledgeRepository, AnalystLedger } from './feedback.ts';

/** Minimal in-memory fake of the QdrantClient surface we use. */
function makeFakeQdrant() {
    const points = new Map<string, any>();
    let collections = new Set<string>();
    const upsertCalls: any[] = [];
    const indexCalls: any[] = [];

    return {
        points,
        upsertCalls,
        indexCalls,
        async getCollections() {
            return { collections: [...collections].map((name) => ({ name })) };
        },
        async createCollection(name: string) {
            collections.add(name);
        },
        async createPayloadIndex(name: string, schema: any) {
            indexCalls.push({ name, schema });
            return true;
        },
        async upsert(_collection: string, { points: pts }: any) {
            upsertCalls.push(pts);
            for (const p of pts) points.set(String(p.id), p.payload);
        },
        async scroll(_collection: string, { limit = 500, offset, filter }: any) {
            let ids = [...points.keys()];
            if (filter?.must) {
                for (const cond of filter.must) {
                    if (cond.key === 'ts' && cond.range?.gte !== undefined) {
                        const minTs = cond.range.gte;
                        ids = ids.filter(id => (points.get(id)?.ts ?? 0) >= minTs);
                    }
                }
            }
            const start = offset ? ids.indexOf(String(offset)) + 1 : 0;
            const slice = ids.slice(start, start + limit);
            const next = start + limit < ids.length ? slice[slice.length - 1] : null;
            return {
                points: slice.map((id) => ({ id, payload: points.get(id) })),
                next_page_offset: next
            };
        }
    };
}

describe('QdrantLearningStore', () => {
    it('stays disabled with no Qdrant URL and no-ops safely', async () => {
        const store = new QdrantLearningStore({ url: undefined, apiKey: undefined });
        if (process.env.QDRANT_URL) {
            expect(await store.whenReady()).toBe(true);
            return;
        }
        expect(await store.whenReady()).toBe(false);
        expect(store.enabled).toBe(false);
        await store.saveOutcome({ id: 'x' });
        await store.saveLedgerEntry('k', {});
        await store.saveProfile('r', {});
        await store.flush();
        const loaded = await store.loadAll();
        expect(loaded.outcomes).toEqual([]);
    });

    it('creates the collection, creates ts index, and round-trips state with flush()', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        expect(await store.whenReady()).toBe(true);

        expect(fake.indexCalls).toContainEqual(
            expect.objectContaining({ schema: { field_name: 'ts', field_schema: 'integer' } })
        );

        await store.saveOutcome({ id: 'outcome-1', workflowId: 'wf-1', appId: 'duelodds', timestamp: 123 });
        await store.saveLedgerEntry('duelodds:Quant Specialist', { wins: 2, losses: 1, pushes: 0, lastUpdated: 456 });
        await store.saveProfile('Quant Specialist', { agentRole: 'Quant Specialist', accuracyWins: 2, lastUpdated: 789 });
        await store.savePolicyGeneration(3, { foo: 1 }, 0.9);

        // Explicit flush ensures all buffered writes are committed immediately
        await store.flush();

        // 4 writes should be batched together in fewer upsert calls than 4
        expect(fake.upsertCalls.length).toBeLessThanOrEqual(2);

        const loaded = await store.loadAll();
        expect(loaded.outcomes).toHaveLength(1);
        expect(loaded.outcomes[0].workflowId).toBe('wf-1');
        expect(loaded.ledger['duelodds:Quant Specialist'].wins).toBe(2);
        expect(loaded.profiles['Quant Specialist'].accuracyWins).toBe(2);
        expect(loaded.policies).toHaveLength(1);
        expect(loaded.policies[0].generation).toBe(3);
    });

    it('micro-batches rapid writes into single multi-point upsert on debounce flush', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({
            client: fake as any,
            collection: 'test_learning_batch',
            debounceMs: 20
        });
        await store.whenReady();

        await store.saveOutcome({ id: 'o1', timestamp: 100 });
        await store.saveOutcome({ id: 'o2', timestamp: 101 });
        await store.saveOutcome({ id: 'o3', timestamp: 102 });

        // Wait for debounce timer (20ms) to fire
        await new Promise((r) => setTimeout(r, 60));

        // Should have coalesced all 3 writes into 1 upsert call with 3 points
        expect(fake.upsertCalls.length).toBe(1);
        expect(fake.upsertCalls[0].length).toBe(3);
    });

    it('flushes immediately when maxBatchSize is reached', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({
            client: fake as any,
            collection: 'test_learning_max',
            maxBatchSize: 5,
            debounceMs: 5000 // Very long timer
        });
        await store.whenReady();

        for (let i = 0; i < 5; i++) {
            await store.saveOutcome({ id: `batch-item-${i}` });
        }

        // Reaching maxBatchSize 5 must have flushed immediately without waiting for debounce
        expect(fake.upsertCalls.length).toBe(1);
        expect(fake.upsertCalls[0].length).toBe(5);
    });

    it('supports incremental loading with sinceTimestamp watermark', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning_watermark' });
        await store.whenReady();

        await store.saveOutcome({ id: 'old-1', timestamp: 1000 });
        await store.saveOutcome({ id: 'old-2', timestamp: 2000 });
        await store.saveOutcome({ id: 'new-1', timestamp: 5000 });
        await store.flush();

        // Without sinceTimestamp: cold start loads all
        const allLoaded = await store.loadAll();
        expect(allLoaded.outcomes).toHaveLength(3);

        // With sinceTimestamp: incremental hot reload loads only newer records
        const incremental = await store.loadAll(3000);
        expect(incremental.outcomes).toHaveLength(1);
        expect(incremental.outcomes[0].id).toBe('new-1');
    });

    it('upserts are idempotent (no duplicates on re-save)', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        await store.whenReady();
        await store.saveOutcome({ id: 'outcome-1', workflowId: 'wf-1', appId: 'a', timestamp: 1 });
        await store.saveOutcome({ id: 'outcome-1', workflowId: 'wf-1', appId: 'a', timestamp: 1, graded: true });
        await store.flush();
        const loaded = await store.loadAll();
        expect(loaded.outcomes).toHaveLength(1);
        expect(loaded.outcomes[0].graded).toBe(true);
    });
});

describe('SwarmKnowledgeRepository persistence wiring', () => {
    it('persists outcomes on record and restores them with flush()', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        await store.whenReady();

        const repo = new SwarmKnowledgeRepository();
        repo.setLearningStore(store);
        await repo.recordOutcome({
            id: 'outcome-9',
            workflowId: 'wf-9',
            task: 't',
            appId: 'duelodds',
            finalInsightSnippet: '',
            metrics: {} as any,
            reward: {} as any,
            parametersUsed: {} as any,
            driftAlerts: [],
            agentRoles: ['Quant Specialist'],
            timestamp: Date.now()
        } as any);

        await repo.flush();

        const repo2 = new SwarmKnowledgeRepository();
        repo2.setLearningStore(store);
        const count = await repo2.restoreFromLearningStore();
        expect(count).toBe(1);
        expect(repo2.getOutcome('outcome-9')?.workflowId).toBe('wf-9');
    });
});

describe('AnalystLedger persistence wiring', () => {
    it('persists ledger entries and restores them with flush()', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        await store.whenReady();

        const ledger = new AnalystLedger();
        ledger.setLearningStore(store);
        ledger.recordOutcome('duelodds', 'Quant Specialist', 'win');
        ledger.recordOutcome('duelodds', 'Quant Specialist', 'loss');

        await ledger.flush();

        const ledger2 = new AnalystLedger();
        ledger2.setLearningStore(store);
        const count = await ledger2.restoreFromLearningStore();
        expect(count).toBe(1);
        const rec = ledger2.getRecord('duelodds', 'Quant Specialist');
        expect(rec?.wins).toBe(1);
        expect(rec?.losses).toBe(1);
    });
});
