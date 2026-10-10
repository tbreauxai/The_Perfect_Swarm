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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://the-perfect-swarm.onrender.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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

    describe('Static Routing and Soft-200 Prevention', () => {
        const staticApp = createMainApp({
            defaultAi: { apiKey: 'mock-test-key' } as any,
            serveStatic: true
        });

        it('serves /robots.txt as text/plain', async () => {
            const res = await staticApp.request('/robots.txt');
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/plain');
            const body = await res.text();
            expect(body).toContain('User-agent: *');
            expect(body).toContain('Allow: /');
        });

        it('serves SPA shell for / and /index.html on GET', async () => {
            const resRoot = await staticApp.request('/');
            expect(resRoot.status).toBe(200);
            expect(resRoot.headers.get('content-type')).toContain('text/html');

            const resIndex = await staticApp.request('/index.html');
            expect(resIndex.status).toBe(200);
            expect(resIndex.headers.get('content-type')).toContain('text/html');
        });

        it('supports HEAD on /', async () => {
            const res = await staticApp.request('/', { method: 'HEAD' });
            expect(res.status).toBe(200);
        });

        it('returns 404 HTML for unmatched non-API routes (prevents soft-200)', async () => {
            const res = await staticApp.request('/nope');
            expect(res.status).toBe(404);
            expect(res.headers.get('content-type')).toContain('text/html');
            const body = await res.text();
            expect(body).toContain('404 Not Found');
        });

        it('rejects POST / with 404/405', async () => {
            const res = await staticApp.request('/', { method: 'POST' });
            expect([404, 405]).toContain(res.status);
        });
    });
});
