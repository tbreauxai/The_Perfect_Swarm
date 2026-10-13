import { describe, expect, it } from 'vitest';
import { parseAppTokens, resolveCaller, tokensEqual, createAppAuthMiddleware } from './appAuth.ts';

describe('app auth tokens', () => {
    it('parses comma-separated app tokens', () => {
        const tokens = parseAppTokens('duelodds:secret-one,perfect-swarm:secret-two');
        expect(tokens.get('duelodds')).toBe('secret-one');
        expect(tokens.get('perfect-swarm')).toBe('secret-two');
    });

    it('parses a JSON token map', () => {
        const tokens = parseAppTokens('{"duelodds":"a:b","fantasy":"c"}');
        expect(tokens.get('duelodds')).toBe('a:b');
        expect(tokens.get('fantasy')).toBe('c');
    });

    it('identifies the caller without caring about the requested namespace', () => {
        const tokens = parseAppTokens('duelodds:secret-one,perfect-swarm:secret-two');
        expect(resolveCaller('Bearer secret-one', tokens)).toEqual({ appId: 'duelodds' });
        expect(resolveCaller('Bearer wrong', tokens)).toBeNull();
        expect(resolveCaller(undefined, tokens)).toBeNull();
    });

    it('compares tokens without matching a prefix', () => {
        expect(tokensEqual('secret', 'secret')).toBe(true);
        expect(tokensEqual('secret', 'secret-extra')).toBe(false);
    });
});

describe('app auth middleware scope', () => {
    const runMiddleware = async (middleware: any, path: string, authorization?: string, env?: any) => {
        const c: any = {
            req: { method: 'GET', path, header: (name: string) => authorization },
            env: env || {},
            json: (body: unknown, status: number) => ({ body, status }),
            set: () => undefined
        };
        let nextCalled = false;
        const result = await middleware(c, async () => { nextCalled = true; });
        return { nextCalled, result };
    };

    it('lets the dashboard load and still blocks API routes', async () => {
        const previous = process.env.SWARM_APP_TOKENS;
        process.env.SWARM_APP_TOKENS = 'perfect-swarm:secret';
        process.env.NODE_ENV = 'production';
        const middleware = createAppAuthMiddleware();

        expect((await runMiddleware(middleware, '/')).nextCalled).toBe(true);
        expect((await runMiddleware(middleware, '/assets/index.js')).nextCalled).toBe(true);
        expect((await runMiddleware(middleware, '/api/health')).nextCalled).toBe(true);
        expect((await runMiddleware(middleware, '/api/swarm/metrics')).nextCalled).toBe(false);
        expect((await runMiddleware(middleware, '/api/swarm/metrics', 'Bearer secret')).nextCalled).toBe(true);
        if (previous === undefined) delete process.env.SWARM_APP_TOKENS;
        else process.env.SWARM_APP_TOKENS = previous;
    });

    it('enforces fail-closed rules correctly', async () => {
        const middleware = createAppAuthMiddleware();

        // production + no env -> /api/swarm/analyze 503, /api/health 200
        let res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'production' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'auth not configured' }, status: 503 });

        res = await runMiddleware(middleware, '/api/health', undefined, { NODE_ENV: 'production' });
        expect(res.nextCalled).toBe(true);

        // production + tokens + no header -> 401
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'production', SWARM_APP_TOKENS: 'app:secret' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'Unauthorized' }, status: 401 });

        // production + valid token -> 200 (next called)
        res = await runMiddleware(middleware, '/api/swarm/analyze', 'Bearer secret', { NODE_ENV: 'production', SWARM_APP_TOKENS: 'app:secret' });
        expect(res.nextCalled).toBe(true);

        // production + SWARM_AUTH_DISABLED=true -> still enforced (503 without tokens)
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'production', SWARM_AUTH_DISABLED: 'true' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'auth not configured' }, status: 503 });

        // NODE_ENV=development + SWARM_AUTH_DISABLED=true -> allowed
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'development', SWARM_AUTH_DISABLED: 'true' });
        expect(res.nextCalled).toBe(true);

        // development + no flag + no tokens -> 503
        res = await runMiddleware(middleware, '/api/swarm/analyze', undefined, { NODE_ENV: 'development' });
        expect(res.nextCalled).toBe(false);
        expect(res.result).toEqual({ body: { error: 'auth not configured' }, status: 503 });
    });
});
