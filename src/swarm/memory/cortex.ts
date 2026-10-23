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
import { QdrantStorageAdapter } from './storage/qdrantStorage.ts';
import type { StorageBackend } from './storage/types.ts';
import { RrfRanker } from './ranking/rrfRanker.ts';
import { CortexPersistenceManager } from './persistence/cortexPersistence.ts';
import { CortexConsolidator } from './consolidation/cortexConsolidator.ts';
import {
    type MemoryMetadata,
    type RetrievalOptions,
    type ConsolidationOptions,
    type ConsolidationResult,
    type ExportMemoriesOptions,
    type MemorySnapshot,
    type ImportMemoriesOptions,
    type ImportMemoriesResult,
    type StoredMemoryPoint,
    type EmbeddingProvider,
    type MemoryCortexDiagnostics,
    type MemoryCortexConfig,
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
    private storesSinceConsolidation: number = 0;
    private autoConsolidateThreshold: number = 50;
    private autoConsolidationOptions?: ConsolidationOptions;
    private persistPath?: string;
    private autoSave: boolean = true;
    private semanticCache: SemanticCacheInterceptor;
    private actionPlanCache: ActionPlanCacheInterceptor;

    static clearFallbackStore(collectionName: string = 'pwa_swarm_dev_cortex_v2'): void {
        InMemoryStorageAdapter.clearGlobalStore(collectionName);
    }

    constructor(config: MemoryCortexConfig) {
        const safeEnv = typeof process !== 'undefined' ? process.env : {} as Record<string, string | undefined>;
        const url = config.url !== undefined ? config.url : (config.isolatedStore ? undefined : safeEnv.QDRANT_URL);
        const apiKey = config.apiKey !== undefined ? config.apiKey : (config.isolatedStore ? undefined : safeEnv.QDRANT_API_KEY);
        this.collectionNameTemplate = config.collectionNameTemplate;
        this.collectionName = config.collectionName || 'pwa_swarm_dev_cortex_v2';
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

    async initialize(appId?: string): Promise<boolean> {
        if (this.initialized) return true;

        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            const success = await this.qdrantStorage.initialize(appId);
            if (success) {
                this.initialized = true;
                await this.persistence.autoLoadIfConfigured();
                return true;
            }
        }

        this.initialized = true;
        await this.persistence.autoLoadIfConfigured();
        return true;
    }

    private async savePersistFileIfConfigured(): Promise<void> {
        await this.persistence.autoSaveIfConfigured();
    }

    async store(content: string, metadata: MemoryMetadata, deduplicate: boolean = true): Promise<string | null> {
        await this.initialize();
        const originApp = metadata.originApp || metadata.appId || this.defaultAppId;
        const appId = originApp;
        const domain = metadata.domain ? normalizeDomain(metadata.domain, content) : 'general';
        const memoryType = normalizeMemoryType(metadata.memoryType, metadata);
        const entityIds = extractEntityIds(content, metadata.entityIds);
        const now = new Date().toISOString();

        const pointPayload = {
            content,
            frequency: 1,
            qualityRating: metadata.qualityRating ?? 0.5,
            verified: memoryType === 'fact',
            timestamp: now,
            lastSeen: now,
            ...metadata,
            originApp,
            appId,
            domain,
            memoryType,
            entityIds
        };

        const denseVector = await this.safeEmbed(content);
        const sparseVector = SparseTokenizer.encode(content);
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
        await this.initialize();
        if (memories.length === 0) return [];
        const now = new Date().toISOString();

        const points: StoredMemoryPoint[] = await Promise.all(
            memories.map(async (memory) => {
                const denseVector = await this.safeEmbed(memory.content);
                const sparseVector = SparseTokenizer.encode(memory.content);
                const id = crypto.randomUUID();
                const originApp = memory.metadata.originApp || memory.metadata.appId || this.defaultAppId;
                const appId = originApp;
                const domain = memory.metadata.domain ? normalizeDomain(memory.metadata.domain, memory.content) : 'general';
                const memoryType = normalizeMemoryType(memory.metadata.memoryType, memory.metadata);
                const entityIds = extractEntityIds(memory.content, memory.metadata.entityIds);

                return {
                    id,
                    denseVector,
                    sparseVector,
                    payload: {
                        content: memory.content,
                        frequency: 1,
                        qualityRating: memory.metadata.qualityRating ?? 0.5,
                        verified: memoryType === 'fact',
                        timestamp: now,
                        lastSeen: now,
                        ...memory.metadata,
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

    async retrieve(
        query: string,
        optionsOrDomain?: string | RetrievalOptions,
        limit: number = 3
    ): Promise<any[]> {
        const startTime = Date.now();
        await this.initialize();

        let options: RetrievalOptions = {};
        if (typeof optionsOrDomain === 'string') {
            options = { domain: optionsOrDomain, limit };
        } else if (typeof optionsOrDomain === 'object' && optionsOrDomain !== null) {
            options = { ...optionsOrDomain, limit: optionsOrDomain.limit || limit };
        } else {
            options = { limit };
        }

        const queryDense = await this.safeEmbed(query);

        const planMatch = this.actionPlanCache.lookup(queryDense, options.appId);
        if (planMatch.hit && planMatch.actionPlan) {
            return [{
                id: planMatch.actionPlan.id,
                content: `ActionPlan:${planMatch.actionPlan.intent}`,
                actionPlan: planMatch.actionPlan,
                isActionPlanHit: true,
                latencySavedMs: 43
            }];
        }

        const readerApp = options.appId || options.originApp || this.defaultAppId;
        const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
        const cacheNamespace = requestedDomain ? `${readerApp}:${requestedDomain}` : readerApp;
        const cachedMatch = this.semanticCache.lookup<any[]>(queryDense, cacheNamespace);
        if (cachedMatch.hit && cachedMatch.payload) {
            return cachedMatch.payload;
        }

        const querySparse = SparseTokenizer.encode(query);
        let candidates: any[] = [];

        if (this.qdrantStorage && this.qdrantStorage.isAvailable) {
            candidates = await this.qdrantStorage.search(queryDense, options, querySparse);
        }

        if (candidates.length === 0) {
            candidates = await this.inMemoryStorage.search(queryDense, options, querySparse);
        }

        const results = this.rrfRanker.rankAndFilter(
            candidates,
            { ...options, query },
            this.defaultAppId
        );

        if (results.length > 0) {
            this.semanticCache.set(queryDense, results, cacheNamespace);
        }

        const durationMs = Date.now() - startTime;
        globalTelemetryCollector.recordRetrievalLatency(durationMs);

        return results;
    }

    async retrieveExemplars(task: string, options?: RetrievalOptions): Promise<string> {
        const topMemories = await this.retrieve(task, {
            ...options,
            minRating: options?.minRating ?? 0.7,
            limit: options?.limit || 2
        });

        return this.consolidator.formatExemplars(topMemories);
    }

    async retrieveContrastivePostMortems(
        task: string,
        options?: RetrievalOptions
    ): Promise<{ wins: any[]; losses: any[]; formattedBlock: string }> {
        await this.initialize();
        const limit = options?.limit || 2;
        const candidates = await this.retrieve(task, {
            ...options,
            limit: Math.max(limit * 4, 8)
        }).catch(() => []);

        const fallbackCandidates: any[] = [];
        for (const pt of this.fallbackStore) {
            const p: Record<string, any> = (pt.payload || {}) as Record<string, any>;
            const isGradedLoss =
                p.outcome === 'loss' ||
                (typeof p.brierScore === 'number' && p.brierScore >= 0.28) ||
                (p.feedbackProcessed === true && typeof p.qualityRating === 'number' && p.qualityRating <= 0.25);
            const isGradedWin =
                p.outcome === 'win' ||
                (p.feedbackProcessed === true && typeof p.qualityRating === 'number' && p.qualityRating >= 0.8);
            if (!isGradedLoss && !isGradedWin) continue;

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
            .filter(m => m.outcome === 'win' || (m.qualityRating !== undefined && m.qualityRating >= 0.75 && m.outcome !== 'loss'))
            .slice(0, limit);

        const losses = all
            .filter(m =>
                m.outcome === 'loss' ||
                (typeof m.brierScore === 'number' && m.brierScore >= 0.28) ||
                (m.feedbackProcessed === true && typeof m.qualityRating === 'number' && m.qualityRating <= 0.25)
            )
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

    async getDiagnostics(appIdFilter?: string): Promise<MemoryCortexDiagnostics> {
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
        }, appIdFilter);
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
