import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { executeSwarmWorkflow, type SwarmWorkflowParams } from '../engine/index.ts';
import { SwarmContext } from '../context.ts';
import type { SwarmEvent } from '../types.ts';

/**
 * Parses provider and model strings from SwarmEvent.modelName formats such as
 * `"groq / openai/gpt-oss-120b"` or `"gemini -> cloudflare"`.
 */
export function parseEventProviderModel(
    modelName?: string,
    failover?: SwarmEvent['failover']
): { provider: string | null; model: string | null } {
    if (failover?.toProvider) {
        return {
            provider: String(failover.toProvider),
            model: failover.toModel ? String(failover.toModel) : null
        };
    }
    const raw = String(modelName || '').trim();
    if (!raw) return { provider: null, model: null };
    const arrowIdx = raw.lastIndexOf('->');
    const segment = arrowIdx >= 0 ? raw.slice(arrowIdx + 2).trim() : raw;
    const spacedSlash = segment.match(/^([a-z0-9_-]+)\s+\/\s+(.+)$/i);
    if (spacedSlash) {
        return { provider: spacedSlash[1].trim(), model: spacedSlash[2].trim() };
    }
    const tightSlash = segment.match(/^(gemini|groq|cloudflare|mistral|openrouter|nvidia|github|simulated)\/(.+)$/i);
    if (tightSlash) {
        return { provider: tightSlash[1].trim(), model: tightSlash[2].trim() };
    }
    if (failover?.fromProvider) {
        return {
            provider: String(failover.fromProvider),
            model: failover.fromModel ? String(failover.fromModel) : segment
        };
    }
    return { provider: null, model: segment };
}

/**
 * Handles Server-Sent Events (SSE) streaming for swarm execution using Hono.
 * Edge-compatible (Cloudflare Workers, Deno, Bun, Node.js).
 */
export async function handleSwarmSse(
    c: Context,
    params: SwarmWorkflowParams
) {
    return streamSSE(c, async (stream) => {
        const runStartedAt = Date.now();
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

        let workflowId: string = String((params.context as any)?.id || '');
        let lastStageSeen: string = 'init';
        const inFlightSeats = new Map<string, { seat: string; provider: string | null; model: string | null; startedAt: number }>();
        let lastActive: { seat: string | null; provider: string | null; model: string | null } = {
            seat: null,
            provider: null,
            model: null
        };

        const trackEvent = (event: SwarmEvent) => {
            if (!event || typeof event !== 'object') return;
            const role = typeof event.agentRole === 'string' && event.agentRole.trim() ? event.agentRole.trim() : null;
            const action = String(event.action || '');
            const parsed = parseEventProviderModel(event.modelName, event.failover);

            if (
                action === 'Started execution' ||
                action.startsWith('Executing proposal') ||
                action === 'Provider Failover Triggered' ||
                action === 'Verifier Bucket Decoupled'
            ) {
                const seatKey = role || lastActive.seat || 'unknown';
                const existing = inFlightSeats.get(seatKey);
                const nextEntry = {
                    seat: seatKey,
                    provider: parsed.provider ?? existing?.provider ?? lastActive.provider,
                    model: parsed.model ?? existing?.model ?? lastActive.model,
                    startedAt: existing?.startedAt ?? Date.now()
                };
                inFlightSeats.set(seatKey, nextEntry);
                lastActive = {
                    seat: nextEntry.seat,
                    provider: nextEntry.provider,
                    model: nextEntry.model
                };
            } else if (action.startsWith('Completed execution') || action === 'Failed execution') {
                if (role) {
                    inFlightSeats.delete(role);
                }
            } else if (role && (parsed.provider || parsed.model)) {
                lastActive = {
                    seat: role,
                    provider: parsed.provider ?? lastActive.provider,
                    model: parsed.model ?? lastActive.model
                };
            }
        };

        let deadlineTimer: any;
        const deadlinePromise = new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
                reject(new Error('run_timeout'));
            }, runDeadlineMs);
        });

        try {
            const runContext = params.context || new SwarmContext();
            workflowId = String((runContext as any).id || `wf-${Date.now()}`);
            (runContext as any).id = workflowId;
            params.context = runContext;
            await sendEvent('swarm_started', { workflowId });
            const executor = (params as any).workflowExecutor || executeSwarmWorkflow;
            const workflowPromise = executor({
                ...params,
                onEvent: async (event: SwarmEvent) => {
                    trackEvent(event);
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
                        const sp = stagePayload as Record<string, any>;
                        if (typeof sp.activeSeat === 'string' || typeof sp.seat === 'string') {
                            const sName = String(sp.activeSeat || sp.seat);
                            lastActive = {
                                seat: sName,
                                provider: typeof sp.activeProvider === 'string' ? sp.activeProvider : (typeof sp.provider === 'string' ? sp.provider : lastActive.provider),
                                model: typeof sp.activeModel === 'string' ? sp.activeModel : (typeof sp.model === 'string' ? sp.model : lastActive.model)
                            };
                        }
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
            const elapsedMs = Math.max(0, Date.now() - runStartedAt);

            let stalled = lastActive;
            if (inFlightSeats.size > 0) {
                let oldest: { seat: string; provider: string | null; model: string | null; startedAt: number } | null = null;
                for (const entry of inFlightSeats.values()) {
                    if (!oldest || entry.startedAt < oldest.startedAt) {
                        oldest = entry;
                    }
                }
                if (oldest) {
                    stalled = { seat: oldest.seat, provider: oldest.provider, model: oldest.model };
                }
            }

            await sendEvent('swarm_error', {
                error: errorReason,
                workflowId,
                stage: lastStageSeen,
                lastStage: lastStageSeen,
                activeSeat: stalled.seat,
                activeProvider: stalled.provider,
                activeModel: stalled.model,
                elapsedMs
            });
            isClosed = true;
        } finally {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            clearInterval(heartbeatInterval);
        }
    });
}
