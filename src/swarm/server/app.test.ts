import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createSwarmServer } from './app.ts';
import { _resetFeedbackDedupe, hashString, setFeedbackInFlight, markFeedbackProcessed, removeFeedbackInFlight, isFeedbackProcessed, isFeedbackInFlight } from './feedbackDedupe.ts';

describe('Swarm Server - Feedback Deduplication', () => {
    let app: any;
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        // Restore by reassignment; mockRestore doesn't work on a directly assigned vi.fn()
        globalThis.fetch = originalFetch;
    });

    beforeEach(() => {
        _resetFeedbackDedupe();

        // Setup an app with callerAppId injected for testing
        const baseApp = createSwarmServer({
            defaultSettings: { appId: 'test-app' }
        });

        app = new Hono();
        app.use('*', async (c: any, next: any) => {
            c.set('callerAppId', 'test-app');
            // Inject env vars to simulate them in Hono context
            c.env = {
                SWARM_APP_TOKENS: 'test-app:test-token-123',
                SWARM_AUTH_REQUIRED: 'true',
                GEMINI_API_KEY: 'test',
                OPENROUTER_API_KEY: 'sk-or-v1-test',
                GROQ_API_KEY: 'test',
                MISTRAL_API_KEY: 'test'
            };
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

        // Stop mocking engine/workflow store. Run real engine with LLM provider HTTP calls stubbed
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "Mocked LLM response" } }]
            }),
            headers: new Headers()
        });

        const analyzePayload = {
            task: "Should we buy or sell AAPL today?",
            data: "Current stock prices and news",
            sportKey: "nba",
            market: "moneyline",
            bypassCache: true,
            settings: {
                geminiApiKey: 'test',
                openRouterApiKey: 'sk-or-v1-test',
                groqApiKey: 'test',
                mistralApiKey: 'test',
                agents: [
                    { id: "manager", role: "Manager Node", provider: "openrouter", model: "auto" },
                    { id: "analyst", role: "Data Analyst", provider: "gemini", model: "auto" }
                ]
            }
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
        expect(typeof returnedWorkflowId).toBe('string');
        expect(returnedWorkflowId.length).toBeGreaterThan(0);

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
        expect(resFeedback.status).toBe(200);
        const feedbackData = await resFeedback.json();
        // The returned workflowId must exist in the store: a genuine record,
        // not a 404 and not a recorded-without-workflow fallback.
        expect(feedbackData.ok).toBe(true);
        expect(feedbackData.recordedWithoutWorkflow).not.toBe(true);

        // Repeat for the stream swarm_complete id
        const reqStream = new Request('http://localhost/api/swarm/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(analyzePayload)
        });

        const resStream = await app.fetch(reqStream);
        expect(resStream.status).toBe(200);

        const streamBody = await resStream.text();
        const swarmCompleteEventStr = streamBody.split('\n\n').find(part => part.includes('event: swarm_complete'));
        expect(swarmCompleteEventStr).toBeDefined();

        const dataLine = swarmCompleteEventStr.split('\n').find(line => line.startsWith('data: '));
        const streamData = JSON.parse(dataLine.replace('data: ', ''));
        const streamWorkflowId = streamData.workflowId;

        expect(typeof streamWorkflowId).toBe('string');
        expect(streamWorkflowId.length).toBeGreaterThan(0);

        const streamFeedbackPayload = {
            workflowId: streamWorkflowId,
            outcome: 'win',
            pickId: 'pick-rt-stream'
        };

        const streamReqFeedback = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(streamFeedbackPayload)
        });

        const streamResFeedback = await app.fetch(streamReqFeedback);
        expect(streamResFeedback.status).toBe(200);
    });

    it('unknown workflowId gets 404 from /feedback', async () => {
        const payload = {
            workflowId: crypto.randomUUID(),
            outcome: 'win',
            pickId: 'pick-unknown-uuid'
        };

        const req = new Request('http://localhost/api/swarm/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toContain('Workflow not found');
    });
});

describe('Contract Tests', () => {
    let contractApp: any;
    const testEnv = {
        SWARM_APP_TOKENS: 'test-app:test-token-123',
        SWARM_AUTH_REQUIRED: 'true',
        GEMINI_API_KEY: 'test',
        OPENROUTER_API_KEY: 'sk-or-v1-test',
        GROQ_API_KEY: 'test',
        MISTRAL_API_KEY: 'test'
    };

    beforeEach(async () => {
        const { vi } = await import('vitest');
        vi.stubEnv('SWARM_APP_TOKENS', 'test-app:test-token-123');
        vi.stubEnv('SWARM_AUTH_REQUIRED', 'true');

        const SwarmServer = await import('./app.ts');
        contractApp = SwarmServer.createSwarmServer({
            defaultSettings: {
                appId: 'test-app',
                agents: [
                    { id: "manager", role: "Manager Node", provider: "openrouter", model: "auto" },
                    { id: "analyst", role: "Data Analyst", provider: "gemini", model: "auto" }
                ]
            }
        });

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "Mocked LLM response" } }]
            }),
            headers: new Headers()
        });
    });

    afterEach(async () => {
        const { vi } = await import('vitest');
        vi.unstubAllEnvs();
        if ((globalThis.fetch as any).mockRestore) {
            (globalThis.fetch as any).mockRestore();
        }
    });

    it('GET /api/health with no token: 200 {status:"ok"}', async () => {
        const req = new Request('http://localhost/api/health');
        const res = await contractApp.fetch(req, testEnv);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('ok');
    });

    it('POST /api/swarm/analyze {task,data} with no token: 401', async () => {
        const req = new Request('http://localhost/api/swarm/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: "test", data: "test" })
        });
        const res = await contractApp.fetch(req, testEnv);
        expect(res.status).toBe(401);
    });

    it('Same request with Authorization: Bearer wrong: 401', async () => {
        const req = new Request('http://localhost/api/swarm/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer wrong-token'
            },
            body: JSON.stringify({ task: "test", data: "test" })
        });
        const res = await contractApp.fetch(req, testEnv);
        expect(res.status).toBe(401);
    });

    it('SWARM_APP_TOKENS="" with SWARM_AUTH_REQUIRED="true": 503', async () => {
        const { vi } = await import('vitest');
        vi.stubEnv('SWARM_APP_TOKENS', '');

        const req = new Request('http://localhost/api/swarm/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token-123'
            },
            body: JSON.stringify({ task: "test", data: "test" })
        });
        const res = await contractApp.fetch(req, { ...testEnv, SWARM_APP_TOKENS: '' });
        expect(res.status).toBe(503);
    });

    it('Bearer test-token-123 with a clean body (with metadata): 200 plus workflowId', async () => {
        const req = new Request('http://localhost/api/swarm/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token-123'
            },
            body: JSON.stringify({
                task: "Should we buy AAPL?",
                data: "Current stock prices",
                metadata: { source: 'test' }
            })
        });
        const res = await contractApp.fetch(req, testEnv);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(typeof data.workflowId).toBe('string');
        expect(data.workflowId.length).toBeGreaterThan(0);
    });

    it('Bearer test-token-123 with a clean body (without metadata): 200 plus workflowId', async () => {
        const req = new Request('http://localhost/api/swarm/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token-123'
            },
            body: JSON.stringify({
                task: "Should we buy AAPL?",
                data: "Current stock prices"
            })
        });
        const res = await contractApp.fetch(req, testEnv);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(typeof data.workflowId).toBe('string');
        expect(data.workflowId.length).toBeGreaterThan(0);
    });
});