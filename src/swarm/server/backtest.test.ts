import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSwarmServer } from './app.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { globalProviderLimiter } from '../providers/limiter.ts';
import { MemoryCortex } from '../memory/cortex.ts';

describe('Swarm Server - Isolated Backtesting Endpoint', () => {
    let app: any;

    beforeEach(() => {
        globalProviderLimiter.reset();

        ProviderRegistry.register({
            providerName: 'mock-backtest-analyst',
            async call() {
                return JSON.stringify({
                    insights: ['Historical edge identified on home spread +3.5'],
                    anomalies: [],
                    summary: 'Edge detected'
                });
            }
        } as any);

        ProviderRegistry.register({
            providerName: 'mock-backtest-manager',
            async call() {
                return JSON.stringify({
                    ui_title: 'Historical Simulation Summary',
                    summary: 'Recommended play: Home +3.5 (-110)',
                    confidence: 0.72
                });
            }
        } as any);

        const baseApp = createSwarmServer({
            defaultSettings: {
                appId: 'test-backtest-app',
                agents: [
                    { id: 'manager', role: 'Manager Node', provider: 'mock-backtest-manager', model: 'mock-model' },
                    { id: 'analyst', role: 'Data Analyst', provider: 'mock-backtest-analyst', model: 'mock-model' }
                ]
            }
        });

        app = new Hono();
        app.use('*', async (c: any, next: any) => {
            c.set('callerAppId', 'test-backtest-app');
            c.env = {
                SWARM_APP_TOKENS: 'test-backtest-app:test-token-123',
                SWARM_AUTH_REQUIRED: 'true'
            };
            await next();
        });
        app.route('/', baseApp);
    });

    it('rejects empty or missing slate payload with 400', async () => {
        const req = new Request('http://localhost/api/swarm/backtest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token-123'
            },
            body: JSON.stringify({ slate: [] })
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('Missing or empty slate');
    });

    it('simulates a historical slate of games with isolated in-memory execution', async () => {
        const slate = [
            {
                gameId: 'nba-2024-01-01-bos-lal',
                task: 'Analyze historical matchup BOS vs LAL',
                data: 'BOS @ LAL | BOS -4.5 (-110) | O/U 224.5',
                closingLine: -4.5,
                actualOutcome: 'win'
            },
            {
                gameId: 'nba-2024-01-01-gsw-den',
                task: 'Analyze historical matchup GSW vs DEN',
                data: 'GSW @ DEN | DEN -6.0 (-115) | O/U 230.0',
                closingLine: -6.0,
                actualOutcome: 'loss'
            }
        ];

        const req = new Request('http://localhost/api/swarm/backtest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token-123'
            },
            body: JSON.stringify({
                slate,
                settings: {
                    agents: [
                        { id: 'manager', role: 'Manager Node', provider: 'mock-backtest-manager', model: 'mock-model' },
                        { id: 'analyst', role: 'Data Analyst', provider: 'mock-backtest-analyst', model: 'mock-model' }
                    ]
                }
            })
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.simulatedCount).toBe(2);
        expect(body.results).toHaveLength(2);

        expect(body.results[0].gameId).toBe('nba-2024-01-01-bos-lal');
        expect(body.results[0].status).toBe('complete');
        expect(body.results[0].finalAnalysis).toBeDefined();
        expect(body.results[0].grading).toEqual({
            closingLine: -4.5,
            actualOutcome: 'win',
            simulatedAt: expect.any(String)
        });

        expect(body.results[1].gameId).toBe('nba-2024-01-01-gsw-den');
        expect(body.results[1].grading).toEqual({
            closingLine: -6.0,
            actualOutcome: 'loss',
            simulatedAt: expect.any(String)
        });
    });

    it('ensures isolatedStore runs in-memory and does not pollute global fallback store', () => {
        const isolated = new MemoryCortex({
            defaultAppId: 'isolated-test-app',
            isolatedStore: true
        });

        expect(isolated.isQdrantAvailable).toBe(false);
    });
});
