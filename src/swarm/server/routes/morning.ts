import type { Hono } from 'hono';
import {
    runMorningSlate,
    tryAcquireMorningLock,
    releaseMorningLock,
    morningClaims
} from '../../morning/index.ts';
import type { ServerRouteContext } from './types.ts';
import { resolveEnvironment, handleServerError } from './helpers.ts';

export function registerMorningRoutes(app: Hono, _ctx: ServerRouteContext): void {
    app.post('/api/swarm/morning', async (c) => {
        // R3-S1: single-flight. A second call while a run is in flight returns 202 and does no work.
        if (!tryAcquireMorningLock()) {
            return c.json({ status: 'already_running' }, 202);
        }
        try {
            const body = await c.req.json().catch(() => ({}));
            const env = resolveEnvironment(c);
            const result = await runMorningSlate({
                dateInput: body?.date,
                env,
                claims: morningClaims
            });
            return c.json(result, 200);
        } catch (err: any) {
            return handleServerError('Morning Slate', err, c);
        } finally {
            releaseMorningLock();
        }
    });
}
