/**
 * Per-app caller tokens. The token identifies who is calling.
 * It does not restrict which app namespace a caller may read.
 */
export type AppCaller = { appId: string };

export function parseAppTokens(raw: string | undefined | null): Map<string, string> {
    const tokens = new Map<string, string>();
    if (!raw || !raw.trim()) return tokens;
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            for (const [appId, token] of Object.entries(parsed)) {
                if (typeof token === 'string' && token && appId) tokens.set(appId, token);
            }
            return tokens;
        } catch {
            return tokens;
        }
    }
    for (const part of trimmed.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const splitAt = piece.indexOf(':');
        if (splitAt <= 0) continue;
        const appId = piece.slice(0, splitAt).trim();
        const token = piece.slice(splitAt + 1).trim();
        if (appId && token) tokens.set(appId, token);
    }
    return tokens;
}

export function tokensEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const left = enc.encode(a);
    const right = enc.encode(b);
    const len = Math.max(left.length, right.length);
    let diff = left.length ^ right.length;
    for (let i = 0; i < len; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
    return diff === 0;
}

export function resolveCaller(authorization: string | undefined, tokens: Map<string, string>): AppCaller | null {
    if (!authorization || tokens.size === 0) return null;
    const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
    if (!match) return null;
    const presented = match[1];
    for (const [appId, expected] of tokens) {
        if (tokensEqual(presented, expected)) return { appId };
    }
    return null;
}

export function readAuthEnv(env: Record<string, any> | undefined): { tokens: Map<string, string>; required: boolean } {
    const source = env || {};
    const tokens = parseAppTokens(source.SWARM_APP_TOKENS);
    const required = source.SWARM_AUTH_REQUIRED === 'true' || tokens.size > 0;
    return { tokens, required };
}

export function createAppAuthMiddleware() {
    return async (c: any, next: any) => {
        if (c.get && c.get('callerAppId')) return next();
        const path = c.req.path || '/';
        // Only API routes are authenticated. The dashboard HTML must load
        // before the browser can attach the token from localStorage.
        if (c.req.method === 'OPTIONS' || path === '/api/health' || !path.startsWith('/api/')) return next();
        const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, c.env || {});
        const { tokens, required } = readAuthEnv(env);
        if (!required) return next();
        if (tokens.size === 0) {
            return c.json({ error: 'Swarm auth is required but SWARM_APP_TOKENS is not configured' }, 503);
        }
        const caller = resolveCaller(c.req.header('authorization') || c.req.header('Authorization'), tokens);
        if (!caller) return c.json({ error: 'Unauthorized' }, 401);
        c.set('callerAppId', caller.appId);
        await next();
    };
}
