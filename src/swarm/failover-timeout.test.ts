import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from './agent.ts';
import { SwarmContext } from './context.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { GeminiAdapter } from './providers/gemini.ts';
import { GeminiEmbeddingProvider } from './memory.ts';
import { SwarmClient } from './client.ts';
import { createTokenChunks } from './profiler.ts';

describe('Phase 1: Failover, Timeout Guards, and Stream Error Handling', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('immediately cascades to fallback provider on 429 without waiting through 4 retries', async () => {
        let primaryCallCount = 0;
        let backupCallCount = 0;

        ProviderRegistry.register({
            providerName: 'test-primary-429' as any,
            async call() {
                primaryCallCount++;
                throw new Error('[RATE_LIMIT_429] Provider rate limit exceeded (429)');
            }
        });

        ProviderRegistry.register({
            providerName: 'test-backup-success' as any,
            async call() {
                backupCallCount++;
                return JSON.stringify({ success: true, source: 'backup' });
            }
        });

        const agent = new Agent(
            'Test Agent',
            'primary-model',
            'test-primary-429' as any,
            'key-1',
            undefined,
            [{ provider: 'test-backup-success' as any, apiKey: 'key-2', modelName: 'backup-model' }]
        );

        const context = new SwarmContext();
        const startTime = Date.now();
        const result = await agent.run('Task prompt', context, { responseMimeType: 'application/json' });
        const duration = Date.now() - startTime;

        expect(result.source).toBe('backup');
        // Must fail over on attempt 1, NOT retrying 4 times with exponential backoff (which would take >14s)
        expect(primaryCallCount).toBe(1);
        expect(backupCallCount).toBe(1);
        expect(duration).toBeLessThan(3000);
    });

    it('rejects GeminiAdapter call with timeout error when generateContent hangs', async () => {
        const adapter = new GeminiAdapter();
        const hangingClient: any = {
            models: {
                generateContent: vi.fn().mockImplementation(() => new Promise(() => {
                    // Never resolves
                }))
            }
        };

        await expect(adapter.call({
            apiKey: 'test-key',
            modelName: 'gemini-2.5-flash',
            prompt: 'Test prompt',
            aiClient: hangingClient,
            timeoutMs: 100
        })).rejects.toThrow(/\[TIMEOUT\] Gemini request timed out after 100ms/);
    });

    it('times out GeminiEmbeddingProvider embed when embedContent hangs', async () => {
        const hangingClient: any = {
            models: {
                embedContent: vi.fn().mockImplementation(() => new Promise(() => {
                    // Never resolves
                }))
            }
        };

        const provider = new GeminiEmbeddingProvider(hangingClient, 'text-embedding-004', 100);
        await expect(provider.embed('Test text')).rejects.toThrow(/\[TIMEOUT\] Gemini embedding request timed out/);
    });

    it('surfaces swarm_error event in SwarmClient streamRemote instead of silently ignoring it', async () => {
        const sseErrorPayload = 'event: swarm_error\ndata: {"error":"Model overloaded"}\n\n';
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(sseErrorPayload));
                controller.close();
            }
        });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            body: stream
        } as any);

        try {
            const client = new SwarmClient({ mode: 'remote', serverUrl: 'http://localhost:3000' });
            const events: any[] = [];

            for await (const chunk of client.stream({ task: 'Analyze' })) {
                events.push(chunk);
            }

            const errorChunk = events.find(e => e.type === 'error' || e.error);
            expect(errorChunk).toBeDefined();
            expect(errorChunk?.error || errorChunk?.finalAnalysis?.error).toContain('Model overloaded');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('splits ultra-long single-line payloads without newlines so no chunk exceeds maxTokensPerChunk', () => {
        // A single-line string of 60,000 characters without newlines (~15,000 tokens)
        const longSingleLine = 'x'.repeat(60000);
        const maxTokensPerChunk = 2000;
        const result = createTokenChunks(longSingleLine, maxTokensPerChunk, 8);

        expect(result.chunks.length).toBeGreaterThan(1);
        for (const chunk of result.chunks) {
            const tokens = Math.ceil(chunk.length / 4);
            // Must not exceed maxTokensPerChunk
            expect(tokens).toBeLessThanOrEqual(maxTokensPerChunk + 10);
        }
    });
});
