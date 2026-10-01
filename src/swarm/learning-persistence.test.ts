/**
 * learning-persistence.test.ts
 * Tests for Qdrant-backed durable learning state (no live Qdrant needed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { QdrantLearningStore, LEARNING_COLLECTION } from './learning-persistence.ts';
import { SwarmKnowledgeRepository, AnalystLedger } from './feedback.ts';

/** Minimal in-memory fake of the QdrantClient surface we use. */
function makeFakeQdrant() {
    const points = new Map<string, any>();
    let collections = new Set<string>();
    return {
        points,
        async getCollections() {
            return { collections: [...collections].map((name) => ({ name })) };
        },
        async createCollection(name: string) {
            collections.add(name);
        },
        async upsert(_collection: string, { points: pts }: any) {
            for (const p of pts) points.set(String(p.id), p.payload);
        },
        async scroll(_collection: string, { limit = 500, offset }: any) {
            const ids = [...points.keys()];
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
        // ensure env doesn't leak a URL into this test
        if (process.env.QDRANT_URL) {
            expect(await store.whenReady()).toBe(true);
            return;
        }
        expect(await store.whenReady()).toBe(false);
        expect(store.enabled).toBe(false);
        await store.saveOutcome({ id: 'x' });
        await store.saveLedgerEntry('k', {});
        await store.saveProfile('r', {});
        const loaded = await store.loadAll();
        expect(loaded.outcomes).toEqual([]);
    });

    it('creates the collection and round-trips outcomes/ledger/profiles/policies', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        expect(await store.whenReady()).toBe(true);

        await store.saveOutcome({ id: 'outcome-1', workflowId: 'wf-1', appId: 'duelodds', timestamp: 123 });
        await store.saveLedgerEntry('duelodds:Quant Specialist', { wins: 2, losses: 1, pushes: 0, lastUpdated: 456 });
        await store.saveProfile('Quant Specialist', { agentRole: 'Quant Specialist', accuracyWins: 2, lastUpdated: 789 });
        await store.savePolicyGeneration(3, { foo: 1 }, 0.9);

        const loaded = await store.loadAll();
        expect(loaded.outcomes).toHaveLength(1);
        expect(loaded.outcomes[0].workflowId).toBe('wf-1');
        expect(loaded.ledger['duelodds:Quant Specialist'].wins).toBe(2);
        expect(loaded.profiles['Quant Specialist'].accuracyWins).toBe(2);
        expect(loaded.policies).toHaveLength(1);
        expect(loaded.policies[0].generation).toBe(3);
    });

    it('upserts are idempotent (no duplicates on re-save)', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        await store.whenReady();
        await store.saveOutcome({ id: 'outcome-1', workflowId: 'wf-1', appId: 'a', timestamp: 1 });
        await store.saveOutcome({ id: 'outcome-1', workflowId: 'wf-1', appId: 'a', timestamp: 1, graded: true });
        const loaded = await store.loadAll();
        expect(loaded.outcomes).toHaveLength(1);
        expect(loaded.outcomes[0].graded).toBe(true);
    });
});

describe('SwarmKnowledgeRepository persistence wiring', () => {
    it('persists outcomes on record and restores them', async () => {
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
        // give the fire-and-forget persist a tick
        await new Promise((r) => setTimeout(r, 50));

        const repo2 = new SwarmKnowledgeRepository();
        repo2.setLearningStore(store);
        const count = await repo2.restoreFromLearningStore();
        expect(count).toBe(1);
        expect(repo2.getOutcome('outcome-9')?.workflowId).toBe('wf-9');
    });
});

describe('AnalystLedger persistence wiring', () => {
    it('persists ledger entries and restores them', async () => {
        const fake = makeFakeQdrant();
        const store = new QdrantLearningStore({ client: fake as any, collection: 'test_learning' });
        await store.whenReady();

        const ledger = new AnalystLedger();
        ledger.setLearningStore(store);
        ledger.recordOutcome('duelodds', 'Quant Specialist', 'win');
        ledger.recordOutcome('duelodds', 'Quant Specialist', 'loss');
        await new Promise((r) => setTimeout(r, 50));

        const ledger2 = new AnalystLedger();
        ledger2.setLearningStore(store);
        const count = await ledger2.restoreFromLearningStore();
        expect(count).toBe(1);
        const rec = ledger2.getRecord('duelodds', 'Quant Specialist');
        expect(rec?.wins).toBe(1);
        expect(rec?.losses).toBe(1);
    });
});
