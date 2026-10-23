import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CortexPersistenceManager } from './cortexPersistence.ts';
import { InMemoryStorageAdapter } from '../storage/inMemoryStorage.ts';
import type { StoredMemoryPoint } from '../types.ts';

describe('CortexPersistenceManager', () => {
    let storage: InMemoryStorageAdapter;
    let persistence: CortexPersistenceManager;
    const testPersistPath = path.join(process.cwd(), '.test-cortex-persist.json');

    beforeEach(() => {
        storage = new InMemoryStorageAdapter({ isolatedStore: true });
        persistence = new CortexPersistenceManager({
            storage,
            persistPath: testPersistPath,
            autoSave: true
        });
    });

    afterEach(() => {
        if (fs.existsSync(testPersistPath)) {
            try {
                fs.unlinkSync(testPersistPath);
            } catch {}
        }
    });

    const createMockPoint = (id: string, content: string = 'Test Content', vector: number[] = [0.1, 0.2, 0.3]): StoredMemoryPoint => ({
        id,
        denseVector: vector,
        sparseVector: { indices: [1], values: [1.0] },
        payload: {
            content,
            appId: 'test-app',
            originApp: 'test-app',
            domain: 'general',
            frequency: 1,
            qualityRating: 0.9,
            verified: true,
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        }
    });

    it('exports a snapshot containing all stored points', async () => {
        await storage.store(createMockPoint('pt-1', 'Knowledge 1', [1, 0, 0]));
        await storage.store(createMockPoint('pt-2', 'Knowledge 2', [0, 1, 0]));

        const snapshot = await persistence.exportSnapshot();
        expect(snapshot.pointCount).toBe(2);
        expect(snapshot.memories.length).toBe(2);
        expect(snapshot.memories.map(m => m.id)).toEqual(['pt-1', 'pt-2']);
    });

    it('saves snapshot to disk and reloads it cleanly', async () => {
        await storage.store(createMockPoint('pt-disk', 'Persisted knowledge'));
        const savedPath = await persistence.saveToFile(testPersistPath);
        expect(fs.existsSync(savedPath)).toBe(true);

        const newStorage = new InMemoryStorageAdapter({ isolatedStore: true });
        const newPersistence = new CortexPersistenceManager({
            storage: newStorage,
            persistPath: testPersistPath
        });

        const loadResult = await newPersistence.loadFromFile(testPersistPath);
        expect(loadResult.imported).toBe(1);
        expect(newStorage.size).toBe(1);

        const loadedPoint = await newStorage.get('pt-disk');
        expect(loadedPoint?.payload.content).toBe('Persisted knowledge');
    });

    it('imports memories from JSON string with deduplication', async () => {
        await storage.store(createMockPoint('pt-1', 'Initial knowledge'));

        const payloadStr = JSON.stringify({
            version: '1.0.0',
            exportedAt: new Date().toISOString(),
            collectionName: 'test',
            pointCount: 1,
            memories: [
                {
                    id: 'pt-1',
                    content: 'Initial knowledge duplicate',
                    metadata: {
                        appId: 'test-app',
                        originApp: 'test-app',
                        domain: 'general',
                        qualityRating: 0.95
                    },
                    denseVector: [0.1, 0.2, 0.3]
                }
            ]
        });

        const result = await persistence.importMemories(payloadStr, { deduplicate: true });
        expect(result.deduplicated).toBe(1);
        expect(storage.size).toBe(1);
    });
});
