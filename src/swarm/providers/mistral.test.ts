import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MistralAdapter } from './mistral';

describe('MistralAdapter 429 and Mutex Behavior', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('formats structured Mistral 429 (Code 1300) error with transparent diagnostics', async () => {
        const adapter = new MistralAdapter();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ message: 'Monthly and minutely capacity reached', code: 1300 })
        } as any);

        await expect(adapter.call({
            apiKey: 'test-key',
            modelName: 'mistral-small-latest',
            prompt: 'Hello Mistral'
        })).rejects.toThrow(/\[RATE_LIMIT_429\] Mistral API rate limit exceeded \(Code 1300\)/);
    });

    it('releases mutex immediately on 429 error without freezing subsequent calls for 31 seconds', async () => {
        const adapter = new MistralAdapter();
        let callCount = 0;

        globalThis.fetch = vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    ok: false,
                    status: 429,
                    text: async () => JSON.stringify({ message: 'Rate limit exceeded', code: 1300 })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: 'Success after error' } }]
                })
            };
        });

        const start = Date.now();

        // Call 1 fails with 429
        await expect(adapter.call({
            apiKey: 'test-key',
            modelName: 'mistral-small-latest',
            prompt: 'Call 1'
        })).rejects.toThrow();

        // Call 2 should NOT wait 31 seconds; it should proceed promptly (< 1000ms)
        const result = await adapter.call({
            apiKey: 'test-key',
            modelName: 'mistral-small-latest',
            prompt: 'Call 2'
        });

        const elapsed = Date.now() - start;
        expect(result).toBe('Success after error');
        expect(elapsed).toBeLessThan(1000); // Must not freeze for 31 seconds
    });
});
