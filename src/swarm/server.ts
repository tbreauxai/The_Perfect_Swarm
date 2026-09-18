import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { executeSwarmWorkflow, type SwarmWorkflowParams, type SwarmWorkflowResult } from './engine.ts';
import type { SwarmEvent } from './types.ts';
import type { GoogleGenAI } from '@google/genai';
import type { MemoryCortex } from './memory.ts';

export interface SwarmServerOptions {
    port?: number;
    host?: string;
    defaultSettings?: any;
    defaultAi?: GoogleGenAI;
    defaultCortex?: MemoryCortex;
    cors?: boolean;
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
        const sendEvent = async (eventType: string, data: any) => {
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
                }
            });

            await sendEvent('swarm_complete', result);
        } catch (err: any) {
            await sendEvent('swarm_error', { error: err.stack || err.message || String(err) });
        }
    });
}

/**
 * Creates a standalone, zero-external-dependency Hono app for headless swarm deployments.
 */
export function createSwarmServer(options: SwarmServerOptions = {}): Hono {
    const app = new Hono();
    const defaultSettings = options.defaultSettings || {};
    const defaultAi = options.defaultAi;
    const defaultCortex = options.defaultCortex;

    if (options.cors !== false) {
        app.use('*', async (c, next) => {
            c.header('Access-Control-Allow-Origin', '*');
            c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (c.req.method === 'OPTIONS') {
                return c.body(null, 204);
            }
            await next();
        });
    }

    app.get('/api/health', (c) => {
        return c.json({ status: 'ok', edge: true });
    });

    app.all('/api/swarm/stream', async (c) => {
        let params: SwarmWorkflowParams;
        try {
            // Cloudflare Pages/Workers injects env variables into `c.env`.
            // We map them to the settings object so the Swarm engine can use them natively.
            const env = (c.env || {}) as Record<string, any>;
            const edgeSettings = {
                geminiApiKey: env.GEMINI_API_KEY,
                groqApiKey: env.GROQ_API_KEY,
                openRouterApiKey: env.OPENROUTER_API_KEY,
                mistralApiKey: env.MISTRAL_API_KEY,
                githubToken: env.GITHUB_TOKEN,
                qdrantUrl: env.QDRANT_URL,
                qdrantApiKey: env.QDRANT_API_KEY
            };

            if (c.req.method === 'POST') {
                const body = await c.req.json().catch(() => ({}));
                params = {
                    task: body.task,
                    data: body.data,
                    settings: { ...edgeSettings, ...defaultSettings, ...body.settings },
                    defaultAi: body.defaultAi || defaultAi,
                    cortex: body.cortex || defaultCortex,
                    enableDeepAnalysis: body.enableDeepAnalysis,
                    complexityOverride: body.complexityOverride
                };
            } else if (c.req.method === 'GET') {
                const url = new URL(c.req.url);
                const task = url.searchParams.get('task') || '';
                const data = url.searchParams.get('data') || '';
                const appId = url.searchParams.get('appId') || defaultSettings.appId || 'default';
                params = {
                    task,
                    data,
                    settings: { ...edgeSettings, ...defaultSettings, appId },
                    defaultAi,
                    cortex: defaultCortex
                };
            } else {
                return c.json({ error: 'Method Not Allowed' }, 405);
            }

            if (!params.task) {
                return c.json({ error: 'Missing required parameter: task' }, 400);
            }

            return handleSwarmSse(c, params);
        } catch (err: any) {
            console.error('[SwarmServer Stream Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    app.post('/api/swarm/analyze', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            if (!body.task) {
                return c.json({ error: 'Missing required parameter: task' }, 400);
            }

            const env = (c.env || {}) as Record<string, any>;
            const edgeSettings = {
                geminiApiKey: env.GEMINI_API_KEY,
                groqApiKey: env.GROQ_API_KEY,
                openRouterApiKey: env.OPENROUTER_API_KEY,
                mistralApiKey: env.MISTRAL_API_KEY,
                githubToken: env.GITHUB_TOKEN,
                qdrantUrl: env.QDRANT_URL,
                qdrantApiKey: env.QDRANT_API_KEY
            };

            const result = await executeSwarmWorkflow({
                task: body.task,
                data: body.data,
                settings: { ...edgeSettings, ...defaultSettings, ...body.settings },
                defaultAi: body.defaultAi || defaultAi,
                cortex: body.cortex || defaultCortex,
                enableDeepAnalysis: body.enableDeepAnalysis,
                complexityOverride: body.complexityOverride
            });

            return c.json(result);
        } catch (err: any) {
            console.error('[SwarmServer Analyze Error]:', err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    return app;
}
