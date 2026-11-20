import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeOpenAiCompatibleChat } from '../swarm/providers/baseOpenAi.ts';
import { createAnalystExecutor } from '../swarm/engine/analystExecution.ts';
import { runLearningPipeline } from '../swarm/engine/learningPipeline.ts';
import { SwarmContext } from '../swarm/context.ts';
import { ToolRegistry } from '../swarm/tools/registry.ts';
import { globalLoadBalancer } from '../swarm/loadBalancer.ts';
import { ModelRouter } from '../swarm/router.ts';

describe('runNov20 repros', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('test1: salvages 400 tool_use_failed json/non-tool failed_generation into verdict JSON', async () => {
        const verdictArgs = { pass: true, verdict: 'PASS', picks: [], flags: [] };
        const errorBody = JSON.stringify({
            error: {
                message: 'Failed to call a function. Please adjust your prompt.',
                type: 'invalid_request_error',
                code: 'tool_use_failed',
                failed_generation: JSON.stringify({ name: 'json', arguments: verdictArgs })
            }
        });

        vi.stubGlobal('fetch', vi.fn(async () => new Response(errorBody, {
            status: 400,
            headers: { 'content-type': 'application/json' }
        })));

        const result = await executeOpenAiCompatibleChat(
            { modelName: 'llama-3.3-70b-versatile', contents: 'Audit picks' } as any,
            {
                providerName: 'groq',
                providerLabel: 'Groq',
                endpoint: 'https://api.groq.com/openai/v1/chat/completions',
                apiKey: 'test-key',
                modelName: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: 'Audit picks' }],
                maxTokens: 1024,
                isJson: false,
                timeoutMs: 5000,
                tools: [{ type: 'function', function: { name: 'get_market_movement', parameters: {} } }]
            }
        );

        expect(JSON.parse(result)).toEqual(verdictArgs);
    });

    it('test2: critic prompt includes team names and FanDuel lines for cited games at groq budget', async () => {
        const twelveGames = Array.from({ length: 12 }, (_, i) => {
            const idx = i + 1;
            return `event_id=nba-g${idx} | sport=nba | AwayTeam${idx} @ HomeTeam${idx} | options: R${idx} HomeTeam${idx} -${idx}.5 (-110)`;
        }).join('\n');

        const registry = new ToolRegistry([
            {
                name: 'get_market_movement',
                description: 'market',
                parameters: { game_id: { type: 'string', description: 'id', required: true } },
                execute: vi.fn(async () => ({ success: true, summary: 'line stable' }))
            },
            {
                name: 'get_injury_and_roster_delta',
                description: 'injury',
                parameters: { game_id: { type: 'string', description: 'id', required: true } },
                execute: vi.fn(async () => ({ success: true, summary: 'healthy' }))
            }
        ]);

        let capturedPrompt = '';
        const criticAgent: any = {
            id: 'critic',
            role: 'Risk Critic',
            provider: 'groq',
            modelName: 'llama-3.3-70b-versatile',
            setSystemInstruction: vi.fn(),
            run: vi.fn(async (prompt: string) => {
                capturedPrompt = prompt;
                return JSON.stringify({ pass: true, verdict: 'Verified', flags: [] });
            })
        };

        const executeAnalyst = createAnalystExecutor({
            task: 'Evaluate slate picks',
            historicalContext: '',
            chunks: [twelveGames],
            context: new SwarmContext(),
            settings: { appId: 'duelodds' },
            toolRegistry: registry,
            analystClusterMap: new Map()
        });

        await executeAnalyst(criticAgent, twelveGames, 0, {
            summaryText: 'Proposed: HomeTeam2 -2.5, HomeTeam9 -9.5',
            targetGameIds: ['nba-g2', 'nba-g9'],
            proposerReports: [],
            proposedPicks: []
        });

        expect(capturedPrompt.length).toBeLessThanOrEqual(5600);
        expect(capturedPrompt).toContain('AwayTeam2 @ HomeTeam2');
        expect(capturedPrompt).toContain('R2 HomeTeam2 -2.5 (-110)');
        expect(capturedPrompt).toContain('AwayTeam9 @ HomeTeam9');
        expect(capturedPrompt).toContain('R9 HomeTeam9 -9.5 (-110)');
        expect(capturedPrompt).not.toContain('HomeTeam1 ');
        expect(capturedPrompt).not.toContain('HomeTeam12');
    });

    it('test4: empty finalAnalysis.picks sets extrinsic=0.5 and skips globalLoadBalancer.recordReward', async () => {
        const recordRewardSpy = vi.spyOn(globalLoadBalancer, 'recordReward');
        vi.spyOn(ModelRouter, 'inferComplexity').mockReturnValue('simple');

        const context = new SwarmContext();
        const analyst: any = { id: 'a1', role: 'Quant Analyst', provider: 'groq', modelName: 'm1' };
        const manager: any = { id: 'mgr', role: 'Manager', provider: 'openrouter', modelName: 'm2' };

        const result = await runLearningPipeline({
            task: 'Evaluate board',
            data: 'board',
            finalAnalysis: { verdict: 'NO_BET', picks: [] },
            context,
            params: { task: 'Evaluate board', data: 'board' } as any,
            settings: {
                appId: 'duelodds',
                feedbackSettings: { enabled: true },
                coordinationSettings: { enabled: true, rewardShaping: true, adaptiveLearningRates: false },
                profilingSettings: { enabled: false }
            } as any,
            workflowStartTime: Date.now() - 100,
            complexity: 'simple',
            workflowLifecycleResult: {
                verdict: 'PASS',
                computedRating: 0.92
            },
            analysts: [analyst],
            managerAgent: manager,
            targetAppId: 'duelodds',
            cacheKey: 'k1',
            cacheQuery: 'q1',
            agentConfigVersion: 'v1',
            tieredCacheEnabled: false,
            profilingEnabled: false,
            coordinationEnabled: true,
            workflowTotalTokens: 100,
            workflowPromptTokensSaved: 0,
            workflowOriginalPromptTokens: 100,
            workflowCompressedPromptTokens: 100,
            workflowDeduplicatedCount: 0
        });

        expect(result.workflowShapedReward?.components.extrinsic).toBe(0.5);
        expect(recordRewardSpy).not.toHaveBeenCalled();
    });
});
