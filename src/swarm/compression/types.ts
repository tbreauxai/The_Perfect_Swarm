export type PromptSegmentPriority = 'critical' | 'high' | 'medium' | 'low';

export interface PromptSegment {
    id: string;
    text: string;
    priority: PromptSegmentPriority;
    source?: string;
    sources: string[];
    tokenCount: number;
    isDeduplicated?: boolean;
    deduplicatedWith?: string;
    similarityScore?: number;
    isCodeBlock?: boolean;
    isHeader?: boolean;
    hasAnomaly?: boolean;
}

export interface CompressionOptions {
    /** Target token reduction ratio (e.g. 0.35 for 35% reduction, clamped between 0.10 and 0.80). Default: 0.35 */
    targetReductionRatio?: number;
    /** Hard ceiling on total output tokens. If specified, compressor will aggressively trim to fit. */
    maxTokens?: number;
    /** Semantic similarity threshold for deduplicating segments (0.0 - 1.0). Default: 0.75 */
    similarityThreshold?: number;
    /** Whether to preserve lines containing anomalies, errors, or alerts with 'critical' priority. Default: true */
    preserveAnomalies?: boolean;
    /** Whether to preserve section headers ('Task:', 'Analyst Reports:', etc.). Default: true */
    preserveHeaders?: boolean;
    /** Whether to preserve fenced code blocks verbatim. Default: true */
    preserveCodeBlocks?: boolean;
    /** Whether to strip conversational boilerplate and filler phrases. Default: true */
    stripBoilerplate?: boolean;
    /** Minimum character length for a segment to be eligible for semantic deduplication. Default: 15 */
    minSegmentLength?: number;
}

export interface CompressedPromptResult {
    compressedText: string;
    originalTokens: number;
    compressedTokens: number;
    tokensSaved: number;
    reductionRatio: number;
    deduplicatedSegmentsCount: number;
    prunedSegmentsCount: number;
    preservedSegmentsCount: number;
    segments: PromptSegment[];
    processingTimeMs: number;
}
