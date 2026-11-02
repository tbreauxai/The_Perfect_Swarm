import type { Hono } from 'hono';
import {
    runMorningSlate,
    tryAcquireMorningLock,
    releaseMorningLock,
    morningClaims
} from '../../morning/index.ts';
import type { ServerRouteContext } from './types.ts';
import { resolveEnvironment, handleServerError, resolveAppIds } from './helpers.ts';
import { globalAsyncJobs, wantsAsync, newJobId } from '../asyncJobs.ts';

export function registerMorningRoutes(app: Hono, ctx: ServerRouteContext): void {
    app.post('/api/swarm/morning', async (c) => {
        // R3-S1: single-flight. A second call while a run is in flight returns 202 and does no work.
        if (!tryAcquireMorningLock()) {
            return c.json({ status: 'already_running' }, 202);
        }
        if (wantsAsync(c)) {
            // Async: the lock is held until the background run settles, then released in its finally.
            let workflowId: string;
            try {
                const body = await c.req.json().catch(() => ({}));
                const env = resolveEnvironment(c);
                const { originApp } = resolveAppIds(c, ctx.defaultSettings);
                workflowId = newJobId('morning', Date.now());
                globalAsyncJobs.start(workflowId, originApp, async () => {
                    try {
                        return await runMorningSlate({ dateInput: body?.date, env, claims: morningClaims });
                    } finally {
                        releaseMorningLock();
                    }
                });
            } catch (err: any) {
                releaseMorningLock();
                return handleServerError('Morning Slate', err, c);
            }
            c.header('Preference-Applied', 'respond-async');
            c.header('Location', `/api/swarm/analyze/status/${workflowId}`);
            return c.json({ workflowId, status: 'pending' }, 202);
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
