import { describe, it, expect, vi } from 'vitest';
import { compileSynthesisPrompt, executeManagerSynthesis } from './synthesisPipeline.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import type { ClusterDigest } from '../communication.ts';

describe('Adaptive Manager Synthesis & Context Ceiling Protection (synthesisPipeline.ts)', () => {
    function createMockAgent(role: string, provider: string, model: string = 'mock-model') {
        const agent = new Agent(role, model, provider as any, 'mock-key');
        return agent;
    }

    it('automatically applies recursive reduction when compiled analyst reports exceed provider context ceiling', () => {
        const manager = createMockAgent('Executive Manager', 'groq', 'llama-3.3-70b-versatile');
        const analysts = [
            createMockAgent('Database Specialist', 'groq'),
            createMockAgent('Security Analyst', 'groq'),
            createMockAgent('Performance Engineer', 'groq'),
            createMockAgent('Network Architect', 'groq')
        ];

        // Generate 20 large reports across specialists (5 chunks per specialist, ~1000 tokens per chunk)
        const allAnalystReports: any[][] = analysts.map((analyst) => {
            const reports = [];
            for (let c = 0; c < 5; c++) {
                reports.push({
                    _chunkIndex: c,
                    role: analyst.role,
                    insights: [
                        `High volume telemetry finding for chunk ${c}: ` + 'repeated_metric_pattern_'.repeat(50),
                        `Secondary pattern observation chunk ${c}: ` + 'telemetry_drift_evidence_'.repeat(40)
                    ],
                    anomalies: c % 2 === 0 ? [`Anomaly detected in chunk ${c}: Memory spike above threshold`] : [],
                    summary: `Executive summary of chunk ${c} evaluation for ${analyst.role}: ` + 'detailed_summary_data_'.repeat(50)
                });
            }
            return reports;
        });

        const clusterDigests: Record<string, ClusterDigest> = {
            'data-cluster': {
                clusterId: 'data-cluster',
                specialistCount: 2,
                specialistRoles: ['Database Specialist', 'Security Analyst'],
                keyFindings: ['Sustained write load', 'Token saturation warning'],
                anomalies: ['Memory spike at chunk 2'],
                summary: 'Aggregated findings from data cluster specialists.',
                originalTokensEstimate: 1000,
                compressedTokensEstimate: 400,
                tokenReductionRatio: 0.6
            }
        };

        const context = new SwarmContext();

        // Call compileSynthesisPrompt WITHOUT explicit compressionSettings.enabled
        const result = compileSynthesisPrompt({
            task: 'Synthesize 20-chunk high-volume telemetry audit',
            rawInput: '',
            analysts,
            managerAgent: manager,
            allAnalystReports,
            clusterDigests,
            historicalContext: 'Historical baseline: 99.9% uptime, average p95 120ms.',
            context,
            params: { task: 'Synthesize 20-chunk high-volume telemetry audit' },
            bypassCache: false
        });

        const promptTokens = Math.ceil(result.effectiveDynamicPrompt.length / 4);

        // For Groq manager (ceiling ~6,000 tokens), prompt must automatically fit under the safe ceiling
        expect(promptTokens).toBeLessThanOrEqual(6000);

        // Reduction must have saved tokens automatically
        expect(result.workflowPromptTokensSaved).toBeGreaterThan(0);

        // Critical cluster digest anomalies and findings must be retained
        expect(result.effectiveDynamicPrompt).toContain('Memory spike at chunk 2');
        expect(result.effectiveDynamicPrompt).toContain('Sustained write load');
    });

    it('enforces fail-safe prompt trimming in executeManagerSynthesis before calling provider', async () => {
        const manager = createMockAgent('Executive Manager', 'groq', 'llama-3.3-70b-versatile');
        const context = new SwarmContext();

        let interceptedPrompt = '';
        vi.spyOn(manager, 'run').mockImplementation(async (prompt: string) => {
            interceptedPrompt = prompt;
            return {
                ui_title: 'Manager Synthesis',
                summary: 'Synthesis successful'
            };
        });

        // Massive 80,000-character prompt (~20,000 tokens)
        const massivePrompt = 'Task:\n<user_task>\nAnalyze telemetry\n</user_task>\n' + 'huge_report_block_'.repeat(4000);

        await executeManagerSynthesis(manager, massivePrompt, context);

        expect(interceptedPrompt).toBeDefined();
        const interceptedTokens = Math.ceil(interceptedPrompt.length / 4);

        // Groq safe input budget is <= 6000 tokens; prompt must be trimmed to avoid 400 context_length_exceeded
        expect(interceptedTokens).toBeLessThanOrEqual(6000);
        expect(interceptedPrompt).toContain('[trimmed for manager context ceiling]');
    });
});
