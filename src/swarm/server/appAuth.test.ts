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
    it('lets the dashboard load and still blocks API routes', async () => {
        const previous = process.env.SWARM_APP_TOKENS;
        process.env.SWARM_APP_TOKENS = 'perfect-swarm:secret';
        const middleware = createAppAuthMiddleware();
        const calls: string[] = [];
        const run = async (path: string, authorization?: string) => {
            const c: any = {
                req: { method: 'GET', path, header: (name: string) => authorization },
                env: {},
                json: (body: unknown, status: number) => ({ body, status }),
                set: () => undefined
            };
            let nextCalled = false;
            const result = await middleware(c, async () => { nextCalled = true; });
            calls.push(path + ':' + String(nextCalled));
            return { nextCalled, result };
        };
        expect((await run('/')).nextCalled).toBe(true);
        expect((await run('/assets/index.js')).nextCalled).toBe(true);
        expect((await run('/api/health')).nextCalled).toBe(true);
        expect((await run('/api/swarm/metrics')).nextCalled).toBe(false);
        expect((await run('/api/swarm/metrics', 'Bearer secret')).nextCalled).toBe(true);
        if (previous === undefined) delete process.env.SWARM_APP_TOKENS;
        else process.env.SWARM_APP_TOKENS = previous;
        expect(calls).toContain('/:true');
    });
});
