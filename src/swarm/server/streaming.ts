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

        try {
            const result = await executeSwarmWorkflow({
                ...params,
                onEvent: async (event: SwarmEvent) => {
                    await sendEvent('swarm_event', event);
                    if (params.onEvent) {
                        params.onEvent(event);
                    }
                },
                onStage: async (stagePayload) => {
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

            const payload: any = { ...result };
            if (result.workflowId) {
                payload.workflowId = result.workflowId;
            } else {
                delete payload.workflowId;
            }

            await sendEvent('swarm_complete', payload);
        } catch (err: any) {
            await sendEvent('swarm_error', { error: err.message || String(err) });
        } finally {
            clearInterval(heartbeatInterval);
        }
    });
}
