import { describe, it, expect } from 'vitest';
import {
    TokenEstimator,
    SemanticDeduplicator,
    TokenAwarePromptCompressor,
    globalPromptCompressor,
    type PromptSegment
} from './compression.ts';

describe('TokenEstimator', () => {
    it('returns 0 for empty or null-like strings', () => {
        expect(TokenEstimator.countTokens('')).toBe(0);
        expect(TokenEstimator.countTokens('   ')).toBe(0);
    });

    it('estimates tokens for standard prose and technical strings', () => {
        const text = 'The quick brown fox jumps over the lazy dog.';
        const tokens = TokenEstimator.countTokens(text);
        expect(tokens).toBeGreaterThan(5);
        expect(tokens).toBeLessThan(15);
    });

    it('assigns higher token weight to punctuation, code symbols, and JSON', () => {
        const prose = 'database transaction commit success';
        const code = '{"db":{"tx":"commit","status":200}}';
        const proseTokens = TokenEstimator.countTokens(prose);
        const codeTokens = TokenEstimator.countTokens(code);
        // Code with brackets and quotes should have dense tokenization relative to length
        expect(codeTokens).toBeGreaterThanOrEqual(proseTokens);
    });

    it('truncates text to fit within token budgets', () => {
        const longText = 'Paragraph with extensive analysis details repeated multiple times. '.repeat(10);
        const maxTokens = 15;
        const truncated = TokenEstimator.truncateToTokens(longText, maxTokens);
        expect(TokenEstimator.countTokens(truncated)).toBeLessThanOrEqual(maxTokens + 2);
        expect(truncated.endsWith('...')).toBe(true);
    });
});

describe('SemanticDeduplicator', () => {
    it('tokenizes text filtering stopwords while retaining technical keywords', () => {
        const text = 'The latency has spiked on node-3 due to excessive lock contention';
        const tokens = SemanticDeduplicator.tokenize(text);
        expect(tokens).toContain('latency');
        expect(tokens).toContain('spik');
        expect(tokens).toContain('node-3');
        expect(tokens).not.toContain('the');
        expect(tokens).not.toContain('to');
    });

    it('computes exact match similarity as 1.0', () => {
        const a = 'Critical buffer overflow detected in auth service';
        expect(SemanticDeduplicator.computeSemanticSimilarity(a, a)).toBe(1.0);
    });

    it('computes high similarity for paraphrased or overlapping findings', () => {
        const a = 'High memory usage reached 94% on worker node 2 during peak load';
        const b = 'Worker node 2 experienced high memory usage of 94% under peak traffic';
        const sim = SemanticDeduplicator.computeSemanticSimilarity(a, b);
        expect(sim).toBeGreaterThanOrEqual(0.70);
    });

    it('computes low similarity for completely unrelated domain statements', () => {
        const a = 'PostgreSQL database query latency increased by 35ms';
        const b = 'User interface button styling does not match design tokens';
        const sim = SemanticDeduplicator.computeSemanticSimilarity(a, b);
        expect(sim).toBeLessThan(0.35);
    });

    it('deduplicates segments and merges source attribution', () => {
        const segments: PromptSegment[] = [
            {
                id: 'seg-1',
                text: 'High latency observed on API gateway during batch ingestion',
                priority: 'medium',
                source: 'Performance Analyst',
                sources: ['Performance Analyst'],
                tokenCount: 10
            },
            {
                id: 'seg-2',
                text: 'API gateway experienced high latency during batch data ingestion',
                priority: 'medium',
                source: 'Reliability Analyst',
                sources: ['Reliability Analyst'],
                tokenCount: 10
            },
            {
                id: 'seg-3',
                text: 'Authentication token expiration time is set to 3600 seconds',
                priority: 'medium',
                source: 'Security Analyst',
                sources: ['Security Analyst'],
                tokenCount: 8
            }
        ];

        const result = SemanticDeduplicator.deduplicateSegments(segments, 0.70);
        const deduplicated = result.filter(s => s.isDeduplicated);
        const kept = result.filter(s => !s.isDeduplicated);

        expect(deduplicated.length).toBe(1);
        expect(kept.length).toBe(2);

        // Kept segment should now have merged sources from both analysts
        const mergedSeg = kept.find(s => s.id === 'seg-1');
        expect(mergedSeg).toBeDefined();
        expect(mergedSeg?.sources).toContain('Performance Analyst');
        expect(mergedSeg?.sources).toContain('Reliability Analyst');
    });

    it('does not deduplicate critical segments even if similar', () => {
        const segments: PromptSegment[] = [
            {
                id: 'crit-1',
                text: 'Critical error: Database connection pool exhausted',
                priority: 'critical',
                sources: ['DBA'],
                tokenCount: 8
            },
            {
                id: 'crit-2',
                text: 'Critical error: Database connection pool exhausted',
                priority: 'critical',
                sources: ['Monitor'],
                tokenCount: 8
            }
        ];

        const result = SemanticDeduplicator.deduplicateSegments(segments, 0.75);
        const kept = result.filter(s => !s.isDeduplicated);
        expect(kept.length).toBe(2);
    });
});

describe('TokenAwarePromptCompressor', () => {
    it('handles empty and whitespace prompts gracefully', () => {
        const compressor = new TokenAwarePromptCompressor();
        const res = compressor.compress('');
        expect(res.originalTokens).toBe(0);
        expect(res.compressedTokens).toBe(0);
        expect(res.reductionRatio).toBe(0);
        expect(res.compressedText).toBe('');
    });

    it('cuts context tokens by 30-50% on multi-agent repetitive prompts', () => {
        const compressor = new TokenAwarePromptCompressor({
            targetReductionRatio: 0.40,
            similarityThreshold: 0.70
        });

        const bloatedPrompt = `Task: Synthesize swarm findings for system outage
Historical Baselines:
Baseline 1: Standard response time under 200ms.
Baseline 2: Memory threshold is 80%.

Analyst Reports:
[Performance Specialist Report]:
Based on the provided data, we observed that high CPU utilization reached 96% on node 4 during traffic spike.
Furthermore, it is important to note that memory consumption exceeded the threshold at 88%.
In conclusion, the system was heavily strained.

[Reliability Specialist Report]:
Upon careful investigation, node 4 experienced high CPU utilization reaching 96% during the traffic spike.
Additionally, memory consumption was measured at 88% exceeding normal operational thresholds.
As an expert analyst, we recommend horizontal pod autoscaling.

[Security Specialist Report]:
In summary, no external attack vectors or authentication failures were detected.
High CPU utilization was observed at 96% on node 4 during the traffic spike.
`;

        const result = compressor.compress(bloatedPrompt);

        expect(result.originalTokens).toBeGreaterThan(120);
        expect(result.compressedTokens).toBeLessThan(result.originalTokens);
        expect(result.reductionRatio).toBeGreaterThanOrEqual(0.30);
        expect(result.tokensSaved).toBeGreaterThan(30);
        expect(result.deduplicatedSegmentsCount).toBeGreaterThan(0);

        // Core task and essential metrics must remain intact
        expect(result.compressedText).toContain('Task:');
        expect(result.compressedText).toContain('96%');
        expect(result.compressedText).toContain('node 4');
    });

    it('preserves code blocks and schema constraints verbatim', () => {
        const compressor = new TokenAwarePromptCompressor();
        const prompt = `Task: Process data
Constraint: Must adhere to schema
\`\`\`json
{
  "status": "success",
  "data": [1, 2, 3]
}
\`\`\`
More text...`;

        const result = compressor.compress(prompt);
        expect(result.compressedText).toContain('```json');
        expect(result.compressedText).toContain('"status": "success"');
        expect(result.compressedText).toContain('```');
    });

    it('preserves anomalies and alerts with critical priority', () => {
        const compressor = new TokenAwarePromptCompressor({
            preserveAnomalies: true,
            targetReductionRatio: 0.50
        });

        const prompt = `Task: Analyze logs
Normal line 1: Routine ping check successful
Critical anomaly: Heartbeat dropped and node-5 was marked fatal
Normal line 2: Garbage collection completed
Normal line 3: Worker resumed normal polling`;

        const result = compressor.compress(prompt);
        expect(result.compressedText).toContain('Critical anomaly: Heartbeat dropped and node-5 was marked fatal');
    });

    it('strips conversational filler and boilerplate phrases', () => {
        const compressor = new TokenAwarePromptCompressor({ stripBoilerplate: true });
        const prompt = `Task: Analyze report
Based on the provided data, the server restarted at midnight.
In conclusion, no errors were recorded.`;

        const result = compressor.compress(prompt);
        expect(result.compressedText).not.toContain('Based on the provided data,');
        expect(result.compressedText).not.toContain('In conclusion,');
        expect(result.compressedText.toLowerCase()).toContain('the server restarted at midnight');
    });

    it('enforces maxTokens hard cap', () => {
        const compressor = new TokenAwarePromptCompressor({ maxTokens: 40 });
        const longPrompt = `Task: Analyze architecture
${'Secondary explanation line detailing background system architecture and history. '.repeat(10)}
Final summary.`;

        const result = compressor.compress(longPrompt);
        expect(result.compressedTokens).toBeLessThanOrEqual(45);
    });

    it('compressAnalystReports coalesces cross-specialist findings with attribution', () => {
        const reports = [
            {
                role: 'Database Specialist',
                content: 'Based on the provided metrics, connection pool saturation reached 100% causing latency spikes.\nQuery cache misses elevated across read replicas.\nFurthermore, it is important to note that memory consumption exceeded 85%.\nIn conclusion, database nodes are overloaded.'
            },
            {
                role: 'Infrastructure Specialist',
                content: 'Upon careful investigation, connection pool saturation was at 100% resulting in high latency spikes.\nPod CPU throttling occurred on cluster workers.\nFurthermore, memory consumption exceeded 85% across workers.\nIn summary, infrastructure needs scaling.'
            },
            {
                role: 'Security Specialist',
                content: 'In conclusion, TLS certificates are valid until December 2027.'
            }
        ];

        const res = globalPromptCompressor.compressAnalystReports(reports, {
            similarityThreshold: 0.70
        });

        expect(res.reductionRatio).toBeGreaterThan(0.10);
        expect(res.deduplicatedSegmentsCount).toBeGreaterThanOrEqual(1);
        expect(res.compressedReportsText).toContain('Database Specialist & Infrastructure Specialist');
        expect(res.compressedReportsText).toContain('TLS certificates');
    });
});
