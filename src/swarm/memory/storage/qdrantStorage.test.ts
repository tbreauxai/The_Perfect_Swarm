import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantStorageAdapter } from './qdrantStorage.ts';
import type { StoredMemoryPoint } from '../types.ts';

describe('QdrantStorageAdapter', () => {
    let mockClient: any;
    let adapter: QdrantStorageAdapter;

    beforeEach(() => {
        mockClient = {
            getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'test_cortex' }] }),
            getCollection: vi.fn().mockResolvedValue({ payload_schema: {} }),
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

    it('skips redundant payload index creation when indexes already exist in schema', async () => {
        mockClient.getCollection.mockResolvedValueOnce({
            payload_schema: {
                originApp: { data_type: 'keyword' },
                domain: { data_type: 'keyword' },
                memoryType: { data_type: 'keyword' },
                entityIds: { data_type: 'keyword' },
                workflowId: { data_type: 'keyword' },
                appId: { data_type: 'keyword' },
                targetApps: { data_type: 'keyword' },
                agentRole: { data_type: 'keyword' },
                qualityRating: { data_type: 'float' },
                verified: { data_type: 'bool' }
                // Notice outcome, gradedAt, and feedbackProcessed are missing!
            }
        });

        const customAdapter = new QdrantStorageAdapter({
            collectionName: 'test_cortex_schema',
            client: mockClient
        });
        mockClient.getCollections.mockResolvedValueOnce({ collections: [{ name: 'test_cortex_schema' }] });

        await customAdapter.initialize('test-app');

        // Should only create missing indexes: outcome, gradedAt, feedbackProcessed
        expect(mockClient.createPayloadIndex).toHaveBeenCalledTimes(3);
        expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('test_cortex_schema', {
            field_name: 'outcome',
            field_schema: 'keyword'
        });
        expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('test_cortex_schema', {
            field_name: 'gradedAt',
            field_schema: 'keyword'
        });
        expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('test_cortex_schema', {
            field_name: 'feedbackProcessed',
            field_schema: 'bool'
        });
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

    it('storeBatch defaults to fast bulk upsert without deduplication', async () => {
        const pts = [createMockPoint('batch-1'), createMockPoint('batch-2')];
        const ids = await adapter.storeBatch(pts);

        expect(ids).toEqual(['batch-1', 'batch-2']);
        expect(mockClient.upsert).toHaveBeenCalledWith('test_cortex', {
            wait: false,
            points: expect.arrayContaining([
                expect.objectContaining({ id: 'batch-1' }),
                expect.objectContaining({ id: 'batch-2' })
            ])
        });
        expect(mockClient.query).not.toHaveBeenCalled(); // No deduplication query
    });

    it('storeBatch executes per-point deduplication when requested', async () => {
        const pts = [createMockPoint('batch-dup-1'), createMockPoint('batch-dup-2')];
        const ids = await adapter.storeBatch(pts, { deduplicate: true });

        expect(ids).toEqual(['batch-dup-1', 'batch-dup-2']);
        // Query called for duplicate check on each point
        expect(mockClient.query).toHaveBeenCalledTimes(2);
    });

    it('searches points with configurable RRF and prefetch parameters', async () => {
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
            { appId: 'test-app', limit: 5, rrfK: 45, prefetchFactor: 2, hnswEf: 128 },
            { indices: [1], values: [0.8] }
        );

        expect(results.length).toBe(1);
        expect(mockClient.query).toHaveBeenCalledWith('test_cortex', expect.objectContaining({
            query: { rrf: { k: 45 } },
            prefetch: expect.arrayContaining([
                expect.objectContaining({
                    using: 'dense',
                    limit: 40, // (max(5, 5) * 4) * 2 = 20 * 2 = 40
                    params: { hnsw_ef: 128 }
                })
            ])
        }));
    });

    it('paginates through multiple scroll pages with next_page_offset and DuelOdds filter', async () => {
        mockClient.scroll
            .mockResolvedValueOnce({
                points: [
                    { id: 'p1', vector: [0.1], payload: { appId: 'duelodds', content: 'c1' } },
                    { id: 'p2', vector: [0.2], payload: { originApp: 'duelodds', content: 'c2' } }
                ],
                next_page_offset: 'offset-page-2'
            })
            .mockResolvedValueOnce({
                points: [
                    { id: 'p3', vector: [0.3], payload: { appId: 'duelodds', content: 'c3' } }
                ],
                next_page_offset: null
            });

        const points = await adapter.scroll({ appId: 'duelodds' });

        expect(points.length).toBe(3);
        expect(mockClient.scroll).toHaveBeenCalledTimes(2);

        // Verify DuelOdds safeguard: filter includes appId and originApp disjunction
        expect(mockClient.scroll).toHaveBeenCalledWith('test_cortex', expect.objectContaining({
            filter: {
                must: [
                    {
                        should: [
                            { key: 'appId', match: { value: 'duelodds' } },
                            { key: 'originApp', match: { value: 'duelodds' } }
                        ]
                    }
                ]
            }
        }));
    });

    it('respects maxPoints safety cap during scroll pagination', async () => {
        mockClient.scroll.mockResolvedValue({
            points: [
                { id: 'p1', vector: [0.1], payload: {} },
                { id: 'p2', vector: [0.2], payload: {} },
                { id: 'p3', vector: [0.3], payload: {} }
            ],
            next_page_offset: 'some-offset'
        });

        const points = await adapter.scroll({ maxPoints: 2 });
        expect(points.length).toBe(2);
    });

    it('supports custom HNSW and quantization profiles on collection creation', async () => {
        mockClient.getCollections.mockResolvedValueOnce({ collections: [] });

        const customAdapter = new QdrantStorageAdapter({
            collectionName: 'custom_hnsw_col',
            client: mockClient,
            hnswConfig: { m: 32, ef_construct: 256 },
            quantizationConfig: { scalar: { type: 'int8', quantile: 0.95 } }
        });

        await customAdapter.initialize('test-app');

        expect(mockClient.createCollection).toHaveBeenCalledWith('custom_hnsw_col', expect.objectContaining({
            hnsw_config: expect.objectContaining({ m: 32, ef_construct: 256 }),
            quantization_config: { scalar: { type: 'int8', quantile: 0.95 } }
        }));
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
