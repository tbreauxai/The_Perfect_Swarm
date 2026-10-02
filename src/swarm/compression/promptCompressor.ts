import type {
    PromptSegmentPriority,
    PromptSegment,
    CompressionOptions,
    CompressedPromptResult
} from './types.ts';
import { TokenEstimator } from './tokenEstimator.ts';
import { SemanticDeduplicator } from './semanticDeduplicator.ts';

/**
 * Token-Aware Prompt Compressor.
 * Analyzes prompt structure, classifies segment priority, removes boilerplate,
 * performs semantic deduplication, and enforces token budget targets.
 */
export class TokenAwarePromptCompressor {
    private static BOILERPLATE_PATTERNS: RegExp[] = [
        /^(in conclusion|to summarize|in summary)[,:]?\s*/i,
        /^(as an ai language model|as an expert analyst|based on the (provided|given)?\s*(data|metrics|information|logs|findings|context)?)[,:]?\s*/i,
        /^(it is (important|worth noting|crucial) to note that)[,:]?\s*/i,
        /^(please note that|keep in mind that)[,:]?\s*/i,
        /^(upon careful (review|analysis|examination|investigation))[,:]?\s*/i,
        /^(furthermore|additionally|moreover)[,:]?\s*/i
    ];

    private static ANOMALY_KEYWORDS = [
        'anomaly', 'anomalies', 'spike', 'spikes', 'outlier', 'critical', 'fatal',
        'error', 'exception', 'regression', 'violation', 'failure', 'failed',
        'breach', 'vulnerability', 'alert', 'degraded', 'dropped', 'threshold exceeded'
    ];

    private static HEADER_PREFIXES = [
        'task:', 'metadata:', 'historical baselines:', 'analyst reports:',
        'cluster digests:', 'data chunk', 'system instruction:', 'input data:',
        'constraints:', 'rules:', 'schema:'
    ];

    private options: Required<CompressionOptions>;

    constructor(options?: CompressionOptions) {
        this.options = {
            targetReductionRatio: Math.min(0.80, Math.max(0.10, options?.targetReductionRatio ?? 0.35)),
            maxTokens: options?.maxTokens ?? Number.MAX_SAFE_INTEGER,
            similarityThreshold: Math.min(1.0, Math.max(0.30, options?.similarityThreshold ?? 0.75)),
            preserveAnomalies: options?.preserveAnomalies ?? true,
            preserveHeaders: options?.preserveHeaders ?? true,
            preserveCodeBlocks: options?.preserveCodeBlocks ?? true,
            stripBoilerplate: options?.stripBoilerplate ?? true,
            minSegmentLength: options?.minSegmentLength ?? 15
        };
    }

    /**
     * Primary entry point: Compresses an arbitrary multi-agent prompt.
     */
    compress(prompt: string, overrideOptions?: CompressionOptions): CompressedPromptResult {
        const start = Date.now();
        const opts: Required<CompressionOptions> = {
            ...this.options,
            ...overrideOptions,
            targetReductionRatio: Math.min(0.80, Math.max(0.10, overrideOptions?.targetReductionRatio ?? this.options.targetReductionRatio)),
            similarityThreshold: Math.min(1.0, Math.max(0.30, overrideOptions?.similarityThreshold ?? this.options.similarityThreshold))
        };

        if (!prompt || prompt.trim().length === 0) {
            return {
                compressedText: '',
                originalTokens: 0,
                compressedTokens: 0,
                tokensSaved: 0,
                reductionRatio: 0,
                deduplicatedSegmentsCount: 0,
                prunedSegmentsCount: 0,
                preservedSegmentsCount: 0,
                segments: [],
                processingTimeMs: Date.now() - start
            };
        }

        const originalTokens = TokenEstimator.countTokens(prompt);

        // Step 1: Parse prompt into structural segments
        const rawSegments = this.segmentPrompt(prompt, opts);

        // Step 2: Strip boilerplate if enabled
        const cleanedSegments = rawSegments.map(seg => {
            if (seg.isCodeBlock || seg.isHeader) return seg;
            if (opts.stripBoilerplate) {
                const stripped = this.stripBoilerplatePhrases(seg.text);
                return {
                    ...seg,
                    text: stripped,
                    tokenCount: TokenEstimator.countTokens(stripped)
                };
            }
            return seg;
        });

        // Step 3: Semantic deduplication
        const dedupedSegments = SemanticDeduplicator.deduplicateSegments(
            cleanedSegments,
            opts.similarityThreshold,
            opts.minSegmentLength
        );

        // Filter out deduplicated segments for active assembly
        let activeSegments = dedupedSegments.filter(s => !s.isDeduplicated);
        const deduplicatedCount = dedupedSegments.filter(s => s.isDeduplicated).length;

        // Step 4: Token Budgeting & Priority Pruning
        const targetTokens = Math.min(
            opts.maxTokens,
            Math.ceil(originalTokens * (1 - opts.targetReductionRatio))
        );

        let currentTokens = activeSegments.reduce((sum, s) => sum + s.tokenCount, 0);
        let prunedCount = 0;

        // Prune lowest priority segments first (low -> medium)
        if (currentTokens > targetTokens) {
            const priorityOrder: PromptSegmentPriority[] = ['low', 'medium'];

            for (const p of priorityOrder) {
                for (let i = activeSegments.length - 1; i >= 0; i--) {
                    if (currentTokens <= targetTokens) break;
                    const seg = activeSegments[i];

                    // Never prune critical or segments containing anomalies
                    if (seg.priority === 'critical' || (opts.preserveAnomalies && seg.hasAnomaly) || seg.isHeader) {
                        continue;
                    }

                    if (seg.priority === p) {
                        currentTokens -= seg.tokenCount;
                        activeSegments.splice(i, 1);
                        prunedCount++;
                    }
                }
            }
        }

        // Step 5: Enforce maxTokens hard cap
        if (currentTokens > opts.maxTokens) {
            for (let i = activeSegments.length - 1; i >= 0; i--) {
                if (currentTokens <= opts.maxTokens) break;
                const seg = activeSegments[i];
                if (seg.isHeader) continue;

                const diff = currentTokens - opts.maxTokens;
                if (seg.priority !== 'critical' || !seg.hasAnomaly) {
                    if (seg.tokenCount <= diff) {
                        currentTokens -= seg.tokenCount;
                        activeSegments.splice(i, 1);
                        prunedCount++;
                    } else {
                        const targetSegTokens = Math.max(5, seg.tokenCount - diff);
                        seg.text = TokenEstimator.truncateToTokens(seg.text, targetSegTokens);
                        const newCount = TokenEstimator.countTokens(seg.text);
                        currentTokens -= (seg.tokenCount - newCount);
                        seg.tokenCount = newCount;
                    }
                }
            }
        }

        // Step 6: Assemble final compressed prompt text
        const compressedText = this.assembleCompressedPrompt(activeSegments);
        const compressedTokens = TokenEstimator.countTokens(compressedText);
        const tokensSaved = Math.max(0, originalTokens - compressedTokens);
        const reductionRatio = originalTokens > 0
            ? Math.round(((tokensSaved) / originalTokens) * 1000) / 1000
            : 0;

        return {
            compressedText,
            originalTokens,
            compressedTokens,
            tokensSaved,
            reductionRatio,
            deduplicatedSegmentsCount: deduplicatedCount,
            prunedSegmentsCount: prunedCount,
            preservedSegmentsCount: activeSegments.length,
            segments: dedupedSegments,
            processingTimeMs: Date.now() - start
        };
    }

    /**
     * Special helper for compressing compiled multi-analyst reports.
     * Consolidates identical or overlapping findings across specialist roles while
     * retaining role attribution (e.g. '[Security Specialist & Reliability Specialist]: High latency during spike').
     */
    compressAnalystReports(
        reports: Array<{ role: string; content: string }>,
        overrideOptions?: CompressionOptions
    ): CompressedPromptResult & { compressedReportsText: string } {
        if (!reports || reports.length === 0) {
            const emptyRes = this.compress('', overrideOptions);
            return { ...emptyRes, compressedReportsText: '' };
        }

        const opts: Required<CompressionOptions> = {
            ...this.options,
            ...overrideOptions
        };

        // Decompose each report into segments with source attribution
        const allSegments: PromptSegment[] = [];
        let segIdx = 0;

        for (const rep of reports) {
            const role = rep.role;
            const content = rep.content || '';

            // Split into sentences / paragraphs / bullets
            const rawLines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of rawLines) {
                // Split multi-sentence lines if long
                const sentences = line.length > 80 ? line.split(/(?<=[.?!])\s+/) : [line];

                for (const s of sentences) {
                    const text = s.trim();
                    if (!text) continue;

                    const cleanedText = opts.stripBoilerplate ? this.stripBoilerplatePhrases(text) : text;
                    if (!cleanedText) continue;

                    const hasAnomaly = this.containsAnomaly(cleanedText);
                    let priority: PromptSegmentPriority = 'medium';

                    if (/^(in summary|in conclusion|thank you|overall)[.!:]?$/i.test(cleanedText)) {
                        priority = 'low';
                    } else if (hasAnomaly) {
                        priority = 'high';
                    } else if (/^\s*[-*•\d+.]\s*(key finding|finding|anomaly|result|impact|metric|score)/i.test(cleanedText)) {
                        priority = 'high';
                    }

                    allSegments.push({
                        id: `rep-seg-${segIdx++}`,
                        text: cleanedText,
                        priority,
                        source: role,
                        sources: [role],
                        tokenCount: TokenEstimator.countTokens(cleanedText),
                        hasAnomaly
                    });
                }
            }
        }

        // Semantic deduplication across specialist reports
        const deduped = SemanticDeduplicator.deduplicateSegments(allSegments, opts.similarityThreshold, opts.minSegmentLength);
        const deduplicatedCount = deduped.filter(s => s.isDeduplicated).length;

        // Filter out deduplicated and low-priority boilerplate segments
        const active = deduped.filter(s => !s.isDeduplicated && s.priority !== 'low');
        const prunedCount = deduped.filter(s => s.priority === 'low').length;

        const lines = active.map(seg => `[${seg.sources.join(' & ')}]: ${seg.text}`);
        const compiledRaw = reports.map(r => `[${r.role} Report]:\n${r.content}`).join('\n\n');
        const compressedReportsText = lines.join('\n').trim();

        const originalTokens = TokenEstimator.countTokens(compiledRaw);
        const compressedTokens = TokenEstimator.countTokens(compressedReportsText);
        const tokensSaved = Math.max(0, originalTokens - compressedTokens);
        const reductionRatio = originalTokens > 0
            ? Math.round((tokensSaved / originalTokens) * 1000) / 1000
            : 0;

        return {
            compressedText: compressedReportsText,
            compressedReportsText,
            originalTokens,
            compressedTokens,
            tokensSaved,
            reductionRatio,
            deduplicatedSegmentsCount: deduplicatedCount,
            prunedSegmentsCount: prunedCount,
            preservedSegmentsCount: active.length,
            segments: deduped,
            processingTimeMs: 0
        };
    }

    /**
     * Splits arbitrary prompt text into logical semantic segments.
     */
    private segmentPrompt(prompt: string, opts: Required<CompressionOptions>): PromptSegment[] {
        const segments: PromptSegment[] = [];
        const lines = prompt.split(/\r?\n/);
        let inCodeBlock = false;
        let codeBlockLines: string[] = [];
        let segIdx = 0;
        let currentSectionType: 'general' | 'task' | 'baseline' | 'analyst' = 'general';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Code block boundary handling
            if (trimmed.startsWith('```')) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeBlockLines = [line];
                } else {
                    inCodeBlock = false;
                    codeBlockLines.push(line);
                    const blockText = codeBlockLines.join('\n');
                    segments.push({
                        id: `seg-${segIdx++}`,
                        text: blockText,
                        priority: opts.preserveCodeBlocks ? 'critical' : 'high',
                        source: currentSectionType,
                        sources: [currentSectionType],
                        tokenCount: TokenEstimator.countTokens(blockText),
                        isCodeBlock: true
                    });
                    codeBlockLines = [];
                }
                continue;
            }

            if (inCodeBlock) {
                codeBlockLines.push(line);
                continue;
            }

            if (!trimmed) continue;

            const lower = trimmed.toLowerCase();
            const isHeaderPrefix = TokenAwarePromptCompressor.HEADER_PREFIXES.some(h => lower.startsWith(h)) ||
                                   /^\[.+\]:?$/.test(trimmed) ||
                                   /^#{1,4}\s+/.test(trimmed);

            if (isHeaderPrefix) {
                if (lower.startsWith('task:')) currentSectionType = 'task';
                else if (lower.startsWith('historical baseline')) currentSectionType = 'baseline';
                else if (lower.startsWith('analyst report') || /^\[.+report\]/i.test(trimmed)) currentSectionType = 'analyst';
                else currentSectionType = 'general';

                segments.push({
                    id: `seg-${segIdx++}`,
                    text: trimmed,
                    priority: opts.preserveHeaders ? 'critical' : 'high',
                    source: currentSectionType,
                    sources: [currentSectionType],
                    tokenCount: TokenEstimator.countTokens(trimmed),
                    isHeader: true
                });
                continue;
            }

            // Split multi-sentence lines into sentence units if long
            const sentenceUnits = trimmed.length > 120 ? trimmed.split(/(?<=[.?!])\s+/) : [trimmed];

            for (const unit of sentenceUnits) {
                const text = unit.trim();
                if (!text) continue;

                const hasAnomaly = this.containsAnomaly(text);
                let priority: PromptSegmentPriority = 'medium';

                if (hasAnomaly && opts.preserveAnomalies) {
                    priority = 'high';
                } else if (currentSectionType === 'task') {
                    priority = 'critical';
                } else if (/\b(must|never|always|strict|schema|json|constraint|required)\b/i.test(text)) {
                    priority = 'high';
                } else if (TokenAwarePromptCompressor.BOILERPLATE_PATTERNS.some(p => p.test(text))) {
                    priority = 'low';
                }

                segments.push({
                    id: `seg-${segIdx++}`,
                    text,
                    priority,
                    source: currentSectionType,
                    sources: [currentSectionType],
                    tokenCount: TokenEstimator.countTokens(text),
                    hasAnomaly
                });
            }
        }

        if (inCodeBlock && codeBlockLines.length > 0) {
            const blockText = codeBlockLines.join('\n');
            segments.push({
                id: `seg-${segIdx++}`,
                text: blockText,
                priority: 'critical',
                source: currentSectionType,
                sources: [currentSectionType],
                tokenCount: TokenEstimator.countTokens(blockText),
                isCodeBlock: true
            });
        }

        return segments;
    }

    /**
     * Checks if a text line contains domain anomaly or error keywords.
     */
    private containsAnomaly(text: string): boolean {
        const lower = text.toLowerCase();
        return TokenAwarePromptCompressor.ANOMALY_KEYWORDS.some(k => lower.includes(k));
    }

    /**
     * Strips conversational and verbose boilerplate from text segment.
     */
    private stripBoilerplatePhrases(text: string): string {
        let res = text.trim();
        let changed = true;
        while (changed) {
            changed = false;
            for (const pattern of TokenAwarePromptCompressor.BOILERPLATE_PATTERNS) {
                if (pattern.test(res)) {
                    res = res.replace(pattern, '').trim();
                    changed = true;
                }
            }
        }
        if (res.length > 0) {
            res = res.charAt(0).toUpperCase() + res.slice(1);
        }
        return res;
    }

    /**
     * Reassembles active compressed segments into clean formatted prompt text.
     */
    private assembleCompressedPrompt(segments: PromptSegment[]): string {
        const outputLines: string[] = [];

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.isHeader) {
                if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '') {
                    outputLines.push('');
                }
                outputLines.push(seg.text);
            } else {
                if (seg.sources.length > 1 && !seg.text.startsWith('[')) {
                    outputLines.push(`[${seg.sources.join(' & ')}] ${seg.text}`);
                } else {
                    outputLines.push(seg.text);
                }
            }
        }

        return outputLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
}

/** Global singleton prompt compressor instance with standard configuration */
export const globalPromptCompressor = new TokenAwarePromptCompressor({
    targetReductionRatio: 0.35,
    similarityThreshold: 0.75,
    preserveAnomalies: true,
    preserveHeaders: true,
    preserveCodeBlocks: true,
    stripBoilerplate: true
});
