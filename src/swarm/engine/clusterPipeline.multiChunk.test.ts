import { describe, it, expect, beforeEach } from 'vitest';
import { executeSwarmWorkflow } from './index.ts';
import { ProviderRegistry } from '../providers/registry.ts';

describe('Prevent Analyst Dropping on Multi-Chunk (clusterPipeline.ts)', () => {
    const executedRoles: string[] = [];

    beforeEach(() => {
        executedRoles.length = 0;
        ProviderRegistry.register({
            providerName: 'mock-multichunk',
            async call(options) {
                const prompt = options.prompt || '';
                if (options.systemInstruction?.includes('Manager') || prompt.includes('Analyst Reports:')) {
                    return JSON.stringify({
                        ui_title: 'Multi-Chunk Synthesis Dashboard',
                        components: [
                            {
                                id: 'summary-card',
                                type: 'MetricCard',
                                props: { title: 'Status', value: 'Complete' }
                            }
                        ]
                    });
                }

                if (options.role) {
                    executedRoles.push(options.role);
                }

                return JSON.stringify({
                    insights: [`Analysis from ${options.role}`],
                    anomalies: [],
                    summary: `Report for ${options.role}`
                });
            }
        });
    });

    it('ensures all active analysts evaluate distributed chunks with minimum 1 execution per analyst when analysts > chunks', async () => {
        // Multi-chunk dataset (triggers chunking)
        const chunk1 = 'Line item database record telemetry status ok\n'.repeat(500);
        const chunk2 = 'Line item network throughput telemetry status ok\n'.repeat(500);
        const data = `${chunk1}\n${chunk2}`;

        const result = await executeSwarmWorkflow({
            task: 'Analyze multi-chunk system telemetry',
            data,
            forceFullSwarm: true,
            settings: {
                speculativeParallel: true,
                maxSpeculativeConcurrency: 4,
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-1', role: 'Database Specialist', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-2', role: 'Network Specialist', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-3', role: 'Security Analyst', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-4', role: 'Performance Engineer', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();

        const analystRoles = executedRoles.filter(r => r !== 'Manager Node');
        expect(analystRoles).toContain('Database Specialist');
        expect(analystRoles).toContain('Network Specialist');
        expect(analystRoles).toContain('Security Analyst');
        expect(analystRoles).toContain('Performance Engineer');
        expect(new Set(analystRoles).size).toBe(4);
    });

    it('ensures all active analysts execute in scheduled mode as well', async () => {
        const chunk1 = 'Line item database record telemetry status ok\n'.repeat(500);
        const chunk2 = 'Line item network throughput telemetry status ok\n'.repeat(500);
        const data = `${chunk1}\n${chunk2}`;

        const result = await executeSwarmWorkflow({
            task: 'Analyze multi-chunk scheduled execution',
            data,
            forceFullSwarm: true,
            settings: {
                speculativeParallel: false,
                schedulingSettings: {
                    enabled: true,
                    strategy: 'work-stealing',
                    maxConcurrency: 4,
                    enableRateLimiting: false
                },
                agents: [
                    { id: 'mgr', role: 'Manager Node', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-1', role: 'Database Specialist', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-2', role: 'Network Specialist', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' },
                    { id: 'analyst-3', role: 'Security Analyst', provider: 'mock-multichunk', model: 'mock-v1', apiKey: 'k-mock' }
                ]
            }
        });

        expect(result.finalAnalysis).toBeDefined();
        const analystRoles = executedRoles.filter(r => r !== 'Manager Node');
        expect(analystRoles).toContain('Database Specialist');
        expect(analystRoles).toContain('Network Specialist');
        expect(analystRoles).toContain('Security Analyst');
        expect(new Set(analystRoles).size).toBe(3);
    });
});
