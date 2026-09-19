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
            const env = (c.env && Object.keys(c.env).length > 0 ? c.env : process.env) as Record<string, any>;
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
                const cleanBodySettings = Object.fromEntries(
                    Object.entries(body.settings || {}).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
                );
                params = {
                    task: body.task,
                    data: body.data,
                    settings: { ...edgeSettings, ...defaultSettings, ...cleanBodySettings },
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

            const env = (c.env && Object.keys(c.env).length > 0 ? c.env : process.env) as Record<string, any>;
            const edgeSettings = {
                geminiApiKey: env.GEMINI_API_KEY,
                groqApiKey: env.GROQ_API_KEY,
                openRouterApiKey: env.OPENROUTER_API_KEY,
                mistralApiKey: env.MISTRAL_API_KEY,
                githubToken: env.GITHUB_TOKEN,
                qdrantUrl: env.QDRANT_URL,
                qdrantApiKey: env.QDRANT_API_KEY
            };

            const cleanBodySettings = Object.fromEntries(
                Object.entries(body.settings || {}).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
            );

            const result = await executeSwarmWorkflow({
                task: body.task,
                data: body.data,
                settings: { ...edgeSettings, ...defaultSettings, ...cleanBodySettings },
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

    app.get('/api/swarm/models', async (c) => {
        try {
            const provider = c.req.query('provider');
            if (!provider) {
                return c.json({ error: 'Missing required query parameter: provider' }, 400);
            }

            const env = (c.env && Object.keys(c.env).length > 0 ? c.env : process.env) as Record<string, any>;
            
            switch (provider.toLowerCase()) {
                case 'simulated': {
                    return c.json([
                        { id: 'simulated-swarm-v1', name: 'Simulated Swarm Model', free: true }
                    ]);
                }
                case 'openrouter': {
                    const res = await fetch('https://openrouter.ai/api/v1/models');
                    if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
                    const data = await res.json();
                    return c.json((data.data || []).map((m: any) => ({
                        id: m.id,
                        name: m.name || m.id,
                        context_length: m.context_length,
                        free: m.pricing?.prompt === "0" && m.pricing?.completion === "0"
                    })));
                }
                case 'groq': {
                    const apiKey = env.GROQ_API_KEY;
                    if (!apiKey) throw new Error('GROQ_API_KEY is not configured on the server');
                    const res = await fetch('https://api.groq.com/openai/v1/models', {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    if (!res.ok) throw new Error('Failed to fetch Groq models');
                    const data = await res.json();
                    return c.json((data.data || []).map((m: any) => ({
                        id: m.id,
                        name: m.id,
                        free: true
                    })));
                }
                case 'gemini': {
                    const apiKey = env.GEMINI_API_KEY;
                    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server');
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
                    if (!res.ok) throw new Error('Failed to fetch Gemini models');
                    const data = await res.json();
                    const models = (data.models || [])
                        .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                        .map((m: any) => ({
                            id: (m.name || '').replace('models/', ''),
                            name: m.displayName || m.name,
                            free: true
                        }));
                    return c.json(models);
                }
                case 'mistral': {
                    const apiKey = env.MISTRAL_API_KEY;
                    if (!apiKey) throw new Error('MISTRAL_API_KEY is not configured on the server');
                    const res = await fetch('https://api.mistral.ai/v1/models', {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    if (!res.ok) throw new Error('Failed to fetch Mistral models');
                    const data = await res.json();
                    return c.json((data.data || []).map((m: any) => ({
                        id: m.id,
                        name: m.id,
                        free: typeof m.id === 'string' && (m.id.includes('free') || m.id.includes('open'))
                    })));
                }
                case 'github': {
                    const apiKey = env.GITHUB_TOKEN;
                    if (!apiKey) throw new Error('GITHUB_TOKEN is not configured on the server');
                    const res = await fetch('https://models.inference.ai.azure.com/models', {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    if (!res.ok) throw new Error('Failed to fetch GitHub models');
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (data.data || []);
                    return c.json(list.map((m: any) => ({
                        id: m.name,
                        name: m.friendly_name || m.name,
                        free: true
                    })));
                }
                default:
                    return c.json([]);
            }
        } catch (err: any) {
            console.error(`[SwarmServer Models Error]:`, err);
            return c.json({ error: err.message || 'Internal Server Error' }, 500);
        }
    });

    return app;
}
