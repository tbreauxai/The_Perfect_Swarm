import { describe, it, expect } from 'vitest';
import { compileSynthesisPrompt } from './synthesisPipeline.ts';
import { TokenEstimator } from '../compression/tokenEstimator.ts';
import { Agent } from '../agent.ts';
import { SwarmContext } from '../context.ts';
import { globalHierarchicalMessageBus, type ClusterDigest, type SpecialistReportInput } from '../communication.ts';

describe('Hierarchical Map-Reduce Synthesis & Root Ceiling Capping (Goal 6 / AC-05)', () => {
    it('synthesizes 20 chunk reports into intermediate digests keeping root manager input < 4,000 tokens', () => {
        const managerAgent = new Agent('Manager Node', 'gemini-2.5-flash', 'gemini', 'test-key');
        const analyst1 = new Agent('Database Specialist', 'gemini-2.5-flash', 'gemini', 'test-key');
        const analyst2 = new Agent('Security Auditor', 'gemini-2.5-flash', 'gemini', 'test-key');
        const analysts = [analyst1, analyst2];

        // Generate 20 large chunk reports (10 per analyst, each with dense findings and summaries)
        const allAnalystReports: any[][] = [[], []];
        const reports1: any[] = [];
        const reports2: any[] = [];

        for (let i = 0; i < 10; i++) {
            reports1.push({
                _chunkIndex: i,
                insights: [
                    `Database chunk ${i} high cardinality indexing anomaly on table user_sessions_${i}`,
                    `Query execution latency spike detected at ${100 + i * 15}ms during batch iteration ${i}`
                ],
                anomalies: [`Deadlock contention on shard cluster replica ${i}`],
                summary: `Detailed analysis of database telemetry segment ${i} showing memory allocation growth and pool exhaustion.`
            });

            reports2.push({
                _chunkIndex: i + 10,
                insights: [
                    `Security chunk ${i} token expiration policy violation detected on scope auth_v2_${i}`,
                    `Suspicious IP burst pattern matching credential stuffing CVE-2026-${1000 + i}`
                ],
                anomalies: [`Unencrypted sensitive token header logged in trace_${i}`],
                summary: `Security inspection for payload segment ${i} analyzing authorization headers, bearer tokens, and audit trails.`
            });
        }
        allAnalystReports[0] = reports1;
        allAnalystReports[1] = reports2;

        // Construct 2-tier intermediate cluster digests (batch size 4 -> 5 intermediate digests)
        const clusterDigests: Record<string, ClusterDigest> = {};
        const flattenedInputs: SpecialistReportInput[] = [
            ...reports1.map(r => ({ specialistRole: analyst1.role, insights: r.insights, anomalies: r.anomalies, summary: r.summary })),
            ...reports2.map(r => ({ specialistRole: analyst2.role, insights: r.insights, anomalies: r.anomalies, summary: r.summary }))
        ];

        const batchSize = 4;
        let subIndex = 1;
        for (let b = 0; b < flattenedInputs.length; b += batchSize) {
            const batch = flattenedInputs.slice(b, b + batchSize);
            const digestId = `tier1-submanager-${subIndex++}`;
            clusterDigests[digestId] = globalHierarchicalMessageBus.aggregateClusterReports(digestId, batch);
        }

        expect(Object.keys(clusterDigests).length).toBe(5);

        const context = new SwarmContext();
        const task = 'Synthesize distributed security and database metrics across 20 telemetry partitions';
        const result = compileSynthesisPrompt({
            task,
            rawInput: '',
            analysts,
            managerAgent,
            allAnalystReports,
            clusterDigests,
            historicalContext: 'Historical baseline: average query latency 45ms, zero auth violations.',
            context,
            params: { task },
            bypassCache: false
        });

        // AC-05: Root manager prompt strictly does not exceed 4,000 tokens
        const estimatedTokens = TokenEstimator.estimatePayloadTokens(result.effectiveDynamicPrompt);
        expect(estimatedTokens).toBeLessThan(4000);

        // Verify root manager prompt synthesizes intermediate digests and does NOT dump 20 raw chunk outputs
        expect(result.effectiveDynamicPrompt).toContain('Cluster Digests:');
        expect(result.effectiveDynamicPrompt).toContain('[Hierarchical Map-Reduce]');
        expect(result.effectiveDynamicPrompt).not.toContain('--- Chunk 19 ---');
    });

    it('preserves standard raw chunk compilation when chunk count <= 6', () => {
        const managerAgent = new Agent('Manager Node', 'gemini-2.5-flash', 'gemini', 'test-key');
        const analyst1 = new Agent('Analyst', 'gemini-2.5-flash', 'gemini', 'test-key');

        const allAnalystReports = [[
            { _chunkIndex: 0, insights: ['Short insight A'], summary: 'Summary A' },
            { _chunkIndex: 1, insights: ['Short insight B'], summary: 'Summary B' }
        ]];

        const context = new SwarmContext();
        const task = 'Small 2-chunk analysis';
        const result = compileSynthesisPrompt({
            task,
            rawInput: '',
            analysts: [analyst1],
            managerAgent,
            allAnalystReports,
            clusterDigests: {},
            historicalContext: 'None',
            context,
            params: { task },
            bypassCache: false
        });

        expect(result.effectiveDynamicPrompt).toContain('--- Chunk 1 ---');
        expect(result.effectiveDynamicPrompt).toContain('--- Chunk 2 ---');
        expect(result.effectiveDynamicPrompt).not.toContain('[Hierarchical Map-Reduce]');
    });
});
