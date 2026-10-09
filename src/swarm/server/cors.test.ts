import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMainApp } from '../../../server.ts';
import { createSwarmServer } from './app.ts';

describe('Swarm Feedback CORS Before Auth & Deduplication', () => {
    let oldTokens: string | undefined;
    let oldRequired: string | undefined;

    beforeEach(() => {
        oldTokens = process.env.SWARM_APP_TOKENS;
        oldRequired = process.env.SWARM_AUTH_REQUIRED;
        process.env.SWARM_APP_TOKENS = 'duelodds:valid-token-123';
        process.env.SWARM_AUTH_REQUIRED = 'true';
    });

    afterEach(() => {
        if (oldTokens !== undefined) process.env.SWARM_APP_TOKENS = oldTokens;
        else delete process.env.SWARM_APP_TOKENS;

        if (oldRequired !== undefined) process.env.SWARM_AUTH_REQUIRED = oldRequired;
        else delete process.env.SWARM_AUTH_REQUIRED;
    });

    it('returns 401 WITH Access-Control-Allow-Origin when allowed origin sends POST with no token', async () => {
        const app = createMainApp({
            defaultAi: { apiKey: 'mock-key' }
        });

        const res = await app.request('/api/swarm/feedback', {
            method: 'POST',
            headers: {
                'Origin': 'https://duelodds.pages.dev',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ workflowId: 'wf-cors-test', outcome: 'win' })
        });

        expect(res.status).toBe(401);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://duelodds.pages.dev');
        expect(res.headers.get('vary')).toBe('Origin');
        const data = await res.json();
        expect(data).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 WITHOUT Access-Control-Allow-Origin when disallowed origin sends POST with no token', async () => {
        const app = createMainApp({
            defaultAi: { apiKey: 'mock-key' }
        });

        const res = await app.request('/api/swarm/feedback', {
            method: 'POST',
            headers: {
                'Origin': 'https://evil.example',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ workflowId: 'wf-cors-test', outcome: 'win' })
        });

        expect(res.status).toBe(401);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('returns 204 on OPTIONS preflight from allowed origin', async () => {
        const app = createMainApp({
            defaultAi: { apiKey: 'mock-key' }
        });

        const res = await app.request('/api/swarm/feedback', {
            method: 'OPTIONS',
            headers: {
                'Origin': 'https://duelodds.pages.dev'
            }
        });

        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://duelodds.pages.dev');
        expect(res.headers.get('vary')).toBe('Origin');
        expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    });

    it('returns 403 on OPTIONS preflight from disallowed origin', async () => {
        const app = createMainApp({
            defaultAi: { apiKey: 'mock-key' }
        });

        const res = await app.request('/api/swarm/feedback', {
            method: 'OPTIONS',
            headers: {
                'Origin': 'https://evil.example'
            }
        });

        expect(res.status).toBe(403);
    });

    it('deduplicates (callerAppId, workflowId, pickId) feedback submissions and returns 200 { duplicate: true }', async () => {
        const server = createSwarmServer({
            defaultAi: { apiKey: 'mock-key' }
        });

        const submission = {
            workflowId: 'wf-dedup-' + Date.now(),
            pickId: 'pick-42',
            outcome: 'win'
        };

        const res1 = await server.request('/api/swarm/feedback', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer valid-token-123',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(submission)
        });

        expect(res1.status).toBe(200);
        const data1 = await res1.json();
        expect(data1.ok).toBe(true);

        // Immediate duplicate submission with the same pickId
        const res2 = await server.request('/api/swarm/feedback', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer valid-token-123',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(submission)
        });

        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.duplicate).toBe(true);
    });
});
