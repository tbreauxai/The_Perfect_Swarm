import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import { type VectorIndexMetrics } from '../vectorIndex.ts';
import { SemanticCacheInterceptor, type SemanticCacheStats } from '../semanticCacheInterceptor.ts';
import { ActionPlanCacheInterceptor, type ActionPlanCacheStats, type ActionPlan, type ActionPlanInput, type ActionPlanCacheLookupResult } from '../actionPlanCache.ts';
import { SparseTokenizer } from './tokenizer.ts';
import { GeminiEmbeddingProvider, DeterministicLocalEmbeddingProvider } from './embeddings.ts';
import { collectCortexDiagnostics } from './diagnostics.ts';
import { globalTelemetryCollector } from '../telemetry.ts';
import { InMemoryStorageAdapter } from './storage/inMemoryStorage.ts';
import { QdrantStorageAdapter, toValidQdrantId } from './storage/qdrantStorage.ts';
import { matchesScopedMemoryFilter, type StorageBackend } from './storage/types.ts';
import { RrfRanker } from './ranking/rrfRanker.ts';
import { CortexPersistenceManager } from './persistence/cortexPersistence.ts';
import { CortexConsolidator } from './consolidation/cortexConsolidator.ts';
import {
    DEFAULT_CORTEX_COLLECTION,
    isGradedWagerLoss,
    isGradedWagerWin,
    isSafeExemplarRecord,
    isSafeRetrievedBaseline,
    resolveCortexCollectionName,
    sanitizeMemoryWrite
} from './memorySanitizer.ts';
import {
    type MemoryMetadata,
    type RetrievalOptions,
    type ConsolidationOptions,
    type ConsolidationResult,
    type DiagnosticsOptions,
    type ExportMemoriesOptions,
    type MemorySnapshot,
    type ImportMemoriesOptions,
    type ImportMemoriesResult,
    type StoredMemoryPoint,
    type EmbeddingProvider,
    type MemoryCortexDiagnostics,
    type MemoryCortexConfig,
    type MemoryType,
    normalizeDomain,
    normalizeMemoryType,
    extractEntityIds
} from './types.ts';

export class MemoryCortex {
    private inMemoryStorage: InMemoryStorageAdapter;
    private qdrantStorage: QdrantStorageAdapter | null = null;
    private rrfRanker: RrfRanker;
    private persistence: CortexPersistenceManager;
    private consolidator: CortexConsolidator;

    private embeddingProvider: EmbeddingProvider;
    private collectionName: string;
    private collectionNameTemplate?: string;
    private defaultAppId: string;
    private initialized: boolean = false;
    private persistenceLoaded: boolean = false;
    private storesSinceConsolidation: number = 0;
    private autoConsolidateThreshold: number = 50;
    private autoConsolidationOptions?: ConsolidationOptions;
    private persistPath?: string;
    private autoSave: boolean = true;
    private semanticCache: SemanticCacheInterceptor;
    private actionPlanCache: ActionPlanCacheInterceptor;

    static clearFallbackStore(collectionName: string = DEFAULT_CORTEX_COLLECTION): void {
        InMemoryStorageAdapter.clearGlobalStore(resolveCortexCollectionName(collectionName));
    }

    constructor(config: MemoryCortexConfig) {
        const safeEnv = typeof process !== 'undefined' ? process.env : {} as Record<string, string | undefined>;
        const url = config.url !== undefined ? config.url : (config.isolatedStore ? undefined : safeEnv.QDRANT_URL);
        const apiKey = config.apiKey !== undefined ? config.apiKey : (config.isolatedStore ? undefined : safeEnv.QDRANT_API_KEY);
        this.collectionNameTemplate = config.collectionNameTemplate;
        this.collectionName = resolveCortexCollectionName(config.collectionName);
        this.defaultAppId = config.defaultAppId || 'default';
        this.autoConsolidateThreshold = config.autoConsolidateThreshold !== undefined ? config.autoConsolidateThreshold : 50;
        this.autoConsolidationOptions = config.autoConsolidationOptions;
        this.persistPath = config.persistPath;
        this.autoSave = config.autoSave !== false;

        this.inMemoryStorage = new InMemoryStorageAdapter({
            collectionName: this.collectionName,
            isolatedStore: config.isolatedStore
        });

        if (url) {
            this.qdrantStorage = new QdrantStorageAdapter({
                url,
                apiKey,
                collectionName: this.collectionName,
                collectionNameTemplate: this.collectionNameTemplate,
                denseDimension: 768
            });
        }

        if (config.embeddingProvider) {
            this.embeddingProvider = config.embeddingProvider;
        } else if (config.aiClient) {
            this.embeddingProvider = new GeminiEmbeddingProvider(config.aiClient, config.embeddingModel || 'text-embedding-005');
        } else {
            this.embeddingProvider = new DeterministicLocalEmbeddingProvider();
        }

        this.rrfRanker = new RrfRanker({ rrfK: 60 });

        this.persistence = new CortexPersistenceManager({
            storage: this.getActiveStorage(),
            persistPath: this.persistPath,
            autoSave: this.autoSave,
            collectionName: this.collectionName,
            defaultAppId: this.defaultAppId,
            embedder: (text) => this.safeEmbed(text)
        });

        this.consolidator = new CortexConsolidator({
            storage: this.getActiveStorage(),
            onSave: () => this.savePersistFileIfConfigured()
        });

        this.semanticCache = new SemanticCacheInterceptor({
            similarityThreshold: config.semanticCacheConfig?.similarityThreshold ?? 0.96,
            maxEntries: config.semanticCacheConfig?.maxEntries ?? 500,
            defaultTtlMs: config.semanticCacheConfig?.defaultTtlMs
        });

        this.actionPlanCache = config.actionPlanCache || new ActionPlanCacheInterceptor({
            similarityThreshold: config.actionPlanCacheConfig?.similarityThreshold ?? 0.96,
            maxEntries: config.actionPlanCacheConfig?.maxEntries ?? 500,
            defaultTtlMs: config.actionPlanCacheConfig?.defaultTtlMs
        });
    }

    private getActiveStorage(): StorageBackend {
        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            return this.qdrantStorage;
        }
        return this.inMemoryStorage;
    }

    get fallbackStore(): StoredMemoryPoint[] {
        return this.inMemoryStorage.getRawStore();
    }

    get qdrant(): QdrantClient | null {
        return this.qdrantStorage?.getRawClient() ?? null;
    }

    set qdrant(client: QdrantClient | null) {
        if (!this.qdrantStorage) {
            this.qdrantStorage = new QdrantStorageAdapter({
                collectionName: this.collectionName,
                collectionNameTemplate: this.collectionNameTemplate,
                client: client || undefined
            });
        } else if (client) {
            (this.qdrantStorage as any).client = client;
            (this.qdrantStorage as any).available = true;
        } else {
            (this.qdrantStorage as any).client = null;
            (this.qdrantStorage as any).available = false;
        }
    }

    get isAvailable(): boolean {
        return this.qdrantStorage?.isAvailable ?? false;
    }

    set isAvailable(val: boolean) {
        if (this.qdrantStorage) {
            (this.qdrantStorage as any).available = val;
        }
    }

    getIndexMetrics(): VectorIndexMetrics {
        return this.inMemoryStorage.getIndexMetrics();
    }

    private async safeEmbed(text: string): Promise<number[]> {
        try {
            return await this.embeddingProvider.embed(text);
        } catch (err: any) {
            console.warn(`[MemoryCortex] Primary embedding provider failed (${err.message || String(err)}). Using DeterministicLocalEmbeddingProvider fallback for this request only.`);
            const fallbackEmbedder = new DeterministicLocalEmbeddingProvider();
            return await fallbackEmbedder.embed(text);
        }
    }

    async initialize(appId?: string, options?: { createIfMissing?: boolean }): Promise<boolean> {
        const createIfMissing = options?.createIfMissing !== false;
        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            await this.qdrantStorage.initialize(appId, { createIfMissing });
        }

        if (!this.persistenceLoaded) {
            this.persistenceLoaded = true;
            await this.persistence.autoLoadIfConfigured();
        }
        if (createIfMissing) {
            this.initialized = true;
        }
        return true;
    }

    private async savePersistFileIfConfigured(): Promise<void> {
        await this.persistence.autoSaveIfConfigured();
    }

    async store(content: string, metadata: MemoryMetadata, deduplicate: boolean = true): Promise<string | null> {
        const sanitized = sanitizeMemoryWrite(content, metadata as Record<string, any>);
        if (sanitized.blocked) {
            return null;
        }
        const originApp = sanitized.metadata.originApp || sanitized.metadata.appId || this.defaultAppId;
        await this.initialize(originApp, { createIfMissing: true });
        const appId = originApp;
        const domain = sanitized.metadata.domain ? normalizeDomain(sanitized.metadata.domain, sanitized.content) : 'general';
        const memoryType = normalizeMemoryType(sanitized.metadata.memoryType, sanitized.metadata);
        const entityIds = extractEntityIds(sanitized.content, sanitized.metadata.entityIds);
        const now = new Date().toISOString();

        const pointPayload = {
            frequency: 1,
            qualityRating: sanitized.metadata.qualityRating ?? 0.5,
            verified: memoryType === 'fact',
            timestamp: now,
            lastSeen: now,
            ...sanitized.metadata,
            content: sanitized.content,
            originApp,
            appId,
            domain,
            memoryType,
            entityIds
        };

        const denseVector = await this.safeEmbed(sanitized.content);
        const sparseVector = SparseTokenizer.encode(sanitized.content);
        const pointId = crypto.randomUUID();

        const point: StoredMemoryPoint = {
            id: pointId,
            denseVector,
            sparseVector,
            payload: pointPayload
        };

        let storedId: string | null = null;

        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            storedId = await this.qdrantStorage.store(point, deduplicate);
        }

        if (!storedId) {
            storedId = await this.inMemoryStorage.store(point, deduplicate);
        }

        if (storedId) {
            this.semanticCache.clear();
            this.storesSinceConsolidation++;
            if (this.autoConsolidateThreshold > 0 && this.storesSinceConsolidation >= this.autoConsolidateThreshold) {
                this.storesSinceConsolidation = 0;
                await this.consolidateMemories(this.autoConsolidationOptions);
            }
            await this.savePersistFileIfConfigured();
        }

        return storedId;
    }

    async storeBatch(memories: { content: string; metadata: MemoryMetadata }[]): Promise<string[]> {
        if (memories.length === 0) return [];
        const sanitizedItems = memories
            .map((m) => sanitizeMemoryWrite(m.content, m.metadata as Record<string, any>))
            .filter((item) => !item.blocked);
        if (sanitizedItems.length === 0) return [];

        const firstApp = sanitizedItems[0].metadata.originApp || sanitizedItems[0].metadata.appId || this.defaultAppId;
        await this.initialize(firstApp, { createIfMissing: true });
        const now = new Date().toISOString();

        const points: StoredMemoryPoint[] = await Promise.all(
            sanitizedItems.map(async (item) => {
                const denseVector = await this.safeEmbed(item.content);
                const sparseVector = SparseTokenizer.encode(item.content);
                const id = crypto.randomUUID();
                const originApp = item.metadata.originApp || item.metadata.appId || this.defaultAppId;
                const appId = originApp;
                const domain = item.metadata.domain ? normalizeDomain(item.metadata.domain, item.content) : 'general';
                const memoryType = normalizeMemoryType(item.metadata.memoryType, item.metadata);
                const entityIds = extractEntityIds(item.content, item.metadata.entityIds);

                return {
                    id,
                    denseVector,
                    sparseVector,
                    payload: {
                        frequency: 1,
                        qualityRating: item.metadata.qualityRating ?? 0.5,
                        verified: memoryType === 'fact',
                        timestamp: now,
                        lastSeen: now,
                        ...item.metadata,
                        content: item.content,
                        originApp,
                        appId,
                        domain,
                        memoryType,
                        entityIds
                    }
                };
            })
        );

        let storedIds: string[] = [];
        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            storedIds = await this.qdrantStorage.storeBatch(points);
        }

        if (storedIds.length === 0) {
            storedIds = await this.inMemoryStorage.storeBatch(points);
        }

        if (storedIds.length > 0) {
            this.semanticCache.clear();
            this.storesSinceConsolidation += storedIds.length;
            if (this.autoConsolidateThreshold > 0 && this.storesSinceConsolidation >= this.autoConsolidateThreshold) {
                this.storesSinceConsolidation = 0;
                await this.consolidateMemories(this.autoConsolidationOptions);
            }
            await this.savePersistFileIfConfigured();
        }

        return storedIds;
    }

    async rateMemory(id: string, rating: number, feedback?: string): Promise<boolean> {
        await this.initialize();
        const normalizedRating = Math.max(0, Math.min(1, rating));
        const updates = {
            qualityRating: normalizedRating,
            verified: normalizedRating >= 0.8,
            feedback: feedback || undefined,
            ratedAt: new Date().toISOString()
        };

        let updated = false;
        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            updated = await this.qdrantStorage.setPayload(id, updates);
        }

        const inMemoryUpdated = await this.inMemoryStorage.setPayload(id, updates);
        updated = updated || inMemoryUpdated;

        if (updated) {
            this.semanticCache.clear();
            await this.savePersistFileIfConfigured();
        }
        return updated;
    }

    async upsertGradedLesson(lessonId: string, payload: Record<string, any>): Promise<string | null> {
        await this.initialize();
        const originApp = payload.app_id || payload.originApp || payload.appId || this.defaultAppId;
        const now = payload.date || new Date().toISOString();
        const memoryType: MemoryType = 'graded_lesson';
        const content = payload.reason || payload.rule || JSON.stringify(payload);
        const validId = toValidQdrantId(lessonId);

        const pointPayload = {
            id: validId,
            lessonId,
            betId: payload.betId || payload.pickId || lessonId,
            sportKey: payload.sportKey,
            rule: payload.rule,
            reason: payload.reason,
            reasonSource: payload.reasonSource,
            oddsBucket: payload.oddsBucket,
            category: payload.category || 'betting_lesson',
            date: now,
            type: 'graded_lesson',
            app_id: originApp,
            appId: originApp,
            originApp,
            memoryType,
            memory_type: memoryType,
            closingLineValue: payload.closingLineValue,
            content,
            frequency: 1,
            qualityRating: payload.qualityRating ?? 0.85,
            verified: true,
            timestamp: now,
            lastSeen: now,
            ...payload
        };

        let denseVector: number[];
        try {
            denseVector = await this.embeddingProvider.embed(content);
        } catch (firstErr: any) {
            try {
                denseVector = await this.embeddingProvider.embed(content);
            } catch (retryErr: any) {
                console.warn(`[MemoryCortex] Primary embedder retry failed (${retryErr?.message || retryErr}). Falling back for this request only.`);
                const fallbackEmbedder = new DeterministicLocalEmbeddingProvider();
                denseVector = await fallbackEmbedder.embed(content);
            }
        }

        const sparseVector = SparseTokenizer.encode(content);
        const point: StoredMemoryPoint = {
            id: lessonId,
            denseVector,
            sparseVector,
            payload: pointPayload
        };

        let storedId: string | null = null;
        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            const qdrantPoint: StoredMemoryPoint = {
                ...point,
                id: validId
            };
            const qdrantStored = await this.qdrantStorage.store(qdrantPoint, false);
            if (qdrantStored) storedId = lessonId;
        }

        if (!storedId) {
            storedId = await this.inMemoryStorage.store(point, false);
        }

        if (storedId) {
            this.semanticCache.clear();
            await this.savePersistFileIfConfigured();
        }

        return storedId;
    }

    async deletePoint(id: string): Promise<boolean> {
        await this.initialize();
        let deleted = false;
        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            const qdrantDeleted = await this.qdrantStorage.delete([id]);
            if (qdrantDeleted) deleted = true;
        }
        const memDeleted = await this.inMemoryStorage.delete([id]);
        if (memDeleted) deleted = true;

        if (deleted) {
            this.semanticCache.clear();
            await this.savePersistFileIfConfigured();
        }
        return deleted;
    }

    async retrieve(
        query: string,
        optionsOrDomain?: string | RetrievalOptions,
        limit: number = 3
    ): Promise<any[]> {
        const startTime = Date.now();

        let options: RetrievalOptions = {};
        if (typeof optionsOrDomain === 'string') {
            options = { domain: optionsOrDomain, limit };
        } else if (typeof optionsOrDomain === 'object' && optionsOrDomain !== null) {
            options = { ...optionsOrDomain, limit: optionsOrDomain.limit || limit };
        } else {
            options = { limit };
        }

        const readerApp = options.appId || options.originApp || this.defaultAppId;
        await this.initialize(readerApp, { createIfMissing: false });

        const queryDense = await this.safeEmbed(query);
        const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
        const hasScopeConstraints = Boolean(
            options.asOf ||
            options.sport ||
            (Array.isArray(options.eventIds) && options.eventIds.length > 0) ||
            options.eventId ||
            (Array.isArray(options.entityIds) && options.entityIds.length > 0) ||
            options.entityId ||
            options.publicOnly ||
            options.snapshotHash
        );
        const scopeParts = [
            readerApp,
            requestedDomain,
            options.sport ? `sport=${options.sport}` : '',
            options.asOf ? `asOf=${options.asOf}` : '',
            Array.isArray(options.eventIds) && options.eventIds.length > 0
                ? `ev=${[...options.eventIds].sort().join(',')}`
                : options.eventId
                  ? `ev=${options.eventId}`
                  : '',
            Array.isArray(options.entityIds) && options.entityIds.length > 0
                ? `ent=${[...options.entityIds].sort().join(',')}`
                : options.entityId
                  ? `ent=${options.entityId}`
                  : '',
            options.publicOnly ? 'pub=1' : '',
            options.snapshotHash ? `hash=${options.snapshotHash}` : ''
        ].filter(Boolean);
        const cacheNamespace = scopeParts.join(':');
        const planLookupNamespace = hasScopeConstraints ? cacheNamespace : options.appId;

        const planMatch = this.actionPlanCache.lookup(queryDense, planLookupNamespace);
        if (planMatch.hit && planMatch.actionPlan) {
            return [{
                id: planMatch.actionPlan.id,
                content: `ActionPlan:${planMatch.actionPlan.intent}`,
                actionPlan: planMatch.actionPlan,
                isActionPlanHit: true,
                latencySavedMs: 43
            }];
        }

        const cachedMatch = this.semanticCache.lookup<any[]>(queryDense, cacheNamespace);
        if (cachedMatch.hit && cachedMatch.payload) {
            return cachedMatch.payload;
        }

        const querySparse = SparseTokenizer.encode(query);
        const effectiveQueryOptions: RetrievalOptions = {
            ...options,
            ...(options.appId || options.originApp ? {} : { appId: readerApp })
        };
        let candidates: any[] = [];

        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            candidates = await this.qdrantStorage.search(queryDense, effectiveQueryOptions, querySparse);
        }

        if (candidates.length === 0) {
            candidates = await this.inMemoryStorage.search(queryDense, effectiveQueryOptions, querySparse);
        }

        const rankedResults = this.rrfRanker.rankAndFilter(
            candidates,
            { ...effectiveQueryOptions, query },
            this.defaultAppId
        );
        const results = rankedResults.filter((item: any) =>
            matchesScopedMemoryFilter(item, effectiveQueryOptions) && isSafeRetrievedBaseline(item)
        );

        if (results.length > 0) {
            this.semanticCache.set(queryDense, results, cacheNamespace);
        }

        const durationMs = Date.now() - startTime;
        globalTelemetryCollector.recordRetrievalLatency(durationMs);

        return results;
    }

    async retrieveExemplars(task: string, options?: RetrievalOptions): Promise<string> {
        const requestedLimit = options?.limit || 2;
        const topMemories = await this.retrieve(task, {
            ...options,
            minRating: options?.minRating ?? 0.7,
            limit: Math.max(requestedLimit * 4, 8)
        });

        const safeMemories = topMemories
            .filter((m) => isSafeExemplarRecord(m))
            .slice(0, requestedLimit);

        return this.consolidator.formatExemplars(safeMemories);
    }

    async retrieveContrastivePostMortems(
        task: string,
        options?: RetrievalOptions
    ): Promise<{ wins: any[]; losses: any[]; formattedBlock: string }> {
        const readerApp = options?.appId || options?.originApp || this.defaultAppId;
        await this.initialize(readerApp, { createIfMissing: false });
        const limit = options?.limit || 2;
        const candidates = await this.retrieve(task, {
            ...options,
            limit: Math.max(limit * 4, 8)
        }).catch(() => []);

        const fallbackCandidates: any[] = [];
        const effectiveContrastiveOpts: RetrievalOptions = {
            ...options,
            appId: readerApp
        };
        for (const pt of this.fallbackStore) {
            const p: Record<string, any> = (pt.payload || {}) as Record<string, any>;
            if (!matchesScopedMemoryFilter(p, effectiveContrastiveOpts)) continue;
            if (!isGradedWagerLoss(p) && !isGradedWagerWin(p)) continue;

            fallbackCandidates.push({
                id: pt.id,
                ...p
            });
        }

        const mergedMap = new Map<string, any>();
        for (const c of [...candidates, ...fallbackCandidates]) {
            const key = String(c.workflowId || c.id || c.content || Math.random());
            if (!mergedMap.has(key)) {
                mergedMap.set(key, c);
            }
        }

        const all = Array.from(mergedMap.values());
        const wins = all
            .filter(m => isGradedWagerWin(m))
            .slice(0, limit);

        const losses = all
            .filter(m => isGradedWagerLoss(m))
            .slice(0, limit);

        const formattedBlock = this.consolidator.formatContrastivePostMortems(wins, losses);

        return {
            wins,
            losses,
            formattedBlock
        };
    }

    async consolidateMemories(options?: ConsolidationOptions): Promise<ConsolidationResult> {
        await this.initialize();
        this.semanticCache.clear();
        return this.consolidator.consolidate(options);
    }

    async exportMemories(options?: ExportMemoriesOptions): Promise<MemorySnapshot> {
        await this.initialize();
        return this.persistence.exportSnapshot(options);
    }

    async exportJson(options?: ExportMemoriesOptions): Promise<string> {
        const snapshot = await this.exportMemories(options);
        return JSON.stringify(snapshot, null, 2);
    }

    async exportJsonl(options?: ExportMemoriesOptions): Promise<string> {
        const snapshot = await this.exportMemories(options);
        return snapshot.memories.map(m => JSON.stringify(m)).join('\n');
    }

    async saveToFile(filePath?: string): Promise<string> {
        return this.persistence.saveToFile(filePath);
    }

    async loadFromFile(filePath?: string, options?: ImportMemoriesOptions): Promise<ImportMemoriesResult> {
        const res = await this.persistence.loadFromFile(filePath, options);
        this.semanticCache.clear();
        return res;
    }

    async importMemories(
        input: MemorySnapshot | string | any[],
        options?: ImportMemoriesOptions
    ): Promise<ImportMemoriesResult> {
        await this.initialize();
        const res = await this.persistence.importMemories(input, options);
        this.semanticCache.clear();
        return res;
    }

    async wipeCollection(appId?: string): Promise<boolean> {
        this.semanticCache.clear();
        await this.inMemoryStorage.wipe(appId);
        if (this.qdrantStorage) {
            await this.qdrantStorage.wipe(appId);
        }
        this.storesSinceConsolidation = 0;
        if (appId) {
            await this.savePersistFileIfConfigured();
        } else {
            if (this.persistPath) {
                try {
                    const fs = await import('no' + 'de:fs');
                    if (fs.existsSync(this.persistPath)) {
                        fs.unlinkSync(this.persistPath);
                    }
                } catch {}
            }
            if (!this.qdrantStorage || !this.qdrantStorage.isAvailable) {
                this.initialized = false;
            }
        }
        return true;
    }

    async wipeApp(appId: string): Promise<boolean> {
        return this.wipeCollection(appId);
    }

    async gradeMemoryByWorkflowId(options: {
        workflowId: string;
        originApp: string;
        outcome: 'win' | 'loss' | 'push';
        gradedAt?: string | number;
        brierScore?: number;
        margin?: number;
        predictedProbability?: number;
        settledSummary?: string;
    }): Promise<{ found: boolean; alreadyProcessed: boolean; point?: any; updatedScore?: number }> {
        await this.initialize();
        const targetWorkflowId = options.workflowId.trim();
        const targetOriginApp = options.originApp.trim();
        const outcomeScore = options.outcome === 'win' ? 1.0 : options.outcome === 'loss' ? 0.0 : 0.5;
        const nowIso = typeof options.gradedAt === 'string'
            ? options.gradedAt
            : (typeof options.gradedAt === 'number' ? new Date(options.gradedAt).toISOString() : new Date().toISOString());

        let matchedPoint: any = null;
        let isAlreadyProcessed = false;

        for (const pt of this.fallbackStore) {
            const itemWorkflowId = pt.payload.workflowId;
            const itemOriginApp = pt.payload.originApp || pt.payload.appId;
            if (itemWorkflowId === targetWorkflowId && itemOriginApp === targetOriginApp) {
                matchedPoint = pt;
                if (pt.payload.feedbackProcessed === true) {
                    isAlreadyProcessed = true;
                } else {
                    pt.payload.qualityRating = outcomeScore;
                    pt.payload.memoryType = 'fact';
                    pt.payload.outcome = options.outcome;
                    pt.payload.gradedAt = nowIso;
                    pt.payload.feedbackProcessed = true;
                    pt.payload.verified = outcomeScore >= 0.8;
                    if (options.brierScore !== undefined) pt.payload.brierScore = options.brierScore;
                    if (options.margin !== undefined) pt.payload.margin = options.margin;
                    if (options.predictedProbability !== undefined) pt.payload.predictedProbability = options.predictedProbability;
                    if (options.settledSummary !== undefined) pt.payload.settledSummary = options.settledSummary;
                }
                break;
            }
        }

        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            const qClient = this.qdrantStorage.getRawClient();
            if (qClient) {
                try {
                    const scrollRes = await (qClient as any).scroll(this.collectionName, {
                        limit: 1,
                        filter: {
                            must: [
                                { key: 'workflowId', match: { value: targetWorkflowId } },
                                {
                                    should: [
                                        { key: 'originApp', match: { value: targetOriginApp } },
                                        { key: 'appId', match: { value: targetOriginApp } }
                                    ]
                                }
                            ]
                        },
                        with_payload: true,
                        with_vector: false
                    });

                    const points = (scrollRes as any)?.points || [];
                    if (points.length > 0) {
                        const qPoint = points[0];
                        const qPayload = qPoint.payload || {};
                        const pointApp = qPayload.originApp || qPayload.appId;
                        if (pointApp === targetOriginApp) {
                            matchedPoint = matchedPoint || qPoint;
                            if (qPayload.feedbackProcessed === true) {
                                isAlreadyProcessed = true;
                            } else {
                                await this.qdrantStorage.setPayload(qPoint.id, {
                                    qualityRating: outcomeScore,
                                    memoryType: 'fact',
                                    outcome: options.outcome,
                                    gradedAt: nowIso,
                                    feedbackProcessed: true,
                                    verified: outcomeScore >= 0.8,
                                    ...(options.brierScore !== undefined ? { brierScore: options.brierScore } : {}),
                                    ...(options.margin !== undefined ? { margin: options.margin } : {}),
                                    ...(options.predictedProbability !== undefined ? { predictedProbability: options.predictedProbability } : {}),
                                    ...(options.settledSummary !== undefined ? { settledSummary: options.settledSummary } : {})
                                });
                            }
                        }
                    }
                } catch (err: any) {
                    console.warn(`[MemoryCortex] Qdrant gradeMemoryByWorkflowId error: ${err.message || err}`);
                }
            }
        }

        if (!matchedPoint) {
            return { found: false, alreadyProcessed: false };
        }

        await this.savePersistFileIfConfigured();

        return {
            found: true,
            alreadyProcessed: isAlreadyProcessed,
            point: matchedPoint.payload || matchedPoint,
            updatedScore: outcomeScore
        };
    }

    async getDiagnostics(appIdFilter?: string, options?: DiagnosticsOptions): Promise<MemoryCortexDiagnostics> {
        if (this.qdrantStorage && this.qdrantStorage.isAvailable && !this.initialized) {
            await this.initialize(appIdFilter && appIdFilter !== 'global' ? appIdFilter : undefined).catch(() => false);
        }
        return collectCortexDiagnostics({
            qdrant: this.qdrantStorage?.getRawClient() ?? null,
            isAvailable: this.isAvailable,
            collectionName: this.collectionName,
            fallbackStore: this.fallbackStore,
            defaultAppId: this.defaultAppId,
            withTimeout: async (p: Promise<any>, ms: number = 3000) => {
                let timeoutId: any;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
                });
                try {
                    return await Promise.race([p, timeoutPromise]);
                } finally {
                    clearTimeout(timeoutId);
                }
            }
        }, appIdFilter, options);
    }

    get ready(): boolean {
        return true;
    }

    get isQdrantAvailable(): boolean {
        return this.isAvailable;
    }

    get fallbackCount(): number {
        return this.fallbackStore.length;
    }

    get pendingConsolidationCount(): number {
        return this.storesSinceConsolidation;
    }

    getSemanticCacheStats(): SemanticCacheStats {
        return this.semanticCache.getStats();
    }

    getActionPlanCacheStats(): ActionPlanCacheStats {
        return this.actionPlanCache.getStats();
    }

    getActionPlanCache(): ActionPlanCacheInterceptor {
        return this.actionPlanCache;
    }

    async lookupActionPlan(query: string, appId?: string): Promise<ActionPlanCacheLookupResult & { queryDense: number[] }> {
        const queryDense = await this.safeEmbed(query);
        const res = this.actionPlanCache.lookup(queryDense, appId || this.defaultAppId);
        return {
            ...res,
            queryDense
        };
    }

    async cacheActionPlan(query: string, plan: ActionPlanInput, ttlMs?: number): Promise<ActionPlan> {
        const queryDense = await this.safeEmbed(query);
        return this.actionPlanCache.set(queryDense, plan, ttlMs);
    }
}
