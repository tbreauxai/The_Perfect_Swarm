import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    GeminiEmbeddingProvider,
    DEFAULT_GEMINI_EMBEDDING_MODEL,
    resolveGeminiEmbeddingModel
} from './embeddings.ts';
import {
    DEFAULT_CORTEX_COLLECTION,
    resolveCortexCollectionName
} from './memorySanitizer.ts';
import { MemoryCortex } from './cortex.ts';
import { QdrantStorageAdapter } from './storage/qdrantStorage.ts';
import { bindCortexAndTools } from '../engine/cortexBinding.ts';
import { resolveMemoryGrounding } from '../engine/memoryGrounding.ts';
import { SwarmContext } from '../context.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { createSwarmServer } from '../server/app.ts';

describe('Cortex Learning Loop (S1: gemini-embedding-2, S2: multi-sport domains & CLV ingest, S3: truthful cortexSummary)', () => {
    beforeEach(() => {
        GeminiEmbeddingProvider.resetUnsupportedModels();
        MemoryCortex.clearFallbackStore();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('S1: remaps text-embedding-004/embedding-001 to gemini-embedding-2, sends outputDimensionality: 768 without taskType, and defaults collection to pwa_swarm_dev_cortex_v4', async () => {
        expect(resolveGeminiEmbeddingModel('text-embedding-004')).toBe('gemini-embedding-2');
        expect(resolveGeminiEmbeddingModel('embedding-001')).toBe('gemini-embedding-2');
        expect(resolveGeminiEmbeddingModel(undefined)).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);

        expect(resolveCortexCollectionName(undefined)).toBe('pwa_swarm_dev_cortex_v4');
        expect(resolveCortexCollectionName('pwa_swarm_dev_cortex_v3')).toBe('pwa_swarm_dev_cortex_v4');
        expect(DEFAULT_CORTEX_COLLECTION).toBe('pwa_swarm_dev_cortex_v4');

        const capturedRequests: any[] = [];
        const mockClient: any = {
            models: {
                embedContent: vi.fn(async (req: any) => {
                    capturedRequests.push(req);
                    return {
                        embeddings: [{ values: new Array(768).fill(0.1) }]
                    };
                })
            }
        };

        // Even when incoming settings pass legacy text-embedding-004 & v3 collection, bindCortexAndTools remaps cleanly
        const bound = bindCortexAndTools(
            { task: 'Analyze NBA slate', data: 'slate' },
            { qdrantEmbeddingModel: 'text-embedding-004', qdrantCollectionName: 'pwa_swarm_dev_cortex_v3', persistPath: undefined },
            mockClient,
            'duelodds'
        );
        expect(bound.memoryCortex.getTelemetryState().collectionName).toBe('pwa_swarm_dev_cortex_v4');
        expect(bound.memoryCortex.getEmbedModel()).toBe('gemini-embedding-2');

        const provider = new GeminiEmbeddingProvider(mockClient, 'text-embedding-004');
        const vec = await provider.embed('test embedding payload', 'RETRIEVAL_QUERY');
        expect(vec).toHaveLength(768);
        expect(capturedRequests[0].model).toBe('gemini-embedding-2');
        expect(capturedRequests[0].config).toEqual({ outputDimensionality: 768 });
        expect(capturedRequests[0].config.taskType).toBeUndefined();
        expect(capturedRequests[0].config.task_type).toBeUndefined();
    });

    it('S1: falls back from gemini-embedding-2 to gemini-embedding-001 ONLY on 404/503', async () => {
        const calledModels: string[] = [];
        const mockClient: any = {
            models: {
                embedContent: vi.fn(async (req: any) => {
                    calledModels.push(req.model);
                    if (req.model === 'gemini-embedding-2') {
                        throw new Error('404 NOT_FOUND: model gemini-embedding-2 not found');
                    }
                    return {
                        embeddings: [{ values: new Array(768).fill(0.2) }]
                    };
                })
            }
        };

        const provider = new GeminiEmbeddingProvider(mockClient, 'gemini-embedding-2');
        const vec = await provider.embed('fallback test', 'RETRIEVAL_DOCUMENT');
        expect(vec).toHaveLength(768);
        expect(calledModels).toEqual(['gemini-embedding-2', 'gemini-embedding-001']);
        expect(provider.getActiveModel()).toBe('gemini-embedding-001');
    });

    it('S2: multi-sport domains=["nfl","nhl"] builds Qdrant filter with domain IN ["nfl","nhl",...] + appId="duelodds" and retrieves CLV contrastive pairs from both sports', async () => {
        let capturedQueryFilter: any = null;
        const fakeQdrant: any = {
            getCollections: vi.fn(async () => ({ collections: [{ name: 'pwa_swarm_dev_cortex_v4' }] })),
            getCollection: vi.fn(async () => ({ points_count: 112, payload_schema: {} })),
            createPayloadIndex: vi.fn(async () => ({})),
            query: vi.fn(async (_col: string, params: any) => {
                capturedQueryFilter = params.filter || params.prefetch?.[0]?.filter;
                return {
                    points: [
                        {
                            id: 'pt-nfl-win',
                            score: 0.91,
                            payload: {
                                lessonId: 'lesson-nfl-1',
                                originApp: 'duelodds',
                                appId: 'duelodds',
                                domain: 'nfl',
                                sport: 'nfl',
                                market: 'spread',
                                outcome: 'win',
                                clv: 2.5,
                                content: 'NFL home dog covered +3.5 with +2.5 CLV'
                            }
                        },
                        {
                            id: 'pt-nhl-loss',
                            score: 0.87,
                            payload: {
                                lessonId: 'lesson-nhl-1',
                                originApp: 'duelodds',
                                appId: 'duelodds',
                                domain: 'nhl',
                                sport: 'nhl',
                                market: 'total',
                                outcome: 'loss',
                                clv: -1.5,
                                vetoFlag: true,
                                content: 'NHL over failed against backup goalie scratch'
                            }
                        }
                    ]
                };
            })
        };

        const storage = new QdrantStorageAdapter({
            collectionName: 'pwa_swarm_dev_cortex_v4',
            client: fakeQdrant
        });
        const hits = await storage.search(new Array(768).fill(0.1), {
            appId: 'duelodds',
            domain: 'multi-sport',
            domains: ['nfl', 'nhl']
        });

        expect(hits).toHaveLength(2);
        const filterStr = JSON.stringify(capturedQueryFilter);
        expect(filterStr).toContain('"appId"');
        expect(filterStr).toContain('"duelodds"');
        expect(filterStr).toContain('"nfl"');
        expect(filterStr).toContain('"nhl"');

        // Also test contrastive retrieval across nfl + nhl inMemoryStore
        const cortex = new MemoryCortex({ isolatedStore: true, defaultAppId: 'duelodds' });
        await cortex.ingestLessons([
            {
                lessonId: 'lesson-nfl-win',
                sport: 'nfl',
                market: 'spread',
                outcome: 'won',
                clv: 3.1,
                pillars: ['form', 'steam'],
                content: 'NFL Bills -3 beat closing line by +3.1 CLV.'
            },
            {
                lessonId: 'lesson-nhl-loss',
                sport: 'nhl',
                market: 'ml',
                outcome: 'lost',
                clv: -2.0,
                vetoFlag: true,
                content: 'NHL Oilers ML lost against late goalie news.'
            }
        ], 'duelodds');

        const contrastive = await cortex.retrieveContrastivePostMortems('NFL Bills and NHL Oilers parlay', {
            appId: 'duelodds',
            domain: 'multi-sport',
            domains: ['nfl', 'nhl'],
            limit: 3
        });
        expect(contrastive.wins.length).toBe(1);
        expect(contrastive.losses.length).toBe(1);
        expect(contrastive.wins[0].sport).toBe('nfl');
        expect(contrastive.losses[0].sport).toBe('nhl');
    });

    it('S2: POST /api/cortex/ingest is idempotent by lessonId and stores CLV/sport/market/outcome metadata', async () => {
        vi.stubEnv('SWARM_APP_TOKENS', 'duelodds:test-ingest-token');
        const cortex = new MemoryCortex({ isolatedStore: true, defaultAppId: 'duelodds' });
        const app = createSwarmServer({ cors: false, defaultCortex: cortex });
        const authHeaders = {
            Authorization: 'Bearer test-ingest-token',
            'Content-Type': 'application/json'
        };

        const payload = {
            lessons: [
                {
                    lessonId: 'lesson-101',
                    sport: 'nba',
                    market: 'spread',
                    outcome: 'won',
                    clv: 1.8,
                    pillars: ['form', 'health'],
                    content: 'Back healthy home favorite with +1.8 CLV.'
                }
            ]
        };

        const r1 = await app.request('/api/cortex/ingest', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(payload)
        });
        expect(r1.status).toBe(200);
        const j1 = await r1.json();
        expect(j1.ok).toBe(true);
        expect(j1.ingested).toBe(1);

        // Re-ingest same lessonId -> idempotent deterministic point ID, store size stays 1
        const r2 = await app.request('/api/swarm/cortex/ingest', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(payload)
        });
        expect(r2.status).toBe(200);
        const j2 = await r2.json();
        expect(j2.ids).toEqual(j1.ids);
        expect(cortex.fallbackCount).toBe(1);
    });

    it('S3: mocked 404 from embedContent sets cortexSummary.status === "Error" with embedError; healthy 0-hit retrieval reports "Empty"', async () => {
        const failingClient: any = {
            models: {
                embedContent: vi.fn(async () => {
                    throw new Error('404 NOT_FOUND: text-embedding-004 retired');
                })
            }
        };
        const errCortex = new MemoryCortex({
            isolatedStore: true,
            defaultAppId: 'duelodds',
            aiClient: failingClient,
            embeddingModel: 'gemini-embedding-2'
        });

        const ctxErr = new SwarmContext();
        await resolveMemoryGrounding({
            task: 'Evaluate NFL slate',
            data: 'event_id=nfl-401999 | sport=americanfootball_nfl | KC @ BUF',
            domain: 'nfl',
            targetAppId: 'duelodds',
            bypassCache: false,
            memoryCortex: errCortex,
            toolRegistry: new ToolRegistry([]),
            context: ctxErr,
            includeShared: false
        });

        const errEvt = ctxErr.events.find((e) => e.action === 'Cortex Retrieval Complete');
        expect(errEvt).toBeDefined();
        expect(errEvt?.output?.status).toBe('Error');
        expect(errEvt?.output?.cortexSummary?.status).toBe('Error');
        expect(errEvt?.output?.embedError).toContain('404');

        // Healthy empty retrieval -> status: 'Empty'
        const okClient: any = {
            models: {
                embedContent: vi.fn(async () => ({
                    embeddings: [{ values: new Array(768).fill(0.15) }]
                }))
            }
        };
        const emptyCortex = new MemoryCortex({
            isolatedStore: true,
            defaultAppId: 'duelodds',
            aiClient: okClient,
            embeddingModel: 'gemini-embedding-2'
        });
        const ctxEmpty = new SwarmContext();
        await resolveMemoryGrounding({
            task: 'Evaluate NBA + NHL parlay',
            data: 'event_id=nba-401 | sport=basketball_nba | A @ B\nevent_id=nhl-402 | sport=icehockey_nhl | C @ D',
            domain: 'multi-sport',
            eventIds: ['nba-401', 'nhl-402'],
            targetAppId: 'duelodds',
            bypassCache: false,
            memoryCortex: emptyCortex,
            toolRegistry: new ToolRegistry([]),
            context: ctxEmpty,
            includeShared: false
        });

        const emptyEvt = ctxEmpty.events.find((e) => e.action === 'Cortex Retrieval Complete');
        expect(emptyEvt).toBeDefined();
        expect(emptyEvt?.output?.status).toBe('Empty');
        expect(emptyEvt?.output?.collectionName).toBe('pwa_swarm_dev_cortex_v4');
        expect(emptyEvt?.output?.embedModel).toBe('gemini-embedding-2');
        expect(emptyEvt?.output?.collectionPointCount).toBe(0);
        expect(emptyEvt?.output?.appliedDomains).toEqual(expect.arrayContaining(['nba', 'nhl']));
        expect(emptyEvt?.output?.embedError).toBeNull();
    });
});
