import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryCortex } from './memory/cortex.ts';
import { createSwarmServer } from './server/app.ts';
import { createAppAuthMiddleware } from './server/appAuth.ts';
import { Hono } from 'hono';
import { globalFeedbackEngine } from './feedback.ts';

describe('Fix 5 Learning Loop: Point Grading, Score Retrieval & Diagnostics', () => {
    let cortex: MemoryCortex;
    let server: any;
    let baseUrl: string;
    const oldTokens = process.env.SWARM_APP_TOKENS;

    beforeEach(async () => {
        process.env.SWARM_APP_TOKENS = 'perfect-swarm:ps-token-123,duelodds:do-token-456';

        cortex = new MemoryCortex({
            defaultAppId: 'perfect-swarm'
        });

        const swarmApp = createSwarmServer({
            defaultCortex: cortex,
            defaultSettings: { appId: 'perfect-swarm' }
        });

        const mainApp = new Hono();
        mainApp.use('*', createAppAuthMiddleware());
        mainApp.route('/', swarmApp);

        const nodeServer = swarmApp.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => {
            if (nodeServer.listening) resolve();
            else nodeServer.on('listening', () => resolve());
        });
        const addr = nodeServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 3000;
        baseUrl = `http://127.0.0.1:${port}`;
        server = nodeServer;
    });

    afterEach(async () => {
        if (server) {
            server.close();
        }
        if (oldTokens !== undefined) {
            process.env.SWARM_APP_TOKENS = oldTokens;
        } else {
            delete process.env.SWARM_APP_TOKENS;
        }
    });

    it('grades a known workflowId when in-memory repository is empty, sets fact and outcome score', async () => {
        const workflowId = `wf-win-${Date.now()}`;
        
        // 1. Store a judgment with workflowId into cortex
        await cortex.store(
            'Wager on Yankees ML at -130 vs Tampa Bay Rays',
            {
                workflowId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['yankees', 'rays']
            },
            false
        );

        // Verify in-memory feedback repository has NO record for this workflowId (simulating restart)
        const inMemoryRecords = globalFeedbackEngine.getKnowledgeRepository().queryOutcomes().filter((o: any) => o.workflowId === workflowId);
        expect(inMemoryRecords).toHaveLength(0);

        // 2. Submit feedback outcome 'win' via HTTP with perfect-swarm auth token
        const res = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ps-token-123'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'win',
                gradedAt: new Date().toISOString()
            })
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.accuracyScore).toBe(1.0);

        // 3. Verify the point in Cortex became a fact with qualityRating 1.0 and graded metadata
        const points = (cortex as any).fallbackStore;
        const gradedPoint = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(gradedPoint).toBeDefined();
        expect(gradedPoint.payload.memoryType).toBe('fact');
        expect(gradedPoint.payload.qualityRating).toBe(1.0);
        expect(gradedPoint.payload.outcome).toBe('win');
        expect(gradedPoint.payload.feedbackProcessed).toBe(true);
        expect(gradedPoint.payload.gradedAt).toBeDefined();
    });

    it('ranks a graded win above a graded loss and above placeholder judgments for the same entity and domain', async () => {
        const winWfId = `wf-win-${Date.now()}`;
        const lossWfId = `wf-loss-${Date.now()}`;
        const ungradedWfId = `wf-ungraded-${Date.now()}`;

        // Store three points for Dodgers
        await cortex.store(
            'Bet Dodgers ML against San Francisco Giants',
            {
                workflowId: winWfId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['dodgers', 'giants']
            },
            false
        );

        await cortex.store(
            'Bet Dodgers RL -1.5 against San Francisco Giants',
            {
                workflowId: lossWfId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['dodgers', 'giants']
            },
            false
        );

        await cortex.store(
            'Bet Dodgers over 8.5 against San Francisco Giants',
            {
                workflowId: ungradedWfId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['dodgers', 'giants']
            },
            false
        );

        // Grade winWfId as 'win' (1.0)
        await cortex.gradeMemoryByWorkflowId({
            workflowId: winWfId,
            originApp: 'perfect-swarm',
            outcome: 'win'
        });

        // Grade lossWfId as 'loss' (0.0)
        await cortex.gradeMemoryByWorkflowId({
            workflowId: lossWfId,
            originApp: 'perfect-swarm',
            outcome: 'loss'
        });

        // Retrieve memories for Dodgers
        const retrieved = await cortex.retrieve(
            'Evaluate Dodgers Giants matchup odds',
            {
                domain: 'odds',
                entityIds: ['dodgers'],
                originApp: 'perfect-swarm',
                appId: 'perfect-swarm',
                limit: 10
            }
        );

        expect(retrieved.length).toBeGreaterThanOrEqual(3);

        const winIndex = retrieved.findIndex((m: any) => m.workflowId === winWfId || m.metadata?.workflowId === winWfId);
        const lossIndex = retrieved.findIndex((m: any) => m.workflowId === lossWfId || m.metadata?.workflowId === lossWfId);

        // Win (fact, qualityRating 1.0) must rank above loss (fact, qualityRating 0.0)
        expect(winIndex).toBeGreaterThanOrEqual(0);
        expect(lossIndex).toBeGreaterThanOrEqual(0);
        expect(winIndex).toBeLessThan(lossIndex);

        // Facts (win) outrank placeholder judgments
        const firstPoint = retrieved[0];
        const firstWf = firstPoint.workflowId || firstPoint.metadata?.workflowId;
        expect(firstWf).toBe(winWfId);
    });

    it('ensures a second grade for the same workflowId is an idempotent no-op', async () => {
        const workflowId = `wf-idempotent-${Date.now()}`;

        await cortex.store(
            'Pick Kansas City Chiefs -3 vs Raiders',
            {
                workflowId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['chiefs']
            },
            false
        );

        // First grade: win
        const res1 = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ps-token-123'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'win'
            })
        });
        expect(res1.status).toBe(200);
        const data1 = await res1.json();
        expect(data1.ok).toBe(true);

        // Verify qualityRating is 1.0
        const points = (cortex as any).fallbackStore;
        const p1 = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(p1.payload.qualityRating).toBe(1.0);

        // Second grade with different outcome: should be no-op
        const res2 = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ps-token-123'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'loss'
            })
        });
        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.ok).toBe(true);
        expect(data2.alreadyProcessed).toBe(true);

        // Score must NOT have been changed to 0.0
        const p2 = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(p2.payload.qualityRating).toBe(1.0);
        expect(p2.payload.outcome).toBe('win');
    });

    it('verifies a duelodds token cannot grade a perfect-swarm workflowId (returns 404)', async () => {
        const workflowId = `wf-ps-exclusive-${Date.now()}`;

        // Stored under originApp: 'perfect-swarm'
        await cortex.store(
            'Boston Celtics ML exclusive analysis',
            {
                workflowId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['celtics']
            },
            false
        );

        // Attempt grading using duelodds bearer token
        const res = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer do-token-456'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'win'
            })
        });

        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toBe('Workflow not found');

        // Confirm the point was untouched
        const points = (cortex as any).fallbackStore;
        const point = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(point.payload.feedbackProcessed).toBeUndefined();
        expect(point.payload.memoryType).toBe('judgment');
    });

    it('tracks diagnostics for graded points separately and computes headline accuracy', async () => {
        const freshCortex = new MemoryCortex({ defaultAppId: 'diagnostics-test' });

        // Initially with 0 graded: headlineAccuracy should be null (not 0.85)
        await freshCortex.store(
            'Ungraded task 1 content',
            { domain: 'general', memoryType: 'judgment', qualityRating: 0.85 },
            false
        );

        const diag0 = await freshCortex.getDiagnostics('diagnostics-test');
        expect(diag0.gradedCount).toBe(0);
        expect(diag0.ungradedCount).toBe(1);
        expect(diag0.headlineAccuracy).toBeNull();

        // Now store two points and grade 1 win and 1 loss
        const wfWin = `wf-diag-win-${Date.now()}`;
        const wfLoss = `wf-diag-loss-${Date.now()}`;

        await freshCortex.store(
            'Graded win task content',
            { workflowId: wfWin, domain: 'general', memoryType: 'judgment' },
            false
        );
        await freshCortex.store(
            'Graded loss task content',
            { workflowId: wfLoss, domain: 'general', memoryType: 'judgment' },
            false
        );

        await freshCortex.gradeMemoryByWorkflowId({
            workflowId: wfWin,
            originApp: 'diagnostics-test',
            outcome: 'win'
        });
        await freshCortex.gradeMemoryByWorkflowId({
            workflowId: wfLoss,
            originApp: 'diagnostics-test',
            outcome: 'loss'
        });

        const diag1 = await freshCortex.getDiagnostics('diagnostics-test');
        expect(diag1.gradedCount).toBe(2);
        expect(diag1.gradedWins).toBe(1);
        expect(diag1.gradedLosses).toBe(1);
        expect(diag1.gradedPushes).toBe(0);
        // Headline accuracy = 1 / 2 = 0.50
        expect(diag1.headlineAccuracy).toBe(0.5);
    });

    it('ensures other app token gets 404 for that same workflowId, and the point outcome is unchanged', async () => {
        const workflowId = `wf-cross-app-unchanged-${Date.now()}`;

        // Point owned by duelodds with outcome: loss (e.g. live scenario wf-1791224875232)
        await cortex.store(
            'Guardians ML at -154 vs Royals analysis',
            {
                workflowId,
                originApp: 'duelodds',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85,
                entityIds: ['guardians']
            },
            false
        );

        // Grade as loss by owning app
        await cortex.gradeMemoryByWorkflowId({
            workflowId,
            originApp: 'duelodds',
            outcome: 'loss'
        });

        const points = (cortex as any).fallbackStore;
        const initialPoint = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(initialPoint.payload.outcome).toBe('loss');
        expect(initialPoint.payload.qualityRating).toBe(0.0);

        // Attempt grading as win by perfect-swarm token
        const res = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ps-token-123'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'win'
            })
        });

        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toBe('Workflow not found');

        // Confirm point outcome remains loss (0.0) and was NOT overwritten by win
        const pointAfter = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(pointAfter.payload.outcome).toBe('loss');
        expect(pointAfter.payload.qualityRating).toBe(0.0);
    });

    it('records an authenticated grade when the workflow is gone, without touching another app', async () => {
        const workflowId = `wf-nonexistent-${Date.now()}`;
        const res = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ps-token-123'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'win',
                predictedProbability: 0.62
            })
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.recordedWithoutWorkflow).toBe(true);
        expect(data.workflowId).toBe(workflowId);
    });

    it('ignores body.appId and prevents redirecting the grade', async () => {
        const workflowId = `wf-redirect-attempt-${Date.now()}`;

        // Point owned by perfect-swarm
        await cortex.store(
            'Lakers spread analysis',
            {
                workflowId,
                originApp: 'perfect-swarm',
                domain: 'odds',
                memoryType: 'judgment',
                qualityRating: 0.85
            },
            false
        );

        // Caller is duelodds, but body passes appId: 'perfect-swarm' attempting to redirect
        const res = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer do-token-456'
            },
            body: JSON.stringify({
                workflowId,
                outcome: 'win',
                appId: 'perfect-swarm'
            })
        });

        // Must ignore body.appId, treat caller as duelodds, and return 404
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toBe('Workflow not found');

        // Verify point was NOT graded
        const points = (cortex as any).fallbackStore;
        const pt = points.find((p: any) => p.payload?.workflowId === workflowId);
        expect(pt.payload.feedbackProcessed).toBeUndefined();
        expect(pt.payload.outcome).toBeUndefined();
    });

    it('returns 401 when Authorization header is missing', async () => {
        const res = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                workflowId: 'wf-any',
                outcome: 'win'
            })
        });

        expect(res.status).toBe(401);
    });
});
