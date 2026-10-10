import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
