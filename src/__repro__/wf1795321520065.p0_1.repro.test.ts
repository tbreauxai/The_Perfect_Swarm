import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryCortex } from '../swarm/memory.ts';
import { QdrantStorageAdapter } from '../swarm/memory/storage/qdrantStorage.ts';
import { InMemoryStorageAdapter } from '../swarm/memory/storage/inMemoryStorage.ts';
import { CortexPersistenceManager } from '../swarm/memory/persistence/cortexPersistence.ts';
import { CortexConsolidator } from '../swarm/memory/consolidation/cortexConsolidator.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/index.ts';
import { resolveMemoryGrounding } from '../swarm/engine/memoryGrounding.ts';
import { formatLearnedVerdictContent, runLearningPipeline } from '../swarm/engine/learningPipeline.ts';

describe('wf-1795321520065 P0-1: HybridCortex Sanitization, Pass Blocking & v3 Migration', () => {
    beforeEach(() => {
        InMemoryStorageAdapter.clearGlobalStore('pwa_swarm_dev_cortex_v3');
    });

    it('upserting a run with a 5,000-char boilerplate task stores only clean 1-line userPrompt and concise summary/lesson (< 500 chars)', async () => {
        const longBoilerplate = [
            'Two-Hop Swarm Review: what is the best parlay to place today?',
            'Operational Mode: PREGAME',
            'User Bankroll: $1000.00',
            'TOOL RULE: Do not use native function calling. Lines prefixed MODEL are app math.',
            'PICK OUTPUT CONTRACT (applies to every chat response): cite R1..R20.',
            'FILTERED DATA TOOL RULE: Call get_matchup_fundamentals before passing.',
            'INJURY & PARLAY CALIBRATION: Only correlated legs.',
            'REQUIRED RISK CRITIC: Veto weak edges.',
            'MORNING BASELINE: Knicks @ Celtics',
            'TARGET BRIEF: $10 to win $50',
            'You receive a compact slate, not game context or pricing.',
            '=== COMPACT SLATE ===',
            ...Array.from({ length: 80 }, (_, i) => `event_id=nba-4019${i} | Away ${i} @ Home ${i} | sp -3.5 | ml -150/+130 | tot 220.5`)
        ].join('\n');
        expect(longBoilerplate.length).toBeGreaterThan(5000);

        const cortex = new MemoryCortex({
            defaultAppId: 'duelodds',
            isolatedStore: true,
            autoSave: false
        });
        const storeSpy = vi.spyOn(cortex, 'store');

        const learned: any[] = [];
        const ctx = new SwarmContext();
        (ctx as any).id = 'wf-clean-parlay-1';

        await runLearningPipeline({
            task: longBoilerplate,
            data: '=== COMPACT SLATE ===\nevent_id=nba-401900 | Knicks @ Celtics | sp -4.5',
            finalAnalysis: {
                ui_title: '2-Leg NBA Parlay Grounded',
                summary: 'Celtics -4.5 paired with Under 218.5 backed by rim defense edges.',
                picks: [{ row: 'R1', market: 'spread' }, { row: 'R4', market: 'total' }],
                wageringPass: false,
                criticApproved: true
            },
            context: ctx,
            params: {
                task: longBoilerplate,
                userPrompt: "what's the best parlay to place today?",
                domain: 'basketball_nba',
                domains: ['basketball_nba', 'icehockey_nhl'],
                onMemoryLearned: (m: any) => learned.push(m)
            } as any,
            settings: { appId: 'duelodds', domain: 'basketball_nba' } as any,
            workflowStartTime: Date.now() - 250,
            complexity: 'complex',
            workflowLifecycleResult: {
                success: true,
                computedRating: 0.92,
                criticFeedback: 'Verified FanDuel prices and injury status before approval.'
            },
            analysts: [{ id: 'a1', role: 'Quant', provider: 'gemini', modelName: 'g1' } as any],
            managerAgent: { id: 'mgr', role: 'Manager', provider: 'gemini', modelName: 'g1' } as any,
            memoryCortex: cortex,
            targetAppId: 'duelodds',
            cacheKey: 'k-clean-1',
            cacheQuery: 'q-clean-1',
            agentConfigVersion: 'v1',
            tieredCacheEnabled: false,
            profilingEnabled: false,
            coordinationEnabled: false,
            workflowTotalTokens: 400,
            workflowPromptTokensSaved: 100,
            workflowOriginalPromptTokens: 500,
            workflowCompressedPromptTokens: 400,
            workflowDeduplicatedCount: 0
        });

        expect(storeSpy).toHaveBeenCalledTimes(1);
        expect(learned).toHaveLength(1);
        const storedContent: string = learned[0].content;
        const storedMeta = learned[0].metadata;

        expect(storedContent.length).toBeLessThan(500);
        expect(storedContent).toContain("what's the best parlay to place today?");
        expect(storedContent).not.toContain('PICK OUTPUT CONTRACT');
        expect(storedContent).not.toContain('FILTERED DATA TOOL RULE');
        expect(storedContent).not.toContain('INJURY & PARLAY CALIBRATION');
        expect(storedContent).not.toContain('REQUIRED RISK CRITIC');
        expect(storedContent).not.toContain('TOOL RULE:');
        expect(storedContent).not.toContain('=== COMPACT SLATE ===');

        expect(storedMeta.userPrompt).toBe("what's the best parlay to place today?");
        expect(storedMeta.task).toBe("what's the best parlay to place today?");
        expect(storedMeta.userPrompt.length).toBeLessThanOrEqual(160);
        expect(storedMeta.resultSummary.length).toBeLessThanOrEqual(240);
        expect(storedMeta.lesson.length).toBeLessThanOrEqual(300);
        expect(storedMeta.mode).toBe('pregame');
        expect(storedMeta.picksCount).toBe(2);

        // Also ensure direct formatLearnedVerdictContent never preserves contract markers
        const directContent = formatLearnedVerdictContent(longBoilerplate, {
            ui_title: '2-Leg Parlay',
            picks: [{ row: 'R1' }]
        });
        expect(directContent.length).toBeLessThan(500);
        expect(directContent).not.toContain('PICK OUTPUT CONTRACT');
        expect(directContent).not.toContain('=== COMPACT SLATE ===');
    });

    it('never writes or promotes a 0-bet wageringPass run (even with 0.98 rating) into VALIDATED WINNING PATTERNS or Learning Exemplars', async () => {
        const cortex = new MemoryCortex({
            defaultAppId: 'duelodds',
            isolatedStore: true,
            autoSave: false
        });
        const storeSpy = vi.spyOn(cortex, 'store');
        const ctx = new SwarmContext();
        (ctx as any).id = 'wf-1795298894431';

        // 1. RunLearningPipeline blocks 0-bet pass completely
        await runLearningPipeline({
            task: "what's the best parlay to place today?",
            data: '',
            finalAnalysis: {
                ui_title: 'Pregame Analysis: Strategic Pass',
                summary: 'No bets qualify tonight.',
                picks: [],
                wageringPass: true,
                pass: true
            },
            context: ctx,
            params: { task: "what's the best parlay to place today?" } as any,
            settings: { appId: 'duelodds' } as any,
            workflowStartTime: Date.now() - 100,
            complexity: 'complex',
            workflowLifecycleResult: {
                success: true,
                computedRating: 0.98,
                criticFeedback: 'Clean strategic pass.'
            },
            analysts: [],
            managerAgent: { id: 'mgr', role: 'Manager', provider: 'gemini', modelName: 'g1' } as any,
            memoryCortex: cortex,
            targetAppId: 'duelodds',
            cacheKey: 'k-pass-1',
            cacheQuery: 'q-pass-1',
            agentConfigVersion: 'v1',
            tieredCacheEnabled: false,
            profilingEnabled: false,
            coordinationEnabled: false,
            workflowTotalTokens: 100,
            workflowPromptTokensSaved: 0,
            workflowOriginalPromptTokens: 100,
            workflowCompressedPromptTokens: 100,
            workflowDeduplicatedCount: 0
        });

        expect(storeSpy).not.toHaveBeenCalled();
        expect(cortex.fallbackCount).toBe(0);

        // 2. Direct MemoryCortex.store also blocks wageringPass / picksCount: 0
        const directPassId = await cortex.store('Result: Pregame Analysis: Strategic Pass', {
            workflowId: 'wf-pass-direct',
            originApp: 'duelodds',
            qualityRating: 0.98,
            verified: true,
            wageringPass: true,
            picksCount: 0
        });
        expect(directPassId).toBeNull();

        // 3. Even if legacy poisoned pass or ungraded non-win record sits directly in fallbackStore,
        // retrieveExemplars and retrieveContrastivePostMortems never return it under Wins or Exemplars
        cortex.fallbackStore.push({
            id: 'legacy-pass-hit',
            denseVector: Array(64).fill(0.1),
            sparseVector: { indices: [1], values: [1] },
            payload: {
                workflowId: 'wf-1795298894431',
                content: 'Result: Pregame Analysis: Strategic Pass',
                appId: 'duelodds',
                originApp: 'duelodds',
                domain: 'general',
                qualityRating: 0.98,
                verified: true,
                frequency: 1,
                timestamp: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            }
        });
        cortex.fallbackStore.push({
            id: 'ungraded-high-rating',
            denseVector: Array(64).fill(0.1),
            sparseVector: { indices: [2], values: [1] },
            payload: {
                workflowId: 'wf-ungraded-1',
                content: 'Ungraded pregame parlay idea',
                appId: 'duelodds',
                originApp: 'duelodds',
                domain: 'general',
                memoryType: 'judgment',
                qualityRating: 0.95,
                verified: false,
                picksCount: 2,
                frequency: 1,
                timestamp: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            }
        });

        const exemplars = await cortex.retrieveExemplars("what's the best parlay to place today?", {
            appId: 'duelodds',
            minRating: 0.7
        });
        const contrastive = await cortex.retrieveContrastivePostMortems("what's the best parlay to place today?", {
            appId: 'duelodds'
        });

        expect(exemplars).toBe('');
        expect(contrastive.wins).toHaveLength(0);
        expect(contrastive.formattedBlock).not.toContain('VALIDATED WINNING PATTERNS');
        expect(contrastive.formattedBlock).not.toContain('Strategic Pass');
    });

    it('retrieval sanitizer drops legacy TOOL RULE / MORNING BASELINE / PICK OUTPUT records and caps output <= 1200 chars', async () => {
        const fakeCortex: any = {
            retrieve: vi.fn().mockResolvedValue([
                {
                    id: 'poison-1',
                    content: 'TOOL RULE: Use calculator. MORNING BASELINE: Knicks @ Celtics. PICK OUTPUT CONTRACT: schema...'
                },
                {
                    id: 'poison-pass',
                    content: 'Result: Pregame Analysis: Strategic Pass',
                    qualityRating: 0.99
                },
                {
                    id: 'valid-1',
                    rule: 'Prioritize road underdogs with confirmed rim-protector advantage and +2.0% CLV.'
                }
            ]),
            retrieveExemplars: vi.fn().mockResolvedValue(
                'A'.repeat(600)
            ),
            retrieveContrastivePostMortems: vi.fn().mockResolvedValue({
                wins: [{ content: 'Celtics -5.5 cashed with healthy rotation', brierScore: 0.08 }],
                losses: [{ content: 'Missed late scratch on starting PG', brierScore: 0.42 }],
                formattedBlock: new CortexConsolidator({
                    storage: new InMemoryStorageAdapter({ isolatedStore: true })
                }).formatContrastivePostMortems(
                    [
                        { content: 'Result: Pregame Analysis: Strategic Pass', brierScore: 0.01 },
                        { content: 'FILTERED DATA TOOL RULE: must strip', brierScore: 0.02 },
                        { content: 'Celtics -5.5 cashed with healthy rotation '.repeat(12), brierScore: 0.08 }
                    ],
                    [
                        { content: 'Missed late scratch on starting PG '.repeat(12), brierScore: 0.42 }
                    ]
                )
            })
        };

        const ctx = new SwarmContext();
        const grounding = await resolveMemoryGrounding({
            memoryCortex: fakeCortex,
            task: 'Best NBA bets tonight?',
            targetAppId: 'duelodds',
            includeShared: true,
            bypassCache: true,
            toolRegistry: new ToolRegistry(),
            context: ctx
        });

        expect(grounding.historicalContext.length).toBeLessThanOrEqual(1200);
        expect(grounding.historicalContext).not.toContain('TOOL RULE:');
        expect(grounding.historicalContext).not.toContain('MORNING BASELINE');
        expect(grounding.historicalContext).not.toContain('PICK OUTPUT');
        expect(grounding.historicalContext).not.toContain('Strategic Pass');
        expect(grounding.historicalContext).toContain('Prioritize road underdogs');
    });

    it('defaults to pwa_swarm_dev_cortex_v3 and gracefully handles uninitialized collections without 404 errors', async () => {
        const storageDefault = new QdrantStorageAdapter();
        const inMemDefault = new InMemoryStorageAdapter();
        const persistDefault = new CortexPersistenceManager({ storage: inMemDefault });
        expect((storageDefault as any).collectionName).toBe('pwa_swarm_dev_cortex_v3');
        expect((inMemDefault as any).collectionName).toBe('pwa_swarm_dev_cortex_v3');
        expect((persistDefault as any).collectionName).toBe('pwa_swarm_dev_cortex_v3');

        // Legacy v2 string auto-migrates to v3
        const storageMigrated = new QdrantStorageAdapter({ collectionName: 'pwa_swarm_dev_cortex_v2' });
        expect((storageMigrated as any).collectionName).toBe('pwa_swarm_dev_cortex_v3');

        let collectionCreated = false;
        const mockClient: any = {
            getCollections: vi.fn(async () => ({
                collections: collectionCreated ? [{ name: 'pwa_swarm_dev_cortex_v3' }] : []
            })),
            getCollection: vi.fn(async () => ({ payload_schema: {} })),
            createCollection: vi.fn(async (name: string) => {
                if (name === 'pwa_swarm_dev_cortex_v3') collectionCreated = true;
                return true;
            }),
            createPayloadIndex: vi.fn(async () => true),
            query: vi.fn(async () => {
                if (!collectionCreated) {
                    const err: any = new Error('Not found: Collection pwa_swarm_dev_cortex_v3 does not exist');
                    err.status = 404;
                    throw err;
                }
                return { points: [] };
            }),
            upsert: vi.fn(async () => ({ status: 'completed' }))
        };

        const cortex = new MemoryCortex({
            url: 'https://qdrant.example.invalid',
            defaultAppId: 'duelodds',
            autoSave: false
        });
        cortex.qdrant = mockClient;

        const ctx = new SwarmContext();
        const emptyGrounding = await resolveMemoryGrounding({
            memoryCortex: cortex,
            task: 'Best NBA spread tonight?',
            targetAppId: 'duelodds',
            includeShared: false,
            bypassCache: true,
            toolRegistry: new ToolRegistry(),
            context: ctx
        });

        expect(emptyGrounding.historicalContext).not.toContain('Failed to retrieve baselines');
        const completeEvent = ctx.events.find((e) => e.action === 'Cortex Retrieval Complete');
        expect(completeEvent?.output?.recordsFound).toBe(0);
        expect(mockClient.createCollection).not.toHaveBeenCalled();

        // First valid upsert auto-creates pwa_swarm_dev_cortex_v3
        const storedId = await cortex.store('Prompt: NBA spread\nResult: Nuggets -4.5 (-110) cashed', {
            originApp: 'duelodds',
            appId: 'duelodds',
            picksCount: 1,
            outcome: 'win'
        });

        expect(storedId).toBeTruthy();
        expect(mockClient.createCollection).toHaveBeenCalledWith(
            'pwa_swarm_dev_cortex_v3',
            expect.any(Object)
        );
        expect(mockClient.upsert).toHaveBeenCalledWith(
            'pwa_swarm_dev_cortex_v3',
            expect.any(Object)
        );
    });
});
