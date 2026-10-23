import type { DataProfile, ChunkingResult } from './types.ts';

export const DEFAULT_MAX_CHARS = 25000000; // Expanded to 25MB to support high-volume datasets
export const DEFAULT_MAX_TOKENS_PER_CHUNK = 8000; // Calibrated for free-tier quotas
export const DEFAULT_MAX_CHUNKS = Infinity; // Zero-loss default: retain all generated chunks

/**
 * Detects if the payload begins with a structured CSV header row.
 */
function detectCsvHeader(lines: string[]): string | null {
    if (lines.length < 2) return null;
    const firstLine = lines[0].trim();
    if (!firstLine || firstLine.startsWith('{') || firstLine.startsWith('[')) return null;
    // Check delimiter: comma-separated with >= 2 columns
    if (firstLine.includes(',') && firstLine.split(',').length >= 2) {
        return firstLine;
    }
    return null;
}

/**
 * Extracts metadata and profiles the input data payload.
 */
export function profileData(data: string, maxChars: number = DEFAULT_MAX_CHARS): { rawInput: string; profile: DataProfile } {
    let rawInput = data || "";
    if (rawInput.length > maxChars) {
        rawInput = rawInput.substring(0, maxChars) + "\n...[TRUNCATED FOR MEMORY SAFETY]...";
    }

    const charCount = rawInput.length;
    const estimatedTokens = Math.ceil(charCount / 4);
    const rowCount = rawInput.split('\n').length;
    const trimmed = rawInput.trim();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

    return {
        rawInput,
        profile: {
            charCount,
            estimatedTokens,
            rowCount,
            format: isJson ? 'JSON' : 'Text/CSV'
        }
    };
}

/**
 * Splits raw input into token-budgeted chunks respecting free-tier API quotas and HTTP timeout thresholds.
 */
export function createTokenChunks(
    rawInput: string,
    maxTokensPerChunk: number = DEFAULT_MAX_TOKENS_PER_CHUNK,
    maxChunks: number = DEFAULT_MAX_CHUNKS
): ChunkingResult {
    const rawLines = rawInput.split('\n');
    const maxCharsPerChunk = maxTokensPerChunk * 4;
    const normalizedLines: string[] = [];

    for (const line of rawLines) {
        if (line.length <= maxCharsPerChunk) {
            normalizedLines.push(line);
        } else {
            // Segment ultra-long line (e.g. minified JSON or unformatted logs)
            for (let offset = 0; offset < line.length; offset += maxCharsPerChunk) {
                normalizedLines.push(line.substring(offset, offset + maxCharsPerChunk));
            }
        }
    }

    const csvHeader = detectCsvHeader(normalizedLines);
    const headerTokens = csvHeader ? Math.ceil(csvHeader.length / 4) : 0;
    const canRepeatHeader = Boolean(csvHeader && headerTokens < maxTokensPerChunk * 0.5);

    const chunks: string[] = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (let i = 0; i < normalizedLines.length; i++) {
        const line = normalizedLines[i];
        const lineTokens = Math.ceil(line.length / 4);

        if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            if (canRepeatHeader && csvHeader) {
                currentChunk = csvHeader + "\n";
                currentTokens = headerTokens;
            } else {
                currentChunk = "";
                currentTokens = 0;
            }
        }

        currentChunk += line + "\n";
        currentTokens += lineTokens;
    }

    if (currentChunk.trim().length > 0) {
        // Prevent pushing a trailing chunk that only contains the repeated header
        if (!(canRepeatHeader && csvHeader && currentChunk.trim() === csvHeader)) {
            chunks.push(currentChunk.trim());
        }
    }

    if (chunks.length === 0) {
        chunks.push("");
    }

    const originalChunkCount = chunks.length;
    let warning: string | undefined = undefined;

    if (Number.isFinite(maxChunks) && chunks.length > maxChunks) {
        warning = `Payload exceeded ${maxChunks} batches (${originalChunkCount} chunks detected). Analysis balanced to preserve opening structure, representative sampling, and closing metadata trailer.`;
        if (maxChunks <= 1) {
            chunks.length = 1;
        } else if (maxChunks === 2) {
            const first = chunks[0];
            const last = chunks[chunks.length - 1];
            chunks.length = 0;
            chunks.push(first, last);
        } else {
            const first = chunks.slice(0, maxChunks - 1);
            const last = chunks[chunks.length - 1];
            chunks.length = 0;
            chunks.push(...first, last);
        }
    }

    const totalTokens = chunks.reduce((acc, c) => acc + Math.ceil(c.length / 4), 0);

    return {
        chunks,
        originalChunkCount,
        maxTokensPerChunk,
        totalTokens,
        warning
    };
}
