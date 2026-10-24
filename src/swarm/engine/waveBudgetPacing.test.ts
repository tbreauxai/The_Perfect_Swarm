import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runClusterPipeline } from './clusterPipeline.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { ToolRegistry } from '../tools/index.ts';
import { globalProviderLimiter } from '../providers/limiter.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Module 4: Pre-Flight Wave Budget Pacing', () => {
    beforeEach(() => {
        globalProviderLimiter.reset();
        ProviderRegistry.register({
            providerName: 'groq',
            async call(options: any) {
                return JSON.stringify({
                    insights: [`Analysis for ${options.prompt?.substring(0, 30)}`],
                    anomalies: [],
                    summary: 'OK'
                });
            }
        } as any);

        ProviderRegistry.register({
            providerName: 'gemini',
            async call(options: any) {
                return JSON.stringify({
                    insights: [`Gemini analysis for ${options.prompt?.substring(0, 30)}`],
                    anomalies: [],
                    summary: 'OK'
                });
            }
        } as any);
    });

    it('paces wave tasks sequentially when cumulative wave tokens exceed provider budget', async () => {
        const analyst1 = new Agent('Analyst 1', 'test-model', 'groq' as any, 'mock-key');
        const analyst2 = new Agent('Analyst 2', 'test-model', 'groq' as any, 'mock-key');
        const manager = new Agent('Manager', 'test-model', 'gemini' as any, 'mock-key');

        const context = new SwarmContext();
        const toolRegistry = new ToolRegistry();

        // Mock budgetWaitMs to simulate budget constraint on Groq (wait needed when tokens > 20)
        const budgetSpy = vi.spyOn(globalProviderLimiter, 'budgetWaitMs').mockImplementation((prov, tokens) => {
            if (prov === 'groq' && tokens > 20) return 20; // 20ms required wait
            return 0;
        });

        const chunks = [
            'Record 1: System latency metric log entry for node-A with payload data',
            'Record 2: Database connection pool utilization event for cluster-B with payload data'
        ];

        try {
            const result = await runClusterPipeline({
                task: 'Analyze system telemetry',
                analysts: [analyst1, analyst2],
                managerAgent: manager,
                chunks,
                profile: { format: 'JSON' },
                rawInput: chunks.join('\n'),
                historicalContext: 'No prior issues',
                targetAppId: 'app-telemetry',
                context,
                toolRegistry,
                params: {
                    task: 'Analyze system telemetry',
                    data: chunks.join('\n'),
                    speculativeParallel: false
                },
                settings: {
                    speculativeParallel: false
                },
                optimizationEnabled: false,
                coordinationEnabled: false,
                bypassCache: true
            });

            expect(result).toBeDefined();
            expect(result.allAnalystReports).toBeDefined();
            expect(result.allAnalystReports.length).toBeGreaterThan(0);

            // Verify that Wave Budget Pacing event was recorded due to budget constraint
            const pacingEvents = context.events.filter(e => e.action === 'Wave Budget Pacing');
            expect(pacingEvents.length).toBeGreaterThan(0);
            expect(pacingEvents[0].output.tokensByProvider.groq).toBeGreaterThan(0);
            expect(pacingEvents[0].output.maxWaitMs).toBe(20);
        } finally {
            budgetSpy.mockRestore();
        }
    });

    it('dispatches concurrently without pacing when provider budget has full headroom', async () => {
        const analyst1 = new Agent('Gemini Analyst 1', 'test-model', 'gemini' as any, 'mock-key');
        const analyst2 = new Agent('Gemini Analyst 2', 'test-model', 'gemini' as any, 'mock-key');
        const manager = new Agent('Manager', 'test-model', 'gemini' as any, 'mock-key');

        const context = new SwarmContext();
        const toolRegistry = new ToolRegistry();

        const chunks = [
            'Chunk 1 data',
            'Chunk 2 data'
        ];

        const result = await runClusterPipeline({
            task: 'Analyze report',
            analysts: [analyst1, analyst2],
            managerAgent: manager,
            chunks,
            profile: { format: 'JSON' },
            rawInput: chunks.join('\n'),
            historicalContext: 'Clean',
            targetAppId: 'app-report',
            context,
            toolRegistry,
            params: {
                task: 'Analyze report',
                data: chunks.join('\n'),
                speculativeParallel: false
            },
            settings: {
                speculativeParallel: false
            },
            optimizationEnabled: false,
            coordinationEnabled: false,
            bypassCache: true
        });

        expect(result).toBeDefined();
        // Since Gemini has 8000 TPM and 0 wait, no Wave Budget Pacing event should be recorded
        const pacingEvents = context.events.filter(e => e.action === 'Wave Budget Pacing');
        expect(pacingEvents.length).toBe(0);
    });
});
