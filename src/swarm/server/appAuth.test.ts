import { describe, expect, it } from 'vitest';
import { parseAppTokens, resolveCaller, tokensEqual } from './appAuth.ts';

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
