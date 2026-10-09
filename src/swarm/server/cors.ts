import type { MiddlewareHandler } from 'hono';

export const DEFAULT_ALLOWED_ORIGINS = [
    'https://the-perfect-swarm.onrender.com',
    'https://duelodds.pages.dev',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
];

export const getAllowedOrigins = (allowedOriginsStr?: string): Set<string> => {
    const origins = new Set<string>(DEFAULT_ALLOWED_ORIGINS);
    if (allowedOriginsStr) {
        for (const item of allowedOriginsStr.split(',')) {
            const trimmed = item.trim();
            if (trimmed && trimmed !== '*') {
                origins.add(trimmed);
            }
        }
    }
    return origins;
};

export function createCorsMiddleware(): MiddlewareHandler {
    return async (c, next) => {
        // Skip if CORS was already applied by an outer middleware to avoid duplicate headers
        if ((c as any).get('corsApplied')) {
            return next();
        }

        const env = Object.assign({}, typeof process !== 'undefined' ? process.env : {}, (c.env as Record<string, any>) || {}) as Record<string, any>;
        const allowedOrigins = getAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
        const reqOrigin = c.req.header('origin') || c.req.header('Origin');
        const isOriginAllowed = reqOrigin ? allowedOrigins.has(reqOrigin) : false;

        if (c.req.method === 'OPTIONS') {
            if (reqOrigin && !isOriginAllowed) {
                return c.text('Forbidden: Origin not allowed', 403);
            }
            if (isOriginAllowed) {
                c.header('Access-Control-Allow-Origin', reqOrigin!);
                c.header('Vary', 'Origin');
            }
            c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            (c as any).set('corsApplied', true);
            return c.body(null, 204);
        }

        if (isOriginAllowed) {
            c.header('Access-Control-Allow-Origin', reqOrigin!);
            c.header('Vary', 'Origin');
            c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }

        (c as any).set('corsApplied', true);
        await next();
    };
}
