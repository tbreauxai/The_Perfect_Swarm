import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createSwarmServer } from './app.ts';
import { MemoryCortex } from '../memory/cortex.ts';
import { globalFeedbackEngine } from '../feedback.ts';
import {
    initFeedbackDedupe,
    markFeedbackProcessed,
    isFeedbackProcessed,
    _resetFeedbackDedupe
} from './feedbackDedupe.ts';

// We mock the Supabase Client module globally so it retains data across initFeedbackDedupe calls
const mockDataStore = new Set<string>();
vi.mock('@supabase/supabase-js', () => {
    return {
        createClient: vi.fn(() => {
            return {
                from: vi.fn(() => ({
                    select: vi.fn(() => ({
                        eq: vi.fn((field, value) => ({
                            maybeSingle: vi.fn(async () => {
                                if (mockDataStore.has(value)) {
                                    return { data: { dedupe_key: value }, error: null };
                                }
                                return { data: null, error: null };
                            })
                        }))
                    })),
                    insert: vi.fn(async (rows: any[]) => {
                        for (const row of rows) {
                            mockDataStore.add(row.dedupe_key);
                        }
                        return { error: null };
                    })
                }))
            };
        })
    };
});

describe('Feedback Dedupe - Store Selection', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
        _resetFeedbackDedupe();
        mockDataStore.clear();
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.clearAllMocks();
    });

    it('uses Supabase store if RENDER_DISK_PATH is unset and Supabase env vars are set', async () => {
        delete process.env.RENDER_DISK_PATH;
        process.env.SUPABASE_URL = 'http://mock-supabase.com';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-key';

        initFeedbackDedupe();

        const testKey = 'test-supabase-key';

        expect(await isFeedbackProcessed(testKey)).toBe(false);

        markFeedbackProcessed(testKey);

        // Wait a tick for async save to happen
        await new Promise(resolve => setTimeout(resolve, 0));

        // Let's reset the local state, forcing it to fetch from Supabase
        _resetFeedbackDedupe();
        initFeedbackDedupe();

        expect(await isFeedbackProcessed(testKey)).toBe(true);
    });

    it('falls back to in-memory if no env vars are set', async () => {
        delete process.env.RENDER_DISK_PATH;
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;

        initFeedbackDedupe();

        const testKey = 'test-memory-key';

        expect(await isFeedbackProcessed(testKey)).toBe(false);

        markFeedbackProcessed(testKey);

        // Wait a tick for async save to happen
        await new Promise(resolve => setTimeout(resolve, 0));

        // Local state is populated, should return true
        expect(await isFeedbackProcessed(testKey)).toBe(true);

        // Resetting state clears memory, and since it's not persistent, it should return false
        _resetFeedbackDedupe();
        initFeedbackDedupe();

        expect(await isFeedbackProcessed(testKey)).toBe(false);
    });
});


describe('Feedback Route Workflow Deduplication & Lesson Upsert/Delete', () => {
    let app: any;
    let cortex: MemoryCortex;

    beforeEach(async () => {
        _resetFeedbackDedupe();
        cortex = new MemoryCortex({
            collectionName: 'test-feedback-cortex'
        });
        await cortex.initialize();

        const baseApp = createSwarmServer({
            defaultSettings: { appId: 'duelodds' },
            defaultCortex: cortex
        });

        app = new Hono();
        app.use('*', async (c: any, next: any) => {
            c.set('callerAppId', 'duelodds');
            await next();
        });
        app.route('/', baseApp);
    });

    it('a second feedback for the same workflow updates the outcome and does not insert another', async () => {
        const workflowId = 'wf-dedupe-' + Date.now();
        const repo = globalFeedbackEngine.getKnowledgeRepository();
        
        await cortex.store('Analysis for matchup', {
            workflowId,
            originApp: 'duelodds',
            appId: 'duelodds',
            memoryType: 'judgment'
        });

        repo.recordOutcome({
            id: 'out-' + workflowId,
            workflowId,
            appId: 'duelodds',
            originApp: 'duelodds',
            outcome: 'push',
            timestamp: Date.now()
        } as any);

        const initialOutcomesCount = repo.queryOutcomes().filter((o: any) => o.workflowId === workflowId).length;
        expect(initialOutcomesCount).toBe(1);

        const res1 = await app.request('/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflowId,
                outcome: 'win',
                reason: 'Chiefs passing game dominance',
                reasonSource: 'DuelOddsModel',
                oddsBucket: '-110',
                lessonId: 'lesson-' + workflowId,
                closingLineValue: 1.5
            })
        });
        expect(res1.status).toBe(200);

        const outcomesAfterFirst = repo.queryOutcomes().filter((o: any) => o.workflowId === workflowId);
        expect(outcomesAfterFirst.length).toBe(1);
        expect((outcomesAfterFirst[0] as any).outcome).toBe('win');
        expect((outcomesAfterFirst[0] as any).reason).toBe('Chiefs passing game dominance');
        expect((outcomesAfterFirst[0] as any).closingLineValue).toBe(1.5);

        const res2 = await app.request('/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflowId,
                outcome: 'win',
                reason: 'Chiefs passing game dominance updated',
                closingLineValue: 2.0
            })
        });
        expect(res2.status).toBe(200);

        const outcomesAfterSecond = repo.queryOutcomes().filter((o: any) => o.workflowId === workflowId);
        expect(outcomesAfterSecond.length).toBe(1);
        expect((outcomesAfterSecond[0] as any).outcome).toBe('win');
    });

    it('A graded lesson upserts Qdrant point id = lessonId. A deleteLessonId removes it.', async () => {
        const lessonId = 'test-lesson-' + Date.now();
        const workflowId = 'wf-lesson-' + Date.now();

        await cortex.store('Matchup prediction', {
            workflowId,
            originApp: 'duelodds',
            appId: 'duelodds',
            memoryType: 'judgment'
        });

        const res1 = await app.request('/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflowId,
                outcome: 'win',
                lessonId,
                reason: 'Underdogs cover in divisional weather games',
                reasonSource: 'DuelOdds',
                oddsBucket: '+3.5',
                closingLineValue: 0.5
            })
        });
        expect(res1.status).toBe(200);

        const inMemoryPoints = cortex.fallbackStore;
        const savedLesson = inMemoryPoints.find(p => p.id === lessonId);
        expect(savedLesson).toBeDefined();
        expect(savedLesson?.id).toBe(lessonId);
        expect(savedLesson?.payload?.type).toBe('graded_lesson');
        expect(savedLesson?.payload?.reason).toBe('Underdogs cover in divisional weather games');

        const res2 = await app.request('/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deleteLessonId: lessonId
            })
        });
        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.ok).toBe(true);
        expect(data2.deleted).toBe(lessonId);

        const afterDeletePoints = cortex.fallbackStore;
        expect(afterDeletePoints.find(p => p.id === lessonId)).toBeUndefined();
    });
});
