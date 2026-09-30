import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSwarmServer } from './server.ts';
import { globalFeedbackEngine } from './feedback.ts';

describe('Swarm Server & Feedback Attribution', () => {
    let server: any;
    let baseUrl: string;

    beforeEach(async () => {
        server = createSwarmServer({
            cors: true,
            defaultSettings: {
                appId: 'test-app',
                agents: [
                    { id: 'a1', role: 'Quant Specialist', provider: 'simulated' }
                ]
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        if (server) {
            server.close();
        }
    });

    it('returns health status on GET /api/health', async () => {
        const res = await fetch(`${baseUrl}/api/health`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('ok');
        expect(data.edge).toBe(true);
    });

    it('rejects feedback request with missing parameters', async () => {
        const res1 = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(res1.status).toBe(400);

        const res2 = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId: 'wf-1' })
        });
        expect(res2.status).toBe(400);

        const res3 = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId: 'non-existent-wf', outcome: 'win' })
        });
        expect(res3.status).toBe(404);
    });

    it('records win/loss in analystLedger using real agentRoles instead of fake pipeline nodes', async () => {
        const workflowId = `wf-real-role-${Date.now()}`;
        const realRoles = ['Quant Specialist', 'Market & Steam Specialist'];

        // Seed a workflow outcome record into the knowledge repository
        await globalFeedbackEngine.processFeedback({
            workflowId,
            task: 'Assess home favorite spread value',
            appId: 'duelodds',
            durationMs: 250,
            targetTier: 'complex',
            agentRoles: realRoles
        });

        // Submit feedback outcome
        const feedbackRes = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflowId,
                outcome: 'win'
            })
        });

        expect(feedbackRes.status).toBe(200);
        const fbData = await feedbackRes.json();
        expect(fbData.ok).toBe(true);
        expect(fbData.accuracyScore).toBe(1.0);

        // Verify metrics endpoint reports real roles
        const metricsRes = await fetch(`${baseUrl}/api/swarm/metrics`);
        expect(metricsRes.status).toBe(200);
        const metricsData = await metricsRes.json();

        expect(metricsData.analystAccuracy).toBeDefined();
        expect(metricsData.analystAccuracy['duelodds:Quant Specialist']).toBeDefined();
        expect(metricsData.analystAccuracy['duelodds:Quant Specialist'].wins).toBe(1);
        expect(metricsData.analystAccuracy['duelodds:Market & Steam Specialist']).toBeDefined();
        expect(metricsData.analystAccuracy['duelodds:Market & Steam Specialist'].wins).toBe(1);

        // Verify fake roles are never recorded
        expect(metricsData.analystAccuracy['duelodds:SpecialistRouter']).toBeUndefined();
        expect(metricsData.analystAccuracy['duelodds:Verification Node']).toBeUndefined();

        // Verify specialistProfiles in metrics endpoint reflects outcomes-driven routing
        expect(metricsData.specialistProfiles).toBeDefined();
        expect(metricsData.specialistProfiles['Quant Specialist']).toBeDefined();
        expect(metricsData.specialistProfiles['Quant Specialist'].accuracyWins).toBe(1);
        expect(metricsData.specialistProfiles['Quant Specialist'].accuracyScore).toBe(1.0);
        expect(metricsData.specialistProfiles['Market & Steam Specialist']).toBeDefined();
        expect(metricsData.specialistProfiles['Market & Steam Specialist'].accuracyWins).toBe(1);
        expect(metricsData.specialistProfiles['Market & Steam Specialist'].accuracyScore).toBe(1.0);

        // Verify idempotency on repeat request
        const repeatRes = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId, outcome: 'win' })
        });
        expect(repeatRes.status).toBe(200);
        const repeatData = await repeatRes.json();
        expect(repeatData.message).toContain('Feedback already processed');
    });

    it('handles workflows with empty agentRoles gracefully as a safe no-op', async () => {
        const workflowId = `wf-empty-roles-${Date.now()}`;

        await globalFeedbackEngine.processFeedback({
            workflowId,
            task: 'Ping task',
            appId: 'empty-roles-app',
            durationMs: 50,
            targetTier: 'instant',
            agentRoles: []
        });

        const feedbackRes = await fetch(`${baseUrl}/api/swarm/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId, outcome: 'loss' })
        });

        expect(feedbackRes.status).toBe(200);
        const fbData = await feedbackRes.json();
        expect(fbData.ok).toBe(true);
        expect(fbData.accuracyScore).toBe(0.0);
    });
});
