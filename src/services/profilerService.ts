export interface DataProfile {
    charCount: number;
    estimatedTokens: number;
    rowCount: number;
    format: 'JSON' | 'Text/CSV';
}

export interface ChunkingResult {
    chunks: string[];
    originalChunkCount: number;
    maxTokensPerChunk: number;
    totalTokens: number;
    warning?: string;
}

const DEFAULT_MAX_CHARS = 500000;
const DEFAULT_MAX_TOKENS_PER_CHUNK = 12000;
const DEFAULT_MAX_CHUNKS = 2;

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
 * Splits raw input into token-budgeted chunks respecting HTTP timeout thresholds.
 */
export function createTokenChunks(
    rawInput: string,
    maxTokensPerChunk: number = DEFAULT_MAX_TOKENS_PER_CHUNK,
    maxChunks: number = DEFAULT_MAX_CHUNKS
): ChunkingResult {
    const rawLines = rawInput.split('\n');
    const chunks: string[] = [];
    let currentChunk = "";
    let currentTokens = 0;

    for (const line of rawLines) {
        const lineTokens = Math.ceil(line.length / 4);
        if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = "";
            currentTokens = 0;
        }
        currentChunk += line + '\n';
        currentTokens += lineTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    const originalChunkCount = chunks.length;
    let warning: string | undefined;

    if (chunks.length > maxChunks) {
        chunks.length = maxChunks;
        warning = `Truncated to ${maxChunks} chunks to avoid 60s HTTP timeout`;
    }

    return {
        chunks,
        originalChunkCount,
        maxTokensPerChunk,
        totalTokens: Math.ceil(rawInput.length / 4),
        warning
    };
}
