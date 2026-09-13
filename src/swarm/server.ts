import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
 * Handles Server-Sent Events (SSE) streaming for swarm execution.
 * Compatible with Node.js http, Express, Fastify, and Next.js route handlers.
 */
export async function handleSwarmSse(
    req: IncomingMessage,
    res: ServerResponse,
    params: SwarmWorkflowParams
): Promise<SwarmWorkflowResult> {
    // Set headers for Server-Sent Events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
    });

    // Send initial handshake
    res.write(`:connected\n\n`);

    const sendEvent = (eventType: string, data: any) => {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const result = await executeSwarmWorkflow({
            ...params,
            onEvent: (event: SwarmEvent) => {
                sendEvent('swarm_event', event);
                if (params.onEvent) {
                    params.onEvent(event);
                }
            }
        });

        sendEvent('swarm_complete', result);
        res.end();
        return result;
    } catch (err: any) {
        sendEvent('swarm_error', { error: err.message || String(err) });
        res.end();
        throw err;
    }
}

/**
 * Parses JSON body from an incoming HTTP request stream.
 */
export function parseJsonBody<T = any>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 25 * 1024 * 1024) { // 25MB max
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : ({} as T));
            } catch (e: any) {
                reject(new Error(`Invalid JSON: ${e.message}`));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Creates a standalone, zero-external-dependency HTTP & SSE server for headless swarm deployments.
 */
export function createSwarmServer(options: SwarmServerOptions = {}): http.Server {
    const defaultSettings = options.defaultSettings || {};
    const defaultAi = options.defaultAi;
    const defaultCortex = options.defaultCortex;

    const server = http.createServer(async (req, res) => {
        // CORS headers
        if (options.cors !== false) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        try {
            // Health ping
            if (pathname === '/api/health' || pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
                return;
            }

            // Stream endpoint (SSE)
            if (pathname === '/api/swarm/stream') {
                let params: SwarmWorkflowParams;

                if (req.method === 'POST') {
                    const body = await parseJsonBody(req);
                    params = {
                        task: body.task,
                        data: body.data,
                        settings: { ...defaultSettings, ...body.settings },
                        defaultAi: body.defaultAi || defaultAi,
                        cortex: body.cortex || defaultCortex,
                        enableDeepAnalysis: body.enableDeepAnalysis,
                        complexityOverride: body.complexityOverride
                    };
                } else if (req.method === 'GET') {
                    const task = url.searchParams.get('task') || '';
                    const data = url.searchParams.get('data') || '';
                    const appId = url.searchParams.get('appId') || defaultSettings.appId || 'default';
                    params = {
                        task,
                        data,
                        settings: { ...defaultSettings, appId },
                        defaultAi,
                        cortex: defaultCortex
                    };
                } else {
                    res.writeHead(405, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
                    return;
                }

                if (!params.task) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required parameter: task' }));
                    return;
                }

                await handleSwarmSse(req, res, params);
                return;
            }

            // Standard JSON Analyze endpoint
            if (pathname === '/api/swarm/analyze' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                if (!body.task) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required parameter: task' }));
                    return;
                }

                const result = await executeSwarmWorkflow({
                    task: body.task,
                    data: body.data,
                    settings: { ...defaultSettings, ...body.settings },
                    defaultAi: body.defaultAi || defaultAi,
                    cortex: body.cortex || defaultCortex,
                    enableDeepAnalysis: body.enableDeepAnalysis,
                    complexityOverride: body.complexityOverride
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }

            // 404 Not Found
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
        } catch (err: any) {
            console.error('[SwarmServer Error]:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
            }
        }
    });

    return server;
}
