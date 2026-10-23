import type { StorageBackend } from '../storage/types.ts';
import { SparseTokenizer } from '../tokenizer.ts';
import type {
    ExportMemoriesOptions,
    MemorySnapshotPoint,
    MemorySnapshot,
    ImportMemoriesOptions,
    ImportMemoriesResult,
    StoredMemoryPoint,
    SparseVector
} from '../types.ts';

export interface CortexPersistenceConfig {
    storage: StorageBackend;
    persistPath?: string;
    autoSave?: boolean;
    collectionName?: string;
    defaultAppId?: string;
    embedder?: (text: string) => Promise<number[]>;
}

export class CortexPersistenceManager {
    private storage: StorageBackend;
    private persistPath?: string;
    private autoSave: boolean;
    private collectionName: string;
    private defaultAppId: string;
    private embedder?: (text: string) => Promise<number[]>;
    private isAutoLoading: boolean = false;

    constructor(config: CortexPersistenceConfig) {
        this.storage = config.storage;
        this.persistPath = config.persistPath;
        this.autoSave = config.autoSave !== false;
        this.collectionName = config.collectionName || 'pwa_swarm_dev_cortex_v2';
        this.defaultAppId = config.defaultAppId || 'default';
        this.embedder = config.embedder;
    }

    /**
     * Exports all stored memories matching options into a portable snapshot structure.
     */
    async exportSnapshot(options?: ExportMemoriesOptions): Promise<MemorySnapshot> {
        const includeVectors = options?.includeVectors !== false;
        const points = await this.storage.scroll({
            appId: options?.appId,
            minRating: options?.minRating,
            verifiedOnly: options?.verifiedOnly
        });

        const snapshotPoints: MemorySnapshotPoint[] = points.map(pt => ({
            id: pt.id,
            content: pt.payload.content,
            metadata: { ...pt.payload },
            denseVector: includeVectors ? pt.denseVector : undefined,
            sparseVector: includeVectors ? pt.sparseVector : undefined
        }));

        return {
            version: '1.0.0',
            exportedAt: new Date().toISOString(),
            collectionName: this.collectionName,
            pointCount: snapshotPoints.length,
            memories: snapshotPoints
        };
    }

    /**
     * Saves snapshot to a local file (JSON or JSONL).
     */
    async saveToFile(filePath?: string, options?: ExportMemoriesOptions): Promise<string> {
        const targetPath = filePath || this.persistPath;
        if (!targetPath) {
            throw new Error('[CortexPersistenceManager] saveToFile requires a filePath or configured persistPath');
        }

        let fs, path;
        try {
            fs = await import('no' + 'de:fs');
            path = await import('no' + 'de:path');
        } catch {
            throw new Error('[CortexPersistenceManager] Local file saving not supported in this environment.');
        }

        const dir = path.dirname(targetPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const isJsonl = targetPath.endsWith('.jsonl');
        const snapshot = await this.exportSnapshot(options);
        const content = isJsonl
            ? snapshot.memories.map(m => JSON.stringify(m)).join('\n')
            : JSON.stringify(snapshot, null, 2);

        fs.writeFileSync(targetPath, content, 'utf-8');
        return targetPath;
    }

    /**
     * Loads memories from a local snapshot file.
     */
    async loadFromFile(
        filePath?: string,
        options?: ImportMemoriesOptions
    ): Promise<ImportMemoriesResult> {
        const targetPath = filePath || this.persistPath;
        if (!targetPath) {
            throw new Error('[CortexPersistenceManager] loadFromFile requires a filePath or configured persistPath');
        }

        let fs;
        try {
            fs = await import('no' + 'de:fs');
        } catch {
            throw new Error('[CortexPersistenceManager] Local file loading not supported in this environment.');
        }

        if (!fs.existsSync(targetPath)) {
            throw new Error(`[CortexPersistenceManager] Snapshot file not found: ${targetPath}`);
        }

        const raw = fs.readFileSync(targetPath, 'utf-8');
        return await this.importMemories(raw, options);
    }

    /**
     * Imports memories from string, JSON, or snapshot object into the storage backend.
     */
    async importMemories(
        input: MemorySnapshot | string | any[],
        options?: ImportMemoriesOptions
    ): Promise<ImportMemoriesResult> {
        const deduplicate = options?.deduplicate !== false;
        const recomputeVectors = options?.recomputeVectors ?? false;
        const targetAppId = options?.targetAppId;
        const minRating = options?.minRating;

        let rawItems: any[] = [];

        if (typeof input === 'string') {
            const trimmed = input.trim();
            if (trimmed.startsWith('{') && !trimmed.includes('\n{"')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    rawItems = parsed.memories && Array.isArray(parsed.memories) ? parsed.memories : [parsed];
                } catch {
                    rawItems = trimmed.split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l));
                }
            } else {
                rawItems = trimmed.split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0)
                    .map(l => {
                        try {
                            return JSON.parse(l);
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean);
            }
        } else if (Array.isArray(input)) {
            rawItems = input;
        } else if (input && typeof input === 'object' && Array.isArray((input as any).memories)) {
            rawItems = (input as any).memories;
        }

        let imported = 0;
        let skipped = 0;
        let deduplicated = 0;
        const importedIds: string[] = [];

        for (const item of rawItems) {
            const content = item.content || item.payload?.content || '';
            const metadata = item.metadata || item.payload || {};
            const itemRating = metadata.qualityRating ?? 0.5;

            if (minRating !== undefined && itemRating < minRating) {
                skipped++;
                continue;
            }

            const originApp = targetAppId || metadata.originApp || metadata.appId || this.defaultAppId;
            const now = new Date().toISOString();

            let denseVec = item.denseVector || item.vector?.dense;
            if (recomputeVectors || !denseVec) {
                if (this.embedder) {
                    denseVec = await this.embedder(content);
                } else {
                    denseVec = new Array(768).fill(0);
                }
            }

            let sparseVec = item.sparseVector || item.vector?.sparse;
            if (!sparseVec || sparseVec.indices?.length === 0) {
                sparseVec = SparseTokenizer.encode(content);
            }

            const ptId = item.id || crypto.randomUUID();
            const existingBefore = await this.storage.get(ptId);

            const point: StoredMemoryPoint = {
                id: ptId,
                denseVector: denseVec,
                sparseVector: sparseVec,
                payload: {
                    content,
                    frequency: metadata.frequency || 1,
                    qualityRating: itemRating,
                    verified: metadata.verified ?? false,
                    timestamp: metadata.timestamp || now,
                    lastSeen: metadata.lastSeen || now,
                    ...metadata,
                    originApp,
                    appId: originApp
                }
            };

            const storedId = await this.storage.store(point, deduplicate);
            if (storedId) {
                if (existingBefore || storedId !== ptId) {
                    deduplicated++;
                    importedIds.push(storedId);
                } else {
                    imported++;
                    importedIds.push(storedId);
                }
            } else {
                skipped++;
            }
        }

        await this.autoSaveIfConfigured();

        return {
            imported,
            skipped,
            deduplicated,
            importedIds
        };
    }

    async autoSaveIfConfigured(): Promise<void> {
        if (!this.persistPath || !this.autoSave || this.isAutoLoading) return;
        try {
            await this.saveToFile(this.persistPath);
        } catch (err: any) {
            console.warn(`[CortexPersistenceManager] Auto-save to '${this.persistPath}' failed: ${err.message || err}`);
        }
    }

    async autoLoadIfConfigured(): Promise<void> {
        if (!this.persistPath) return;
        try {
            const fs = await import('no' + 'de:fs');
            if (fs.existsSync(this.persistPath)) {
                const raw = fs.readFileSync(this.persistPath, 'utf-8');
                if (raw.trim().length > 0) {
                    this.isAutoLoading = true;
                    try {
                        await this.importMemories(raw, { deduplicate: true, recomputeVectors: false });
                    } finally {
                        this.isAutoLoading = false;
                    }
                }
            }
        } catch (err: any) {
            console.warn(`[CortexPersistenceManager] Auto-load from '${this.persistPath}' failed: ${err.message || err}`);
        }
    }
}
