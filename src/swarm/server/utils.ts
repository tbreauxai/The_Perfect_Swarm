/**
 * Parses JSON body from an incoming request stream or Hono context.
 */
export async function parseJsonBody<T = any>(req: any): Promise<T> {
    if (req?.json && typeof req.json === 'function') {
        return req.json().catch(() => ({}));
    }
    if (req?.req?.json && typeof req.req.json === 'function') {
        return req.req.json().catch(() => ({}));
    }
    if (typeof req?.on === 'function') {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk: any) => { body += chunk; });
            req.on('end', () => {
                try { resolve(body ? JSON.parse(body) : ({} as T)); } catch (e) { reject(e); }
            });
            req.on('error', reject);
        });
    }
    return {} as T;
}
