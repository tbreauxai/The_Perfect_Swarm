import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../swarm/agent.ts';
import { SwarmContext } from '../swarm/context.ts';
import { buildCompactRunDiagnostics } from '../swarm/engine/runDiagnostics.ts';
import { runDeepAnalysisVerification } from '../swarm/engine/verificationPipeline.ts';
import { AnalysisLifecycle } from '../swarm/lifecycle.ts';
import { buildGeminiRequestConfig, GeminiAdapter } from '../swarm/providers/gemini.ts';
import { BILLING_COOLDOWN_MS, globalProviderLimiter } from '../swarm/providers/limiter.ts';
import { clearCatalogCache } from '../swarm/server/modelsProvider.ts';
import { auditMarketCoverageAndRowBinding } from '../swarm/tools/marketRowBinding.ts';

describe('wf-1795719254817: Instant 402 Cooldown, Non-Poisoning Verification Retries, Opponent Venue Guard & Gemini 4 Budget', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        globalProviderLimiter.reset();
        clearCatalogCache();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        globalProviderLimiter.reset();
        clearCatalogCache();
    });

    describe('S1: Zero-retry instant cooldown on HTTP 401/402/403 & limit: 0 billing errors', () => {
        it('aborts Mistral HTTP 402 in <50ms with 1 fetch total, fails over immediately, and skips Mistral in 0ms with [BILLING_COOLDOWN_SKIP] on subsequent call', async () => {
            let mistralFetchCount = 0;
            let groqFetchCount = 0;

            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
                const url = String(input);
                if (url.includes('mistral.ai')) {
                    mistralFetchCount += 1;
                    return new Response(
                        JSON.stringify({ message: 'Payment Required: billing balance exhausted' }),
                        { status: 402, headers: { 'content-type': 'application/json' } }
                    );
                }
                if (url.includes('groq.com')) {
                    groqFetchCount += 1;
                    return new Response(
                        JSON.stringify({
                            choices: [{
                                message: {
                                    content: JSON.stringify({
                                        insights: ['Recovered on backup'],
                                        anomalies: [],
                                        summary: 'Backup succeeded cleanly.',
                                        picks: []
                                    })
                                },
                                finish_reason: 'stop'
                            }],
                            usage: { prompt_tokens: 120, completion_tokens: 40 }
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } }
                    );
                }
                throw new Error(`Unexpected fetch URL: ${url}`);
            });

            const context = new SwarmContext();
            const agent1 = new Agent(
                'Manager Node',
                'mistral-small-2603',
                'mistral',
                'mistral-test-key',
                undefined,
                [{ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'groq-test-key' }]
            );
            agent1.id = 'manager';

            const t0 = Date.now();
            const firstOut = await agent1.run('Synthesize picks', context, {
                responseMimeType: 'application/json',
                bypassCache: true
            });
            const elapsedMs = Date.now() - t0;

            expect(mistralFetchCount).toBe(1);
            expect(groqFetchCount).toBe(1);
            expect(elapsedMs).toBeLessThan(250);
            expect(typeof firstOut).toBe('object');

            const skipReason = globalProviderLimiter.getSkipReason('mistral', 'mistral-small-2603');
            expect(skipReason).toContain('[BILLING_COOLDOWN_SKIP]');
            expect(globalProviderLimiter.isAvailable('mistral', 'mistral-other-model')).toBe(false);

            // Second call in same workflow (e.g. Attempt 2 / Verifier) skips Mistral in 0ms without calling fetch
            const agent2 = new Agent(
                'Verification Critic',
                'mistral-small-2603',
                'mistral',
                'mistral-test-key',
                undefined,
                [{ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'groq-test-key' }]
            );
            agent2.id = 'verifier';

            const t1 = Date.now();
            await agent2.run('Verify output', context, {
                responseMimeType: 'application/json',
                bypassCache: true
            });
            const secondElapsedMs = Date.now() - t1;

            expect(mistralFetchCount).toBe(1);
            expect(groqFetchCount).toBe(2);
            expect(secondElapsedMs).toBeLessThan(100);

            const diag = buildCompactRunDiagnostics({ events: context.events, totalMs: 100 });
            const billingSkipEntry = diag.failovers.find((f) => f.reason === '[BILLING_COOLDOWN_SKIP]');
            expect(billingSkipEntry).toBeDefined();
            expect(billingSkipEntry?.from.startsWith('mistral/')).toBe(true);
            expect(billingSkipEntry?.durationMs).toBe(0);
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        });

        it('places HTTP 401, 403, and 429 limit:0 on immediate 30-minute billing cooldown with zero retries', async () => {
            let calls401 = 0;
            let calls429Zero = 0;
            vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
                const url = String(input);
                if (url.includes('api.mistral.ai')) {
                    calls401 += 1;
                    return new Response(
                        JSON.stringify({ message: 'Unauthorized: invalid api key' }),
                        { status: 401, headers: { 'content-type': 'application/json' } }
                    );
                }
                if (url.includes('openrouter.ai')) {
                    calls429Zero += 1;
                    return new Response(
                        JSON.stringify({ error: { message: 'Spending limit reached; limit: 0' } }),
                        { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' } }
                    );
                }
                if (url.includes('groq.com')) {
                    return new Response(
                        JSON.stringify({
                            choices: [{ message: { content: JSON.stringify({ insights: ['ok'], anomalies: [], summary: 'ok', picks: [] }) }, finish_reason: 'stop' }],
                            usage: { prompt_tokens: 50, completion_tokens: 20 }
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } }
                    );
                }
                throw new Error(`Unexpected URL: ${url}`);
            });

            const context = new SwarmContext();
            const mAgent = new Agent(
                'Analyst 1',
                'mistral-small-2603',
                'mistral',
                'bad-key',
                undefined,
                [{ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'groq-k' }]
            );
            await mAgent.run('Prompt 1', context, { responseMimeType: 'application/json', bypassCache: true });
            expect(calls401).toBe(1);
            expect(globalProviderLimiter.getSkipReason('mistral', 'mistral-small-2603')).toContain('[BILLING_COOLDOWN_SKIP]');

            globalProviderLimiter.reset();
            const orAgent = new Agent(
                'Analyst 2',
                'meta-llama/llama-3.3-70b-instruct:free',
                'openrouter',
                'sk-or-v1-test-key',
                undefined,
                [{ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'groq-k' }]
            );
            const tStart = Date.now();
            await orAgent.run('Prompt 2', context, { responseMimeType: 'application/json', bypassCache: true });
            expect(Date.now() - tStart).toBeLessThan(250);
            expect(calls429Zero).toBe(1);
            expect(globalProviderLimiter.getSkipReason('openrouter', 'meta-llama/llama-3.3-70b-instruct:free')).toContain('[BILLING_COOLDOWN_SKIP]');

            // Also verify 403 directly sets a 30-minute cooldown
            expect(BILLING_COOLDOWN_MS).toBe(30 * 60 * 1000);
            globalProviderLimiter.recordFailure('nvidia', 'nv-model', 'Nvidia API Error (403): billing credit exhausted', true);
            expect(globalProviderLimiter.getSkipReason('nvidia', 'nv-model')).toContain('[BILLING_COOLDOWN_SKIP]');
        });
    });

    describe('S2: Non-poisoning verification retries + Spread regex & Opponent venue guards', () => {
        const texasTechSlate = [
            'event_id=ncaab-401910555 | sport=basketball_ncaab | Arizona Wildcats @ Texas Tech Red Raiders | commence=2026-11-19T02:00:00Z | options: R9 SPR Arizona Wildcats +14.5(-110), R10 SPR Texas Tech Red Raiders -14.5(-110), R11 ML Texas Tech Red Raiders (-620)',
            '[Tool Evidence ncaab-401910555]: Texas Tech Red Raiders -14.5 at (-110); Texas Tech holds a +12.5 net margin vs -2.0 opponent net margin (8-2 record).'
        ].join('\n');

        it('does NOT add Critic-approved leg R10 to vetoedLegs when Attempt 1 has a repairable spread typo (-10 -> -14.5), allowing Attempt 2 to pass with R10 kept', async () => {
            const context = new SwarmContext();
            let managerCalls = 0;
            const promptsSeen: string[] = [];

            const managerAgent = {
                id: 'manager',
                role: 'Manager Node',
                provider: 'groq',
                modelName: 'llama-3.3-70b-versatile',
                setSystemInstruction: vi.fn(),
                run: vi.fn(async (prompt: string) => {
                    managerCalls += 1;
                    promptsSeen.push(prompt);
                    if (managerCalls === 1) {
                        return JSON.stringify({
                            ui_title: 'Attempt 1',
                            summary: 'Backing Texas Tech Red Raiders -10 against Arizona on home court.',
                            components: [],
                            picks: [
                                {
                                    row: 'R10',
                                    event_id: 'ncaab-401910555',
                                    side: 'Texas Tech Red Raiders -14.5',
                                    reason: 'Backing Texas Tech Red Raiders -10 against Arizona Wildcats on home court.'
                                }
                            ],
                            scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'R10 approved (anomalies: []).' }]
                        });
                    }
                    // Attempt 2 fixes the prose typo from -10 to -14.5 and keeps R10
                    return JSON.stringify({
                        ui_title: 'Attempt 2 Repaired',
                        summary: 'Backing Texas Tech Red Raiders -14.5 against Arizona Wildcats on home court.',
                        components: [],
                        picks: [
                            {
                                row: 'R10',
                                event_id: 'ncaab-401910555',
                                side: 'Texas Tech Red Raiders -14.5',
                                reason: 'Backing Texas Tech Red Raiders -14.5 against Arizona Wildcats on home court.'
                            }
                        ],
                        scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'R10 approved.' }]
                    });
                })
            } as unknown as Agent;

            const verifierAgent = {
                id: 'verifier',
                role: 'Verification Critic',
                provider: 'cloudflare',
                modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                setSystemInstruction: vi.fn(),
                run: vi.fn(async () =>
                    JSON.stringify({
                        pass: true,
                        feedback: 'R10 Texas Tech Red Raiders -14.5 grounded cleanly.'
                    })
                )
            } as unknown as Agent;

            const lifecycle = new AnalysisLifecycle(managerAgent, verifierAgent, 2);
            const lifecycleResult = await lifecycle.executeAndVerify(
                {
                    fullBoard: texasTechSlate,
                    toolResults: texasTechSlate,
                    analystReports: 'Quant proposed R10 Texas Tech Red Raiders -14.5; Risk Critic approved R10.'
                },
                context,
                'Recommend top NCAAB ATS play',
                'Verify spread grounding against authoritative slate.'
            );

            expect(managerCalls).toBe(2);
            expect(promptsSeen[1]).toContain('spread mismatch');
            expect(promptsSeen[1]).not.toContain('must be removed from picks');
            expect(lifecycleResult.success).toBe(true);
            expect(lifecycleResult.vetoedLegs ?? []).toEqual([]);
            const keptRows = (lifecycleResult.finalProposal?.picks || []).map((p: any) => p.row);
            expect(keptRows).toContain('R10');
        });

        it('keeps the leg in runDeepAnalysisVerification when Attempt 1 fails only a repairable spread prose mismatch and Attempt 2 fixes it', async () => {
            const context = new SwarmContext();
            let managerCalls = 0;

            const managerAgent = {
                id: 'manager',
                role: 'Manager Node',
                provider: 'groq',
                modelName: 'llama-3.3-70b-versatile',
                setSystemInstruction: vi.fn(),
                run: vi.fn(async () => {
                    managerCalls += 1;
                    const citedLine = managerCalls === 1 ? '-10' : '-14.5';
                    return JSON.stringify({
                        ui_title: `Draft ${managerCalls}`,
                        summary: `Backing Texas Tech Red Raiders ${citedLine} at home.`,
                        components: [],
                        picks: [
                            {
                                row: 'R10',
                                event_id: 'ncaab-401910555',
                                side: 'Texas Tech Red Raiders -14.5',
                                reason: `Backing Texas Tech Red Raiders ${citedLine} at (-110) with -2.0 opponent net margin.`
                            }
                        ],
                        scorecards: [{ seat: 'Risk Critic', verdict: 'approve', notes: 'Approved R10.' }]
                    });
                })
            } as unknown as Agent;

            const verifierAgent = {
                id: 'verifier',
                role: 'Verification Critic',
                provider: 'cloudflare',
                modelName: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                setSystemInstruction: vi.fn(),
                run: vi.fn(async () =>
                    JSON.stringify({
                        pass: true,
                        feedback: 'R10 Texas Tech Red Raiders -14.5 clean.'
                    })
                )
            } as unknown as Agent;

            const res = await runDeepAnalysisVerification({
                task: texasTechSlate,
                rawInput: texasTechSlate,
                effectiveDynamicPrompt: texasTechSlate,
                effectiveCompiledReports: 'Risk Critic approved R10 Texas Tech Red Raiders -14.5.',
                effectiveHistoricalContext: '',
                managerAgent,
                analysts: [],
                dedicatedCriticAgent: verifierAgent,
                context,
                settings: { maxRepairRetries: 1, model: 'gemini-3.8-flash' } as any,
                toolResults: texasTechSlate,
                criticVerdictApproved: true,
                hadProposedPicks: true
            });

            expect(managerCalls).toBe(2);
            expect(res.lifecycleResult.success).toBe(true);
            expect(res.finalAnalysis.picks.map((p: any) => p.row)).toContain('R10');
        });

        it('excludes row IDs (R10), American odds (-110), W-L records (4-1, 8-2), and opponent net margins (-2.0) from spread mismatch', () => {
            const proposal = {
                summary: 'Back Texas Tech Red Raiders (R10) at (-110) with -2.0 opponent net margin and (8-2) home record vs (4-1) split.',
                picks: [
                    {
                        row: 'R10',
                        event_id: 'ncaab-401910555',
                        side: 'Texas Tech Red Raiders -14.5',
                        reason: 'Texas Tech Red Raiders (R10) at (-110) with -2.0 opponent net margin (8-2) lays -14.5.'
                    }
                ]
            };

            const audit = auditMarketCoverageAndRowBinding(proposal, texasTechSlate, texasTechSlate);

            expect(audit.pass).toBe(true);
            expect(audit.flags).not.toContain('spread_value_mismatch');
            expect(audit.flags).not.toContain('spread_side_mismatch');
            expect(String(audit.feedback || '')).not.toMatch(/spread mismatch/i);
        });

        it('does NOT flag unpicked opponent Philadelphia Eagles for venue mismatch in a picked Dallas Cowboys clause', () => {
            const cowboysSlate =
                'event_id=nfl-401920001 | sport=americanfootball_nfl | Philadelphia Eagles @ Dallas Cowboys | commence=2026-11-19T18:00:00Z | options: R1 SPR Dallas Cowboys -8.5(-110), R2 SPR Philadelphia Eagles +8.5(-110)';
            const proposal = {
                summary: 'Dallas Cowboys hold a home advantage against Philadelphia Eagles.',
                picks: [
                    {
                        row: 'R1',
                        event_id: 'nfl-401920001',
                        side: 'Dallas Cowboys -8.5',
                        reason: 'Dallas Cowboys hold a home advantage against Philadelphia Eagles and Dallas Cowboys beat Philadelphia Eagles at home.'
                    }
                ]
            };

            const audit = auditMarketCoverageAndRowBinding(
                proposal,
                'Weatherdome: Dallas Cowboys at home against away opponent Philadelphia Eagles.',
                cowboysSlate
            );

            expect(audit.pass).toBe(true);
            expect(audit.flags).toEqual([]);
            expect(String(audit.feedback || '')).not.toMatch(/philadelphia eagles venue mismatch/i);
        });
    });

    describe('S3: Gemini 4 maxOutputTokens >= 4096 + MAX_TOKENS / truncated JSON failover', () => {
        it('sets generationConfig.maxOutputTokens >= 4096 and thinkingConfig.thinkingLevel = LOW for gemini-4-hydrogen (even when caller requests 1800)', async () => {
            const cfgFromSmall = buildGeminiRequestConfig('gemini-4-hydrogen', {
                modelName: 'gemini-4-hydrogen',
                prompt: 'Propose bets',
                role: 'Quant Proposer',
                apiKey: 'gemini-test-key',
                config: {
                    maxTokens: 1800,
                    responseMimeType: 'application/json'
                }
            });

            expect(cfgFromSmall.maxOutputTokens).toBeGreaterThanOrEqual(4096);
            expect(cfgFromSmall.thinkingConfig?.thinkingLevel).toBe('LOW');

            const capturedConfigs: any[] = [];
            const mockClient: any = {
                models: {
                    generateContent: vi.fn(async (params: any) => {
                        capturedConfigs.push(params.config);
                        return {
                            text: JSON.stringify({
                                insights: ['Valid insight'],
                                anomalies: [],
                                summary: 'Clean JSON output',
                                picks: [{ row: 'R1', side: 'Buffalo Bills -2.5', reason: 'Line value' }]
                            }),
                            candidates: [{ finishReason: 'STOP' }],
                            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 150 }
                        };
                    })
                }
            };

            const a1Agent = new Agent('Quant Proposer', 'gemini-4-hydrogen', 'gemini', 'gemini-test-key', mockClient);
            a1Agent.id = 'a1';
            const ctx = new SwarmContext();

            await a1Agent.run('Analyze NFL slate', ctx, {
                responseMimeType: 'application/json',
                maxTokens: 1800,
                bypassCache: true
            });

            expect(capturedConfigs).toHaveLength(1);
            expect(capturedConfigs[0].maxOutputTokens).toBeGreaterThanOrEqual(4096);
            expect(capturedConfigs[0].thinkingConfig?.thinkingLevel).toBe('LOW');
        });

        it('throws [PARSE_FAILED:max_tokens] on Gemini 4 MAX_TOKENS truncated output and triggers failover rather than silently succeeding with picks: []', async () => {
            const mockGeminiClient: any = {
                models: {
                    generateContent: vi.fn(async () => ({
                        text: '...moving toward the Bills (-2.5 to -3), though',
                        candidates: [{ finishReason: 'MAX_TOKENS' }],
                        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 4096 }
                    }))
                }
            };

            // Direct adapter check
            const adapter = new GeminiAdapter();
            await expect(
                adapter.call({
                    modelName: 'gemini-4-hydrogen',
                    prompt: 'Analyze NFL slate',
                    role: 'Quant Proposer',
                    apiKey: 'gemini-test-key',
                    aiClient: mockGeminiClient,
                    config: { responseMimeType: 'application/json', maxTokens: 1800 }
                })
            ).rejects.toThrow(/\[PARSE_FAILED:max_tokens\]/);

            // Agent failover check: a1 (gemini-4-hydrogen MAX_TOKENS) fails over to groq backup cleanly
            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        choices: [{
                            message: {
                                content: JSON.stringify({
                                    insights: ['Buffalo Bills -2.5 backed by DVOA gap'],
                                    anomalies: [],
                                    summary: 'Bills -2.5 selected cleanly.',
                                    picks: [{ row: 'R1', side: 'Buffalo Bills -2.5', reason: 'EPA edge' }]
                                })
                            },
                            finish_reason: 'stop'
                        }],
                        usage: { prompt_tokens: 200, completion_tokens: 80 }
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                )
            );

            const ctx = new SwarmContext();
            const a1Agent = new Agent(
                'Quant Proposer',
                'gemini-4-hydrogen',
                'gemini',
                'gemini-test-key',
                mockGeminiClient,
                [{ provider: 'groq', modelName: 'openai/gpt-oss-120b', apiKey: 'groq-test-key' }]
            );
            a1Agent.id = 'a1';

            const res: any = await a1Agent.run('Analyze NFL slate', ctx, {
                responseMimeType: 'application/json',
                bypassCache: true
            });

            expect(Array.isArray(res.picks)).toBe(true);
            expect(res.picks).toHaveLength(1);
            expect(res.picks[0].row).toBe('R1');

            const diag = buildCompactRunDiagnostics({ events: ctx.events, totalMs: 100 });
            expect(diag.failovers.some((f) => f.from.startsWith('gemini/') && f.reason === 'max_tokens')).toBe(true);
        });
    });
});
