import { describe, it, expect } from 'vitest';
import {
    extractAnalystConsensus,
    extractAnalystInsights,
    renderPromptConsensusBlock,
    type AnalystConsensusDigest
} from './consensusPipeline.ts';
import { Agent } from '../agent.ts';

describe('Consensus Pipeline & Disagreement Arbitration', () => {
    const mockAnalyst1 = new Agent('Performance Analyst', 'mock-model', 'gemini', 'key');
    const mockAnalyst2 = new Agent('Security Analyst', 'mock-model', 'groq', 'key');
    const mockAnalyst3 = new Agent('Reliability Analyst', 'mock-model', 'openrouter', 'key');

    it('handles empty reports gracefully', () => {
        const digest = extractAnalystConsensus([], [], 'Analyze server metrics');
        expect(digest.totalAnalysts).toBe(0);
        expect(digest.consensusScore).toBe(1.0);
        expect(digest.agreementLevel).toBe('strong');
        expect(digest.majorityFindings).toEqual([]);
        expect(digest.dissentingOpinions).toEqual([]);
    });

    it('handles a single analyst report correctly', () => {
        const reports = [
            [{ insights: ['Latency increased by 25% due to DB pool exhaustion', 'Cache hit rate stable at 89%'] }]
        ];
        const digest = extractAnalystConsensus(reports, [mockAnalyst1], 'Check latency');
        expect(digest.totalAnalysts).toBe(1);
        expect(digest.consensusScore).toBe(1.0);
        expect(digest.confidenceScore).toBeGreaterThanOrEqual(0.85);
        expect(digest.majorityFindings.length).toBe(2);
        expect(renderPromptConsensusBlock(digest)).toBe(''); // No inter-analyst prompt block needed for single agent
    });

    it('identifies unanimous and majority findings across multiple specialists', () => {
        const reports = [
            // Analyst 1
            [{
                insights: [
                    'Database query timeout spike observed at 14:00 UTC',
                    'Worker thread pool saturation caused 504 Gateway Timeouts',
                    'Revenue metrics remain constant and unaffected'
                ],
                anomalies: ['Unusual connection spike on postgres port 5432']
            }],
            // Analyst 2
            [{
                insights: [
                    'Database query timeouts spiked near 14:00 UTC',
                    'Worker thread saturation triggered 504 Gateway Timeout errors',
                    'Daily revenue steady and unaffected by database glitch'
                ],
                findings: ['Postgres connection pool maxed at 100 concurrent clients']
            }],
            // Analyst 3
            [{
                insights: [
                    'Database query timeout spike occurred at 14:00 UTC',
                    'Worker thread saturation observed in microservice cluster',
                    'Isolated memory leak anomaly detected in node worker pod 3'
                ]
            }]
        ];

        const digest = extractAnalystConsensus(
            reports,
            [mockAnalyst1, mockAnalyst2, mockAnalyst3],
            'Diagnose system outage at 14:00'
        );

        expect(digest.totalAnalysts).toBe(3);
        expect(digest.consensusScore).toBeGreaterThan(0.60);
        expect(digest.agreementLevel).toBe('strong');
        expect(digest.confidenceScore).toBeGreaterThan(0.80);

        // Verify majority/unanimous findings contain the timeout and thread saturation
        const allAccepted = [...digest.unanimousFindings, ...digest.majorityFindings].join(' ').toLowerCase();
        expect(allAccepted).toContain('database');
        expect(allAccepted).toContain('timeout');
        expect(allAccepted).toContain('worker thread');

        // Verify dissenting opinion captures the memory leak flagged only by Analyst 3
        expect(digest.dissentingOpinions.length).toBeGreaterThan(0);
        const dissentStr = digest.dissentingOpinions.join(' ').toLowerCase();
        expect(dissentStr).toContain('memory leak');

        // Verify rendered prompt block formatting
        const promptBlock = renderPromptConsensusBlock(digest);
        expect(promptBlock).toContain('[Cross-Analyst Consensus & Arbitration');
        expect(promptBlock).toContain('Unanimous Consensus');
        expect(promptBlock).toContain('Directives: Give highest synthesis weight');
    });

    it('detects divergent opinions when analysts reach conflicting conclusions', () => {
        const reports = [
            [{ insights: ['System is completely healthy with 0 errors and optimal latency'] }],
            [{ insights: ['Catastrophic security breach detected with leaked credentials'] }],
            [{ insights: ['Network hardware switch failure in US-East data center'] }]
        ];

        const digest = extractAnalystConsensus(
            reports,
            [mockAnalyst1, mockAnalyst2, mockAnalyst3],
            'System health check'
        );

        expect(digest.totalAnalysts).toBe(3);
        expect(digest.consensusScore).toBeLessThan(0.45);
        expect(digest.agreementLevel).toBe('divergent');
        expect(digest.confidenceScore).toBeLessThanOrEqual(0.60);
    });

    it('extractAnalystInsights parses raw strings and objects safely', () => {
        const mixed = [
            'Single standalone insight string',
            {
                insights: ['Structured insight A', 'Structured insight B'],
                anomalies: ['High CPU spike'],
                findings: ['Normal disk I/O'],
                summary: 'Overall operations stable'
            },
            null,
            undefined
        ];

        const extracted = extractAnalystInsights(mixed);
        expect(extracted).toContain('Single standalone insight string');
        expect(extracted).toContain('Structured insight A');
        expect(extracted).toContain('[Anomaly] High CPU spike');
        expect(extracted).toContain('Normal disk I/O');
        expect(extracted).toContain('Overall operations stable');
    });
});
