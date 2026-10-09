import { describe, it, expect } from 'vitest';
import { parseHttpError } from './httpError';

describe('parseHttpError', () => {
    it('handles 401 app-auth without HTML leak', async () => {
        const res = new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(401);
        expect(err.kind).toBe('app-auth');
        expect(err.message).toBe('App token required or invalid — configure token in Settings');
    });

    it('handles 401 with custom error message', async () => {
        const res = new Response(JSON.stringify({ error: 'Custom app token expired' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(401);
        expect(err.kind).toBe('app-auth');
        expect(err.message).toBe('Custom app token expired');
    });

    it('handles 403 with HTML body as firewall blocked', async () => {
        const html = '<!DOCTYPE html><html><body><h1>403 Forbidden: WAF Blocked</h1></body></html>';
        const res = new Response(html, {
            status: 403,
            headers: { 'Content-Type': 'text/html' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(403);
        expect(err.kind).toBe('blocked');
        expect(err.message).toBe('Request blocked by firewall — remove semicolon or SQL-like text (e.g. "; drop table") and retry');
        expect(err.message).not.toContain('<');
    });

    it('handles 403 without HTML and custom JSON error', async () => {
        const res = new Response(JSON.stringify({ error: 'Forbidden resource' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(403);
        expect(err.kind).toBe('forbidden');
        expect(err.message).toBe('Forbidden resource');
    });

    it('handles 413 payload too large', async () => {
        const res = new Response(JSON.stringify({ error: 'Request entity too large' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(413);
        expect(err.kind).toBe('too-large');
        expect(err.message).toBe('Request entity too large');
    });

    it('handles 413 without body', async () => {
        const res = new Response('', { status: 413 });
        const err = await parseHttpError(res);
        expect(err.status).toBe(413);
        expect(err.kind).toBe('too-large');
        expect(err.message).toBe('Payload too large — reduce input size and retry');
    });

    it('handles 429 rate limit', async () => {
        const res = new Response(JSON.stringify({ error: 'Rate limit hit' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(429);
        expect(err.kind).toBe('rate-limit');
        expect(err.message).toBe('Rate limit hit');
    });

    it('handles 500 server error with HTML body and never leaks HTML', async () => {
        const res = new Response('<html><body>500 Internal Server Error</body></html>', {
            status: 500,
            headers: { 'Content-Type': 'text/html' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(500);
        expect(err.kind).toBe('server');
        expect(err.message).toBe('Server error (HTTP 500)');
        expect(err.message).not.toContain('html');
    });

    it('handles 502 with JSON error message', async () => {
        const res = new Response(JSON.stringify({ error: 'Bad Gateway from upstream' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(502);
        expect(err.kind).toBe('server');
        expect(err.message).toBe('Bad Gateway from upstream');
    });

    it('handles 404 client error with HTTP <status> fallback', async () => {
        const res = new Response('Page not found in plain text without json', {
            status: 404
        });
        const err = await parseHttpError(res);
        expect(err.status).toBe(404);
        expect(err.kind).toBe('client');
        expect(err.message).toBe('HTTP 404');
    });

    it('handles hanging body stream by timing out gracefully', async () => {
        const hangingStream = new ReadableStream({
            start() {
                // Never push data or close
            }
        });
        const res = new Response(hangingStream, { status: 401 });
        const start = Date.now();
        const err = await parseHttpError(res, 50); // 50ms timeout for test
        expect(Date.now() - start).toBeLessThan(1000);
        expect(err.status).toBe(401);
        expect(err.kind).toBe('app-auth');
    });
});
