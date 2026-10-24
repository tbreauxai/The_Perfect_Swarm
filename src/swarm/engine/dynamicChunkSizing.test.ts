import { describe, it, expect } from 'vitest';
import { getProviderChunkLimits, fitChunkToProvider } from './analystExecution.ts';
import { partitionChunkForProvider } from './clusterPipeline.ts';
import { TokenEstimator } from '../compression/tokenEstimator.ts';

describe('Module 3: Dynamic Provider-Aware Chunk Sizing', () => {
    it('calculates provider-specific chunk limits correctly', () => {
        const groqLimits = getProviderChunkLimits('groq');
        expect(groqLimits.maxInputTokens).toBe(1500);
        expect(groqLimits.targetChunkTokens).toBe(1125); // 1500 * 0.75

        const geminiLimits = getProviderChunkLimits('gemini');
        expect(geminiLimits.maxInputTokens).toBe(8000);
        expect(geminiLimits.targetChunkTokens).toBe(6000); // min(8000 * 0.75, 6000)

        const mistralLimits = getProviderChunkLimits('mistral');
        expect(mistralLimits.maxInputTokens).toBe(2000);
        expect(mistralLimits.targetChunkTokens).toBe(1500); // 2000 * 0.75

        const nvidiaLimits = getProviderChunkLimits('nvidia');
        expect(nvidiaLimits.maxInputTokens).toBe(8000);
        expect(nvidiaLimits.targetChunkTokens).toBe(6000); // min(8000 * 0.75, 6000)
    });

    it('AC-04: Dynamic Chunk Allocation - Groq chunks never exceed 1,500 tokens; Gemini chunks utilize up to 6,000 tokens', () => {
        // Create a large 4,000 token structured payload
        const lines: string[] = [];
        for (let i = 0; i < 200; i++) {
            lines.push(`{"recordId": ${i}, "metric": "cpu_utilization", "node": "worker-node-${i % 8}", "load": ${(Math.random() * 100).toFixed(2)}, "timestamp": 1774392800000}`);
        }
        const largePayload = lines.join('\n');
        const payloadTokens = TokenEstimator.estimatePayloadTokens(largePayload);
        expect(payloadTokens).toBeGreaterThan(3500);

        // 1. Fit to Groq
        const groqChunk = fitChunkToProvider(largePayload, 'groq', 1, 0, 500);
        const groqTokens = TokenEstimator.estimatePayloadTokens(groqChunk);
        expect(groqTokens).toBeLessThanOrEqual(1500);

        // 2. Fit to Gemini
        const geminiChunk = fitChunkToProvider(largePayload, 'gemini', 1, 0, 500);
        const geminiTokens = TokenEstimator.estimatePayloadTokens(geminiChunk);
        // Gemini should retain the full 4,000 tokens without truncation because 4000 <= 6000
        expect(geminiTokens).toBeGreaterThan(3500);
        expect(geminiTokens).toBeLessThanOrEqual(6000);
    });

    it('partitionChunkForProvider splits large payloads for constrained providers and preserves intact for large providers', () => {
        const lines: string[] = [];
        for (let i = 0; i < 150; i++) {
            lines.push(`Log entry ${i}: user authentication event with payload details and session token abcdef1234567890`);
        }
        const input = lines.join('\n');
        const totalTokens = TokenEstimator.estimatePayloadTokens(input);
        expect(totalTokens).toBeGreaterThan(2000);

        // Partition for Groq (target 1,125 tokens)
        const groqParts = partitionChunkForProvider(input, 'groq');
        expect(groqParts.length).toBeGreaterThan(1);
        for (const part of groqParts) {
            const partTokens = TokenEstimator.estimatePayloadTokens(part);
            expect(partTokens).toBeLessThanOrEqual(1500);
        }

        // Partition for Gemini (target 6,000 tokens)
        const geminiParts = partitionChunkForProvider(input, 'gemini');
        expect(geminiParts.length).toBe(1);
        expect(geminiParts[0]).toBe(input);
    });
});
