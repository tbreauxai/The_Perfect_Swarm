import { describe, it, expect } from 'vitest';
import { createTokenChunks, profileData } from './profiler';

describe('Token Budget & Metadata Chunk Preservation', () => {
    it('creates token chunks with expanded capacity (up to 8 chunks by default)', () => {
        // Generate a large payload that exceeds 4 chunks
        const longLine = 'data_row_key_value_metric_item_telemetry_indicator_'.repeat(100); // ~5000 chars = ~1250 tokens per line
        const lines: string[] = [];
        for (let i = 0; i < 40; i++) {
            lines.push(`Line ${i}: ${longLine}`);
        }
        const largePayload = lines.join('\n');

        const result = createTokenChunks(largePayload);

        // Under expanded capacity, it should support more than 4 chunks without immediately truncating to 4
        expect(result.chunks.length).toBeGreaterThan(4);
        expect(result.chunks.length).toBeLessThanOrEqual(8);
        expect(result.originalChunkCount).toBeGreaterThanOrEqual(result.chunks.length);
    });

    it('preserves metadata from beginning and end of deep payloads when maxChunks is reached', () => {
        // Generate a deep payload where important summary metadata is at the end
        const lines: string[] = [];
        lines.push('START_METADATA_HEADER: Initial schema setup');
        for (let i = 0; i < 60; i++) {
            lines.push(`Row ${i}: ` + 'repeated_data_metrics_log_entry_'.repeat(80));
        }
        lines.push('END_METADATA_TRAILER: Critical performance summary at end of file');
        const deepPayload = lines.join('\n');

        // With maxChunks = 4, the critical end metadata trailer must not be discarded
        const result = createTokenChunks(deepPayload, 2000, 4);

        expect(result.chunks.length).toBe(4);
        const combinedContent = result.chunks.join('\n');
        expect(combinedContent).toContain('START_METADATA_HEADER');
        expect(combinedContent).toContain('END_METADATA_TRAILER');
    });
});
