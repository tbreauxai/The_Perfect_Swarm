import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { executeSwarmWorkflow, type SwarmWorkflowParams } from '../engine/index.ts';
import type { SwarmEvent } from '../types.ts';

/**
 * Handles Server-Sent Events (SSE) streaming for swarm execution using Hono.
 * Edge-compatible (Cloudflare Workers, Deno, Bun, Node.js).
 */
export async function handleSwarmSse(
    c: Context,
    params: SwarmWorkflowParams
) {
    return streamSSE(c, async (stream) => {
        let isClosed = false;
        stream.onAbort(() => {
            isClosed = true;
        });

        // Periodic keepalive heartbeat comment (15s) below client idle timeout
        const heartbeatInterval = setInterval(async () => {
            if (isClosed || stream.aborted || stream.closed) {
                clearInterval(heartbeatInterval);
                return;
            }
            try {
                await stream.write(':keepalive\n\n');
            } catch {
                clearInterval(heartbeatInterval);
            }
        }, 15000);

        const sendEvent = async (eventType: string, data: any) => {
            if (isClosed || stream.aborted || stream.closed) return;
            try {
                await stream.writeSSE({
                    event: eventType,
                    data: JSON.stringify(data),
                });
            } catch (err) {
                console.error(`[SSE Write Error]:`, err);
            }
        };

        const defaultRunDeadline = 240000;
        const runDeadlineMs = (typeof process !== 'undefined' && process.env?.SWARM_RUN_DEADLINE_MS)
            ? Number(process.env.SWARM_RUN_DEADLINE_MS) || defaultRunDeadline
            : defaultRunDeadline;

        let lastStageSeen: string = 'init';
        let deadlineTimer: any;
        const deadlinePromise = new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
                reject(new Error('run_timeout'));
            }, runDeadlineMs);
        });

        try {
            const workflowPromise = executeSwarmWorkflow({
                ...params,
                onEvent: async (event: SwarmEvent) => {
                    await sendEvent('swarm_event', event);
                    if (params.onEvent) {
                        params.onEvent(event);
                    }
                },
                onStage: async (stagePayload) => {
                    if (typeof stagePayload === 'string') {
                        lastStageSeen = stagePayload;
                    } else if (stagePayload && typeof (stagePayload as any).stage === 'string') {
                        lastStageSeen = (stagePayload as any).stage;
                    }
                    await sendEvent('swarm_stage', stagePayload);
                    if (params.onStage) {
                        params.onStage(stagePayload);
                    }
                },
                onPartialResult: async (partialResult) => {
                    await sendEvent('swarm_partial', partialResult);
                    if (params.onPartialResult) {
                        params.onPartialResult(partialResult);
                    }
                }
            });

            const result = await Promise.race([workflowPromise, deadlinePromise]);

            const payload: any = { ...result };
            if (result.workflowId) {
                payload.workflowId = String(result.workflowId);
            } else {
                delete payload.workflowId;
            }
            // PS1: partial runs are still swarm_complete, flagged with status:'partial'; degraded = seat ids with no backup left.
            if (params.candidateId) {
                payload.candidate_id = params.candidateId;
            }
            if (params.seedManifest) {
                payload.manifest_version = params.seedManifest.manifest_version;
            }
            payload.status = (result as any).status || 'complete';
            payload.degraded = Array.isArray((result as any).degraded) ? (result as any).degraded : [];
            payload.tools_called = Array.isArray((result as any).tools_called) ? (result as any).tools_called : [];

            await sendEvent('swarm_complete', payload);
        } catch (err: any) {
            clearInterval(heartbeatInterval);
            const errMsg = String(err?.message || err || '');
            const errorReason = errMsg === 'run_timeout' ? 'run_timeout' : errMsg;
            await sendEvent('swarm_error', {
                error: errorReason,
                stage: lastStageSeen
            });
            isClosed = true;
        } finally {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            clearInterval(heartbeatInterval);
        }
    });
}
