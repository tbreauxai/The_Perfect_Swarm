import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSwarmServer } from './app.ts';
import { _resetFeedbackDedupe, hashString, setFeedbackInFlight, markFeedbackProcessed, removeFeedbackInFlight, isFeedbackProcessed, isFeedbackInFlight } from './feedbackDedupe.ts';

describe('Swarm Server - Feedback Deduplication', () => {
    let app: any;

    beforeEach(() => {
        _resetFeedbackDedupe();

        // Setup an app with callerAppId injected for testing
        const baseApp = createSwarmServer({
            defaultSettings: { appId: 'test-app' }
        });

        app = new Hono();
        app.use('*', async (c: any, next: any) => {
            c.set('callerAppId', 'test-app');
            await next();
        });
        app.route('/', baseApp);
    });

    it('concurrent duplicate -> 409', async () => {
        const payload = {
            workflowId: 'wf-1',
            outcome: 'win',
            pickId: 'pick-1'
        };

        setFeedbackInFlight('test-app:wf-1:pick-1');

        const req = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toContain('Conflict');

        removeFeedbackInFlight('test-app:wf-1:pick-1');
    });

    it('success then repeat -> duplicate:true', async () => {
        const payload = {
            workflowId: 'wf-2',
            outcome: 'loss',
            pickId: 'pick-2'
        };

        markFeedbackProcessed('test-app:wf-2:pick-2');

        const req = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.duplicate).toBe(true);
    });

    it('failed grade then retry -> processed', async () => {
        const payload = {
            workflowId: 'wf-3',
            outcome: 'invalid_outcome_so_it_fails_fast',
            pickId: 'pick-3'
        };

        const req = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(400);

        expect(await isFeedbackProcessed('test-app:wf-3:pick-3')).toBe(false);
        expect(isFeedbackInFlight('test-app:wf-3:pick-3')).toBe(false); // Cleaned up
    });

    it('missing pickId deduped by hash', async () => {
        const payload = {
            workflowId: 'wf-4',
            outcome: 'win',
            pickName: 'Team A',
            sportKey: 'basketball',
            market: 'moneyline'
        };

        const hashData = JSON.stringify({
            pickName: payload.pickName,
            sportKey: payload.sportKey,
            market: payload.market,
            predictedProbability: undefined
        });
        const expectedHash = hashString(hashData);
        const expectedKey = `test-app:wf-4:win:${expectedHash}`;

        markFeedbackProcessed(expectedKey);

        const req = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.duplicate).toBe(true);
    });

    it('workflowId round-trip test', async () => {
        const { vi } = await import('vitest');
        const engine = await import('../engine/index.ts');

        // Mock executeSwarmWorkflow to return a fake workflowId instead of generating one in app.ts
        const fakeWorkflowId = 'test-workflow-123';
        const spy = vi.spyOn(engine, 'executeSwarmWorkflow').mockResolvedValue({
            title: 'Test',
            componentsCount: 0,
            workflowId: fakeWorkflowId
        });

        const analyzePayload = {
            task: "Should we buy or sell AAPL today?",
            sportKey: "nba",
            market: "moneyline",
            bypassCache: true
        };
        const reqAnalyze = new Request('http://localhost/api/swarm/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(analyzePayload)
        });

        const resAnalyze = await app.fetch(reqAnalyze);
        expect(resAnalyze.status).toBe(200);

        const analyzeData = await resAnalyze.json();
        const returnedWorkflowId = analyzeData.workflowId;
        expect(returnedWorkflowId).toBe(fakeWorkflowId);

        // Should be found and not return 404
        const feedbackPayload = {
            workflowId: returnedWorkflowId,
            outcome: 'win',
            pickId: 'pick-rt'
        };

        const reqFeedback = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(feedbackPayload)
        });

        const resFeedback = await app.fetch(reqFeedback);
        expect(resFeedback.status).not.toBe(404);

        spy.mockRestore();
    });
});
