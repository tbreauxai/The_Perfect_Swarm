import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSwarmServer } from './server.ts';
import { globalFeedbackEngine } from './feedback.ts';
import { MemoryCortex } from './memory.ts';

describe('Swarm Server & Feedback Attribution', () => {

    it('a workflow return does not block on the cortex upsert', async () => {
        let upsertStarted = false;
        let upsertFinished = false;

        const mockCortex = {
            store: async () => {
                upsertStarted = true;
                // Wait deliberately to ensure the caller didn't block
                await new Promise(resolve => setTimeout(resolve, 50));
                upsertFinished = true;
                return "mock-id";
            },
            isQdrantAvailable: false
        };

        const { runLearningPipeline } = await import('./engine/learningPipeline.ts');

        const res = await runLearningPipeline({
            task: 'test non blocking',
            data: null,
            finalAnalysis: { ui_title: 'test' },
            context: { addEvent: () => {} } as any,
            params: {} as any,
            settings: undefined,
            workflowStartTime: Date.now(),
            complexity: 'instant',
            workflowLifecycleResult: { success: true },
            analysts: [],
            managerAgent: { role: 'manager' } as any,
            memoryCortex: mockCortex as any,
            targetAppId: 'app1',
            cacheKey: 'k',
            cacheQuery: 'q',
            agentConfigVersion: 'v',
            tieredCacheEnabled: false,
            profilingEnabled: false,
            coordinationEnabled: false,
            workflowTotalTokens: 0,
            workflowPromptTokensSaved: 0,
            workflowOriginalPromptTokens: 0,
            workflowCompressedPromptTokens: 0,
            workflowDeduplicatedCount: 0
        });

        // The pipeline should return instantly without awaiting the store
        expect(upsertStarted).toBe(true);
        expect(upsertFinished).toBe(false); // Because it takes 50ms and we didn't block

        // Cleanup wait
        await new Promise(resolve => setTimeout(resolve, 60));
    });

    let server: any;
    let cortex: MemoryCortex;
    let baseUrl: string;

    beforeEach(async () => {
        cortex = new MemoryCortex({
            defaultAppId: 'test-app'
        });
        server = createSwarmServer({
            cors: true,
            defaultCortex: cortex,
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
        const oldTokens = process.env.SWARM_APP_TOKENS;
        process.env.SWARM_APP_TOKENS = 'test-app:test-token';
        try {
            const res1 = await fetch(`${baseUrl}/api/swarm/feedback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token'
                },
                body: JSON.stringify({})
            });
            expect(res1.status).toBe(400);

            const res2 = await fetch(`${baseUrl}/api/swarm/feedback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token'
                },
                body: JSON.stringify({ workflowId: 'wf-1' })
            });
            expect(res2.status).toBe(400);

            const res3 = await fetch(`${baseUrl}/api/swarm/feedback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token'
                },
                body: JSON.stringify({ workflowId: 'non-existent-wf', outcome: 'win' })
            });
            expect(res3.status).toBe(200);
            const missing = await res3.json();
            expect(missing.recordedWithoutWorkflow).toBe(true);
            expect(missing.workflowId).toBe('non-existent-wf');
        } finally {
            if (oldTokens !== undefined) process.env.SWARM_APP_TOKENS = oldTokens;
            else delete process.env.SWARM_APP_TOKENS;
        }
    });

    it('records win/loss in analystLedger using real agentRoles instead of fake pipeline nodes', async () => {
        const oldTokens = process.env.SWARM_APP_TOKENS;
        process.env.SWARM_APP_TOKENS = 'duelodds:duelodds-token';
        try {
            const workflowId = `wf-real-role-${Date.now()}`;
            const realRoles = ['Quant Specialist', 'Market & Steam Specialist'];

            await cortex.store('Assess home favorite spread value', {
                workflowId,
                originApp: 'duelodds',
                domain: 'odds',
                memoryType: 'judgment'
            });

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
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer duelodds-token'
                },
                body: JSON.stringify({
                    workflowId,
                    outcome: 'win'
                })
            });

            expect(feedbackRes.status).toBe(200);
            const fbData = await feedbackRes.json();
            expect(fbData.ok).toBe(true);
            expect(fbData.accuracyScore).toBe(1.0);
            expect(fbData.components).toBeDefined();
            expect(typeof fbData.components.accuracyReward).toBe('number');

            // Verify metrics endpoint reports real roles
            const metricsRes = await fetch(`${baseUrl}/api/swarm/metrics`, {
                headers: { 'Authorization': 'Bearer duelodds-token' }
            });
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
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer duelodds-token'
                },
                body: JSON.stringify({ workflowId, outcome: 'win' })
            });
            expect(repeatRes.status).toBe(200);
            const repeatData = await repeatRes.json();
            expect(repeatData.message).toContain('Feedback already processed');
        } finally {
            if (oldTokens !== undefined) process.env.SWARM_APP_TOKENS = oldTokens;
            else delete process.env.SWARM_APP_TOKENS;
        }
    });

    it('handles workflows with empty agentRoles gracefully as a safe no-op', async () => {
        const oldTokens = process.env.SWARM_APP_TOKENS;
        process.env.SWARM_APP_TOKENS = 'empty-roles-app:empty-roles-token';
        try {
            const workflowId = `wf-empty-roles-${Date.now()}`;

            await cortex.store('Ping task', {
                workflowId,
                originApp: 'empty-roles-app',
                domain: 'general',
                memoryType: 'judgment'
            });

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
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer empty-roles-token'
                },
                body: JSON.stringify({ workflowId, outcome: 'loss' })
            });

            expect(feedbackRes.status).toBe(200);
            const fbData = await feedbackRes.json();
            expect(fbData.ok).toBe(true);
            expect(fbData.accuracyScore).toBe(0.0);
        } finally {
            if (oldTokens !== undefined) process.env.SWARM_APP_TOKENS = oldTokens;
            else delete process.env.SWARM_APP_TOKENS;
        }
    });

    it('calibrates reward weights via POST and queries status via GET /api/swarm/calibrate', async () => {
        // Query GET /api/swarm/calibrate
        const getRes = await fetch(`${baseUrl}/api/swarm/calibrate?appId=test-app`);
        expect(getRes.status).toBe(200);
        const getData = await getRes.json();
        expect(getData.currentWeights).toBeDefined();
        expect(getData.currentWeights.quality).toBeDefined();

        // Send observations to calibrate
        const observations = [
            {
                metrics: {
                    workflowId: 'wf-cal-1',
                    task: 'Win task',
                    appId: 'test-app',
                    durationMs: 15000,
                    targetTier: 'complex',
                    tokenSavings: 2000,
                    tokensConsumed: 4000,
                    qualityScore: 0.95,
                    accuracyScore: 0.98,
                    errorCount: 0,
                    anomalyCount: 0,
                    timestamp: Date.now()
                },
                outcome: 'win'
            },
            {
                metrics: {
                    workflowId: 'wf-cal-2',
                    task: 'Loss task',
                    appId: 'test-app',
                    durationMs: 70000,
                    targetTier: 'complex',
                    tokenSavings: 0,
                    tokensConsumed: 25000,
                    qualityScore: 0.35,
                    accuracyScore: 0.20,
                    errorCount: 2,
                    anomalyCount: 1,
                    timestamp: Date.now()
                },
                outcome: 'loss'
            }
        ];

        const postRes = await fetch(`${baseUrl}/api/swarm/calibrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appId: 'test-app',
                observations,
                iterations: 100,
                autoApply: true
            })
        });

        expect(postRes.status).toBe(200);
        const postData = await postRes.json();
        expect(postData.ok).toBe(true);
        expect(postData.sampleSize).toBe(2);
        expect(postData.optimalWeights).toBeDefined();
        expect(postData.currentWeights).toBeDefined();
    });

    it('rejects disallowed origins with 403 on preflight and omits allow-origin header on requests', async () => {
        // Disallowed preflight
        const optionsRes = await fetch(`${baseUrl}/api/swarm/stream`, {
            method: 'OPTIONS',
            headers: { 'Origin': 'https://evil.example' }
        });
        expect(optionsRes.status).toBe(403);
        expect(await optionsRes.text()).toContain('Forbidden: Origin not allowed');

        // Disallowed actual request
        const getRes = await fetch(`${baseUrl}/api/health`, {
            headers: { 'Origin': 'https://evil.example' }
        });
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('echoes allowed origin with Vary: Origin and returns 204 on preflight', async () => {
        // Allowed preflight
        const optionsRes = await fetch(`${baseUrl}/api/swarm/stream`, {
            method: 'OPTIONS',
            headers: { 'Origin': 'https://duelodds.pages.dev' }
        });
        expect(optionsRes.status).toBe(204);
        expect(optionsRes.headers.get('access-control-allow-origin')).toBe('https://duelodds.pages.dev');
        expect(optionsRes.headers.get('vary')).toBe('Origin');
        expect(optionsRes.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
        expect(optionsRes.headers.get('access-control-allow-headers')).toContain('Authorization');
        expect(optionsRes.headers.get('access-control-allow-headers')).not.toContain('x-provider-key');

        // Allowed actual request
        const getRes = await fetch(`${baseUrl}/api/health`, {
            headers: { 'Origin': 'https://duelodds.pages.dev' }
        });
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('access-control-allow-origin')).toBe('https://duelodds.pages.dev');
        expect(getRes.headers.get('vary')).toBe('Origin');
    });

    it('attaches security headers to responses', async () => {
        const res = await fetch(`${baseUrl}/api/health`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' https://the-perfect-swarm.onrender.com");
    });

    it('returns JSON 404 for unknown /api/* endpoints', async () => {
        const res = await fetch(`${baseUrl}/api/does-not-exist`);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
        const data = await res.json();
        expect(data).toEqual({ error: 'Not found' });
    });

    it('server ignores client provider secrets in body settings and agents while server env values win', async () => {
        const { sanitizeClientSettings } = await import('./server/app.ts');
        const clientBodySettings = {
            geminiApiKey: 'client-gemini-leak',
            openRouterApiKey: 'client-openrouter-leak',
            groqApiKey: 'client-groq-leak',
            mistralApiKey: 'client-mistral-leak',
            githubToken: 'client-gh-leak',
            qdrantUrl: 'https://evil.qdrant.tech',
            qdrantApiKey: 'evil-qdrant-key',
            apiKey: 'evil-api-key',
            appId: 'my-custom-app',
            forceFullSwarm: true,
            agents: [
                {
                    id: 'agent-1',
                    role: 'Lead Analyst',
                    provider: 'groq',
                    model: 'llama-3.3-70b',
                    apiKey: 'agent-secret-leak',
                    groqApiKey: 'agent-groq-leak'
                }
            ],
            critic: {
                role: 'Verification Critic',
                provider: 'gemini',
                model: 'gemini-3.5-flash-lite',
                apiKey: 'critic-secret-leak'
            }
        };

        const edgeSettings = {
            geminiApiKey: 'server-secret-gemini',
            groqApiKey: 'server-secret-groq',
            qdrantUrl: 'https://server.qdrant.tech',
            qdrantApiKey: 'server-qdrant-key'
        };

        const defaultSettings = {
            appId: 'default-app'
        };

        const sanitized = sanitizeClientSettings(clientBodySettings, edgeSettings, defaultSettings);

        // Client secrets must be deleted or overwritten by server env
        expect(sanitized.geminiApiKey).toBe('server-secret-gemini');
        expect(sanitized.groqApiKey).toBe('server-secret-groq');
        expect(sanitized.qdrantUrl).toBe('https://server.qdrant.tech');
        expect(sanitized.qdrantApiKey).toBe('server-qdrant-key');
        expect(sanitized.openRouterApiKey).toBeUndefined();
        expect(sanitized.mistralApiKey).toBeUndefined();
        expect(sanitized.githubToken).toBeUndefined();
        expect(sanitized.apiKey).toBeUndefined();

        // Non-secret fields must be preserved
        expect(sanitized.appId).toBe('my-custom-app');
        expect(sanitized.forceFullSwarm).toBe(true);

        // Agent configuration must preserve role, provider, model and delete secrets
        expect(sanitized.agents[0].id).toBe('agent-1');
        expect(sanitized.agents[0].role).toBe('Lead Analyst');
        expect(sanitized.agents[0].provider).toBe('groq');
        expect(sanitized.agents[0].model).toBe('llama-3.3-70b');
        expect(sanitized.agents[0].apiKey).toBeUndefined();
        expect(sanitized.agents[0].groqApiKey).toBeUndefined();

        // Critic configuration must preserve role, provider, model and delete secrets
        expect(sanitized.critic.role).toBe('Verification Critic');
        expect(sanitized.critic.provider).toBe('gemini');
        expect(sanitized.critic.model).toBe('gemini-3.5-flash-lite');
        expect(sanitized.critic.apiKey).toBeUndefined();
    });

    it('ignores x-provider-key on /api/swarm/models', async () => {
        const res = await fetch(`${baseUrl}/api/swarm/models?provider=simulated`, {
            headers: {
                'x-provider-key': 'attacker-key'
            }
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
        expect(data[0].id).toBe('simulated-swarm-v1');
    });

    it('rejects payload > 2MB on /api/swarm/stream with 413 JSON', async () => {
        const largeString = 'a'.repeat(2.1 * 1024 * 1024);
        const res = await fetch(`${baseUrl}/api/swarm/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ task: 'Analyze big data', data: largeString })
        });
        expect(res.status).toBe(413);
        const data = await res.json();
        expect(data).toEqual({ error: 'Payload Too Large' });
    });

    it('rejects payload > 2MB on /api/swarm/analyze with 413 JSON', async () => {
        const largeString = 'a'.repeat(2.1 * 1024 * 1024);
        const res = await fetch(`${baseUrl}/api/swarm/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ task: 'Analyze big data', data: largeString })
        });
        expect(res.status).toBe(413);
        const data = await res.json();
        expect(data).toEqual({ error: 'Payload Too Large' });
    });
});

