import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorageAdapter } from './inMemoryStorage.ts';
import type { StoredMemoryPoint } from '../types.ts';

describe('InMemoryStorageAdapter', () => {
    let storage: InMemoryStorageAdapter;

    beforeEach(() => {
        storage = new InMemoryStorageAdapter({ isolatedStore: true });
    });

    const createMockPoint = (
        id: string,
        content: string,
        denseVector: number[],
        appId: string = 'app-1',
        overrides: Record<string, any> = {}
    ): StoredMemoryPoint => ({
        id,
        denseVector,
        sparseVector: { indices: [1, 2], values: [0.5, 0.8] },
        payload: {
            content,
            appId,
            originApp: appId,
            domain: 'general',
            qualityRating: 0.8,
            frequency: 1,
            verified: true,
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            ...overrides
        }
    });

    it('stores and retrieves points by ID', async () => {
        const pt = createMockPoint('pt-1', 'Test memory item', [1, 0, 0]);
        const storedId = await storage.store(pt);
        expect(storedId).toBe('pt-1');
        expect(storage.size).toBe(1);

        const retrieved = await storage.get('pt-1');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.id).toBe('pt-1');
        expect(retrieved?.payload.content).toBe('Test memory item');
    });

    it('deduplicates points with >= 0.92 cosine similarity within the same appId', async () => {
        const pt1 = createMockPoint('pt-1', 'Anomaly in database pool', [1, 0, 0], 'app-1', {
            qualityRating: 0.7,
            frequency: 1
        });
        await storage.store(pt1);

        // Very similar vector [0.99, 0.01, 0] -> cosine > 0.99
        const pt2 = createMockPoint('pt-2', 'Anomaly in database pool identical', [0.999, 0.001, 0], 'app-1', {
            qualityRating: 0.9
        });
        const storedId = await storage.store(pt2, true);

        // Deduplication merges into existing point
        expect(storedId).toBe('pt-1');
        expect(storage.size).toBe(1);

        const point = await storage.get('pt-1');
        expect(point?.payload.frequency).toBe(2);
        expect(point?.payload.qualityRating).toBe(0.9);
    });

    it('does not deduplicate across different appIds even with identical vectors', async () => {
        const pt1 = createMockPoint('pt-1', 'App 1 finding', [1, 0, 0], 'app-1');
        const pt2 = createMockPoint('pt-2', 'App 2 finding', [1, 0, 0], 'app-2');

        await storage.store(pt1);
        await storage.store(pt2, true);

        expect(storage.size).toBe(2);
        expect(await storage.get('pt-1')).not.toBeNull();
        expect(await storage.get('pt-2')).not.toBeNull();
    });

    it('searches points with vector similarity and filtering', async () => {
        await storage.store(createMockPoint('pt-1', 'Postgres connection error', [1, 0, 0], 'app-1', {
            domain: 'database',
            qualityRating: 0.95
        }));
        await storage.store(createMockPoint('pt-2', 'UI rendering lag', [0, 1, 0], 'app-1', {
            domain: 'frontend',
            qualityRating: 0.6
        }));
        await storage.store(createMockPoint('pt-3', 'Postgres slow query', [0.8, 0.2, 0], 'app-2', {
            domain: 'database',
            qualityRating: 0.9
        }));

        // Search for database domain in app-1
        const results = await storage.search([1, 0, 0], {
            appId: 'app-1',
            includeShared: false,
            domain: 'database',
            minRating: 0.8
        });

        expect(results.length).toBe(1);
        expect(results[0].id).toBe('pt-1');
        expect(results[0].vectorScore).toBeCloseTo(1.0, 3);
    });

    it('updates payload partially with setPayload', async () => {
        await storage.store(createMockPoint('pt-1', 'Initial', [1, 0, 0]));
        const updated = await storage.setPayload('pt-1', {
            qualityRating: 0.99,
            feedback: 'Audited and verified'
        });

        expect(updated).toBe(true);
        const pt = await storage.get('pt-1');
        expect(pt?.payload.qualityRating).toBe(0.99);
        expect(pt?.payload.feedback).toBe('Audited and verified');
    });

    it('deletes points by ID and wipes by appId', async () => {
        await storage.store(createMockPoint('pt-1', 'Item 1', [1, 0, 0], 'app-1'));
        await storage.store(createMockPoint('pt-2', 'Item 2', [0, 1, 0], 'app-1'));
        await storage.store(createMockPoint('pt-3', 'Item 3', [0, 0, 1], 'app-2'));

        expect(storage.size).toBe(3);

        await storage.delete(['pt-1']);
        expect(storage.size).toBe(2);
        expect(await storage.get('pt-1')).toBeNull();

        await storage.wipe('app-1');
        expect(storage.size).toBe(1);
        expect(await storage.get('pt-3')).not.toBeNull();
    });

    it('scrolls points with filter options', async () => {
        await storage.store(createMockPoint('pt-1', 'A', [1, 0, 0], 'app-1', { domain: 'math' }));
        await storage.store(createMockPoint('pt-2', 'B', [0, 1, 0], 'app-1', { domain: 'science' }));
        await storage.store(createMockPoint('pt-3', 'C', [0, 0, 1], 'app-2', { domain: 'math' }));

        const app1Math = await storage.scroll({ appId: 'app-1', domain: 'math' });
        expect(app1Math.length).toBe(1);
        expect(app1Math[0].id).toBe('pt-1');

        const all = await storage.scroll();
        expect(all.length).toBe(3);
    });

    it('reports sub-linear index metrics', async () => {
        await storage.store(createMockPoint('pt-1', 'A', [1, 0, 0]));
        const metrics = storage.getIndexMetrics?.();
        expect(metrics).toBeDefined();
        expect(metrics?.size).toBe(1);
    });
});
