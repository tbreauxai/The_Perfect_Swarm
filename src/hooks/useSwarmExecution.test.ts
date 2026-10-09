import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let states: any[] = [];
let stateSetters: Array<(v: any) => void> = [];
let refs: Array<{ current: any }> = [];
let stateIndex = 0;
let refIndex = 0;

vi.mock('react', () => {
    return {
        useState: (initial: any) => {
            const idx = stateIndex++;
            if (!(idx in states)) {
                states[idx] = typeof initial === 'function' ? initial() : initial;
                stateSetters[idx] = (newVal: any) => {
                    states[idx] = typeof newVal === 'function' ? newVal(states[idx]) : newVal;
                };
            }
            return [states[idx], stateSetters[idx]];
        },
        useRef: (initial: any) => {
            const idx = refIndex++;
            if (!(idx in refs)) {
                refs[idx] = { current: initial };
            }
            return refs[idx];
        }
    };
});

import { useSwarmExecution } from './useSwarmExecution';

describe('useSwarmExecution - In-Flight Guard & Error Hang Protection', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        states = [];
        stateSetters = [];
        refs = [];
        stateIndex = 0;
        refIndex = 0;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function getHook() {
        stateIndex = 0;
        refIndex = 0;
        return useSwarmExecution();
    }

    it('rapid double-click / concurrent runSwarm dispatches only one POST request', async () => {
        let postCount = 0;
        globalThis.fetch = vi.fn().mockImplementation(async () => {
            postCount++;
            // Simulate in-flight delay
            await new Promise((resolve) => setTimeout(resolve, 50));
            return new Response('event: swarm_complete\ndata: {"status":"done"}\n\n', {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        });

        const hook = getHook();
        const settings: any = { agents: [] };

        // Dispatch two rapid calls concurrently
        const p1 = hook.runSwarm('Task 1', 'Data 1', settings);
        const p2 = hook.runSwarm('Task 2', 'Data 2', settings);

        await Promise.all([p1, p2]);

        expect(postCount).toBe(1);
    });

    it('mock 401 with hanging / non-resolving body safely times out and resets loading without staying stuck', async () => {
        // Create response with 401 status and a stream that never resolves
        const hangingStream = new ReadableStream({
            start() {
                // Never enqueue or close
            }
        });

        const hanging401Response = new Response(hangingStream, {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });

        globalThis.fetch = vi.fn().mockResolvedValue(hanging401Response);

        const hook = getHook();
        const settings: any = { agents: [] };

        // Run swarm and await completion (body read should timeout via parseHttpError)
        await hook.runSwarm('Test task', 'Test data', settings);

        // Re-read hook state
        const updated = getHook();

        // Loading must be false
        expect(updated.loading).toBe(false);

        // Error must be populated with calm app-auth message, not stuck analyzing
        expect(updated.error).toContain('App token required');
    });

    it('handles explicit user cancellation via cancelSwarm', async () => {
        let abortSignal: AbortSignal | null = null;
        globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
            abortSignal = opts?.signal;
            return new Promise((_resolve, reject) => {
                opts?.signal?.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });

        const hook = getHook();
        const settings: any = { agents: [] };

        const runPromise = hook.runSwarm('Test task', 'Test data', settings);
        expect(getHook().loading).toBe(true);

        // Cancel
        hook.cancelSwarm();
        await runPromise;

        const updated = getHook();
        expect(updated.loading).toBe(false);
        expect(updated.error).toBe('Analysis cancelled by user.');
    });
});
