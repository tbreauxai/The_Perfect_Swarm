import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantStorageAdapter } from './qdrantStorage.ts';
import type { StoredMemoryPoint } from '../types.ts';

describe('QdrantStorageAdapter', () => {
    let mockClient: any;
    let adapter: QdrantStorageAdapter;

    beforeEach(() => {
        mockClient = {
            getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test_cortex' }] }),
            createCollection: vi.fn().mockResolvedValue(true),
            createPayloadIndex: vi.fn().mockResolvedValue(true),
            query: vi.fn().mockResolvedValue({ points: [] }),
            upsert: vi.fn().mockResolvedValue({ status: 'completed' }),
            setPayload: vi.fn().mockResolvedValue({ status: 'completed' }),
            retrieve: vi.fn().mockResolvedValue([]),
            delete: vi.fn().mockResolvedValue({ status: 'completed' }),
            deleteCollection: vi.fn().mockResolvedValue(true),
            scroll: vi.fn().mockResolvedValue({ points: [] })
        };

        adapter = new QdrantStorageAdapter({
            collectionName: 'test_cortex',
            client: mockClient
        });
    });

    const createMockPoint = (id: string, content: string = 'Test'): StoredMemoryPoint => ({
        id,
        denseVector: [0.1, 0.2, 0.3],
        sparseVector: { indices: [1], values: [0.9] },
        payload: {
            content,
            appId: 'test-app',
            originApp: 'test-app',
            domain: 'general',
            frequency: 1,
            qualityRating: 0.8,
            verified: true,
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        }
    });

    it('reports available when valid client is provided', () => {
        expect(adapter.isAvailable).toBe(true);
    });

    it('initializes collection and creates payload indexes', async () => {
        const initialized = await adapter.initialize('test-app');
        expect(initialized).toBe(true);
        expect(mockClient.getCollections).toHaveBeenCalled();
        expect(mockClient.createPayloadIndex).toHaveBeenCalled();
    });

    it('stores new points via upsert', async () => {
        const pt = createMockPoint('pt-1', 'Sample knowledge');
        const storedId = await adapter.store(pt, true);

        expect(storedId).toBe('pt-1');
        expect(mockClient.upsert).toHaveBeenCalledWith('test_cortex', {
            wait: false,
            points: [
                {
                    id: 'pt-1',
                    vector: {
                        dense: pt.denseVector,
                        sparse: pt.sparseVector
                    },
                    payload: pt.payload
                }
            ]
        });
    });

    it('merges similar points when deduplication threshold is met', async () => {
        mockClient.query.mockResolvedValueOnce({
            points: [
                {
                    id: 'existing-pt',
                    score: 0.95,
                    payload: {
                        content: 'Existing knowledge',
                        frequency: 2,
                        qualityRating: 0.7
                    }
                }
            ]
        });

        const pt = createMockPoint('pt-2', 'Similar knowledge');
        const storedId = await adapter.store(pt, true);

        expect(storedId).toBe('existing-pt');
        expect(mockClient.setPayload).toHaveBeenCalled();
    });

    it('searches points with dense and sparse query vectors', async () => {
        mockClient.query.mockResolvedValueOnce({
            points: [
                {
                    id: 'pt-hit-1',
                    score: 0.91,
                    payload: { content: 'Hit 1' }
                }
            ]
        });

        const results = await adapter.search(
            [0.1, 0.2, 0.3],
            { appId: 'test-app', limit: 5 },
            { indices: [1], values: [0.8] }
        );

        expect(results.length).toBe(1);
        expect(results[0].id).toBe('pt-hit-1');
        expect(results[0].vectorScore).toBe(0.91);
    });

    it('deletes and wipes points', async () => {
        const deleted = await adapter.delete(['pt-1', 'pt-2']);
        expect(deleted).toBe(true);
        expect(mockClient.delete).toHaveBeenCalledWith('test_cortex', {
            wait: true,
            points: ['pt-1', 'pt-2']
        });

        const wiped = await adapter.wipe('test-app');
        expect(wiped).toBe(true);
        expect(mockClient.delete).toHaveBeenCalled();
    });
});
