import { describe, it, expect } from 'vitest';
import { createMainApp } from '../server.ts';

describe('Production / Staging Server Wrapper App', () => {
    const app = createMainApp({
        defaultAi: {
            apiKey: 'mock-test-key'
        }
    });

    it('returns JSON 404 for unknown /api/* routes, not HTML', async () => {
        const res = await app.request('/api/does-not-exist');
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json();
        expect(body).toEqual({ error: 'Not found' });
    });

    it('attaches security headers to every response', async () => {
        const res = await app.request('/api/config/status');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-security-policy')).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://the-perfect-swarm.onrender.com https://duelodds.pages.dev; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        );
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('routes known /api/config/status successfully', async () => {
        const res = await app.request('/api/config/status');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('hasGeminiKey');
    });

    it('routes known /api/health with no token required', async () => {
        const res = await app.request('/api/health');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ status: 'ok', edge: true });
    });

    it('blocks disallowed origin on preflight with 403', async () => {
        const res = await app.request('/api/swarm/stream', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://evil.example'
            }
        });
        expect(res.status).toBe(403);
    });

    it('echoes allowed origin https://duelodds.pages.dev with Vary: Origin', async () => {
        const res = await app.request('/api/swarm/stream', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://duelodds.pages.dev'
            }
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://duelodds.pages.dev');
        expect(res.headers.get('vary')).toBe('Origin');
    });
});
