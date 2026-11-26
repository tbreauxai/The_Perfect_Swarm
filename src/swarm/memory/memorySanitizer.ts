export const DEFAULT_CORTEX_COLLECTION = 'pwa_swarm_dev_cortex_v4';

export const LEGACY_CORTEX_COLLECTIONS = new Set<string>([
    'pwa_swarm_dev_cortex_v2',
    'pwa_swarm_dev_cortex_v3'
]);

export const MAX_USER_PROMPT_CHARS = 160;
export const MAX_RESULT_SUMMARY_CHARS = 240;
export const MAX_LESSON_FEEDBACK_CHARS = 300;
export const MAX_MEMORY_SNIPPET_CHARS = 350;
export const MAX_CORTEX_MEMORY_BLOCK_CHARS = 1200;

export function resolveCortexCollectionName(collectionName?: string): string {
    const trimmed = typeof collectionName === 'string' ? collectionName.trim() : '';
    if (!trimmed || LEGACY_CORTEX_COLLECTIONS.has(trimmed)) {
        return DEFAULT_CORTEX_COLLECTION;
    }
    return trimmed;
}

export const LEGACY_CONTRACT_MARKER_RE =
    /(?:\bTOOL RULE:|PICK OUTPUT(?:\s*(?:CONTRACT|&\s*MATHEMATICAL EDGE CONTRACT))?|\bFILTERED DATA TOOL RULE\b|\bMORNING BASELINE\b|\bTARGET BRIEF\b|\bREQUIRED RISK CRITIC\b|\bINJURY & PARLAY CALIBRATION\b|You receive (?:a|the) compact slate,?\s*not game context|\bSWARM CONSENSUS & PROPOSER RULES\b|\bMATHEMATICAL TRUST DIRECTIVE\b|\bMODEL GROUND TRUTH & ARITHMETIC BOUNDARY\b|\bTOP-LEVEL JSON OBJECT ONLY\b|Output (?:one|strictly a single) top-level JSON object|===\s*(?:COMPACT SLATE|CANDIDATE PICKS TO REVIEW|RAW ACTIONABLE BETS SLICE|MATCHUP & ENVIRONMENTAL INTEL|STRATEGIC PARLAY)\b|Each slate row has an id\b|Lines prefixed MODEL\b|\[\s*PASS-2 DELTA CONTEXT\s*[-—]\s*MORNING BASELINE\s*\]|\bevent_id=[a-z]+-\d+\s*\|)/i;

export const STRATEGIC_PASS_RESULT_RE =
    /\b(?:strategic pass|wagering pass|no picks|no[\s_-]?play|no actionable plays?|0 bets?)\b/i;

const USER_PROMPT_BOUNDARY_RE =
    /(?:\r?\n\s*|\b)(?:Operational Mode:|User Bankroll:|Risk Profile:|You receive (?:a|the) compact slate\b|INJURY & PARLAY CALIBRATION:|Output (?:one|strictly a single) top-level JSON object|REQUIRED RISK CRITIC|FILTERED DATA TOOL RULE:|PICK OUTPUT(?:\s*(?:CONTRACT|&\s*MATHEMATICAL EDGE CONTRACT))?|TOOL RULE:|Each slate row has an id\b|SWARM CONSENSUS & PROPOSER RULES:|MATHEMATICAL TRUST DIRECTIVE:|MODEL GROUND TRUTH|TARGET BRIEF|MORNING BASELINE|===\s*(?:COMPACT SLATE|CANDIDATE PICKS|RAW ACTIONABLE|MATCHUP & ENVIRONMENTAL|STRATEGIC PARLAY))/i;

const CONTRACT_SECTION_START_RE =
    /(?:^|\r?\n)\s*(?:Operational Mode:|User Bankroll:|Risk Profile:|TOOL RULE:|FILTERED DATA TOOL RULE:|PICK OUTPUT|INJURY & PARLAY CALIBRATION:|REQUIRED RISK CRITIC|SWARM CONSENSUS|MATHEMATICAL TRUST DIRECTIVE|MODEL GROUND TRUTH|TOP-LEVEL JSON OBJECT ONLY|Output (?:one|strictly a single) top-level JSON object|You receive (?:a|the) compact slate|===\s*(?:COMPACT SLATE|CANDIDATE PICKS TO REVIEW|RAW ACTIONABLE BETS SLICE|MATCHUP & ENVIRONMENTAL INTEL|STRATEGIC PARLAY)|Each slate row has an id\b|\[\s*PASS-2 DELTA CONTEXT)/i;

export function truncateCleanText(text: string, maxChars: number): string {
    if (!text) return '';
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    if (maxChars <= 3) return trimmed.slice(0, Math.max(0, maxChars));
    const slice = trimmed.slice(0, maxChars - 3);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= (maxChars - 3) * 0.5) {
        return `${slice.slice(0, lastSpace).trimEnd()}...`;
    }
    return `${slice.trimEnd()}...`;
}

/**
 * Extracts the concise 1-line user prompt from raw wrapped swarm task boilerplate.
 */
export function extractCleanUserPrompt(
    task: string,
    explicitUserPrompt?: string,
    maxChars: number = MAX_USER_PROMPT_CHARS
): string {
    const rawExplicit = typeof explicitUserPrompt === 'string' ? explicitUserPrompt.trim() : '';
    let candidate = rawExplicit || (typeof task === 'string' ? task.trim() : '');
    if (!candidate) return '';

    const lower = candidate.toLowerCase();
    const userPromptIdx = lower.lastIndexOf('user prompt:');
    if (userPromptIdx >= 0) {
        candidate = candidate.slice(userPromptIdx + 'user prompt:'.length).trim();
    } else {
        const userQuestionIdx = lower.lastIndexOf('user question:');
        if (userQuestionIdx >= 0) {
            candidate = candidate.slice(userQuestionIdx + 'user question:'.length).trim();
        }
    }

    candidate = candidate
        .replace(/^Two-Hop Swarm Review:\s*/i, '')
        .replace(/^CHAT OBJECTIVE:\s*/i, '')
        .replace(/^Task:\s*/i, '')
        .trim();

    const boundaryMatch = USER_PROMPT_BOUNDARY_RE.exec(candidate);
    if (boundaryMatch && boundaryMatch.index !== undefined && boundaryMatch.index > 0) {
        candidate = candidate.slice(0, boundaryMatch.index).trim();
    } else if (boundaryMatch && boundaryMatch.index === 0) {
        candidate = '';
    }

    const singleLine = candidate.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!singleLine || containsLegacyContractBoilerplate(singleLine)) {
        return '';
    }
    return truncateCleanText(singleLine, maxChars);
}

export function containsLegacyContractBoilerplate(text: string | undefined | null): boolean {
    if (!text || typeof text !== 'string') return false;
    return LEGACY_CONTRACT_MARKER_RE.test(text);
}

/**
 * Strips system/contract boilerplate and raw slate dumps from memory text before embedding/storage or injection.
 */
export function stripContractBoilerplate(text: string, maxChars?: number): string {
    if (!text || typeof text !== 'string') return '';
    let working = text.replace(/\r\n/g, '\n');

    // Drop any trailing contract/slate block starting at a known section boundary
    const keptLines: string[] = [];
    for (const rawLine of working.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (LEGACY_CONTRACT_MARKER_RE.test(line) || CONTRACT_SECTION_START_RE.test(line)) {
            if (/^Task:\s*/i.test(line)) {
                const cleanedTask = extractCleanUserPrompt(line);
                if (cleanedTask) keptLines.push(`Task: ${cleanedTask}`);
                continue;
            }
            break;
        }
        keptLines.push(line);
    }

    let cleaned = keptLines
        .map((line) => {
            if (/^Task:\s*/i.test(line)) {
                const cleanedTask = extractCleanUserPrompt(line);
                return cleanedTask ? `Task: ${cleanedTask}` : '';
            }
            return line;
        })
        .filter(Boolean)
        .join('\n')
        .replace(/\s+\n/g, '\n')
        .trim();

    if (maxChars !== undefined) {
        cleaned = truncateCleanText(cleaned.replace(/\s+/g, ' ').trim(), maxChars);
    }
    return cleaned;
}

export function isZeroBetPassAnalysis(finalAnalysis: any): boolean {
    if (!finalAnalysis || typeof finalAnalysis !== 'object') return true;
    const isStructuredJudgment =
        finalAnalysis.winProbHome !== undefined ||
        finalAnalysis.win_prob_home !== undefined ||
        finalAnalysis.judgment?.winProbHome !== undefined ||
        finalAnalysis.judgment?.win_prob_home !== undefined;
    if (isStructuredJudgment) return false;

    const picks = Array.isArray(finalAnalysis.picks) ? finalAnalysis.picks : undefined;
    if (picks && picks.length === 0) return true;
    if (finalAnalysis.wageringPass === true) return true;
    if (finalAnalysis.pass === true && (!picks || picks.length === 0)) return true;

    const titleAndSummary = `${finalAnalysis.ui_title || ''} ${finalAnalysis.summary || ''}`.trim();
    if (
        titleAndSummary &&
        STRATEGIC_PASS_RESULT_RE.test(titleAndSummary) &&
        (!picks || picks.length === 0)
    ) {
        return true;
    }
    return false;
}

export function isZeroBetPassRecord(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    if (record.isWageringPass === true || record.wageringPass === true) return true;
    if (record.excludeFromExemplars === true) return true;
    if (record.outcome === 'pass') return true;
    if (typeof record.picksCount === 'number' && record.picksCount <= 0) return true;
    if (Array.isArray(record.picks) && record.picks.length === 0) return true;

    const hasPositiveWagerProof =
        (typeof record.picksCount === 'number' && record.picksCount > 0) ||
        (Array.isArray(record.picks) && record.picks.length > 0);
    if (!hasPositiveWagerProof) {
        const text = [record.content, record.resultSummary, record.feedback, record.lesson]
            .filter((v) => typeof v === 'string')
            .join(' ');
        if (text && STRATEGIC_PASS_RESULT_RE.test(text)) {
            return true;
        }
    }
    return false;
}

export function isGradedWagerWin(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    if (isZeroBetPassRecord(record)) return false;
    if (
        containsLegacyContractBoilerplate(record.content) ||
        containsLegacyContractBoilerplate(record.resultSummary) ||
        containsLegacyContractBoilerplate(record.task)
    ) {
        return false;
    }
    if (typeof record.picksCount === 'number' && record.picksCount <= 0) return false;
    if (Array.isArray(record.picks) && record.picks.length === 0) return false;

    const hasPositiveClv =
        (typeof record.clv === 'number' && record.clv > 0) ||
        (typeof record.closingLineValue === 'number' && record.closingLineValue > 0);
    return (
        record.outcome === 'win' ||
        record.outcome === 'won' ||
        hasPositiveClv ||
        (record.feedbackProcessed === true &&
            record.outcome !== 'loss' &&
            record.outcome !== 'lost' &&
            record.outcome !== 'push' &&
            typeof record.qualityRating === 'number' &&
            record.qualityRating >= 0.8)
    );
}

export function isGradedWagerLoss(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    if (isZeroBetPassRecord(record)) return false;
    if (
        containsLegacyContractBoilerplate(record.content) ||
        containsLegacyContractBoilerplate(record.resultSummary) ||
        containsLegacyContractBoilerplate(record.task)
    ) {
        return false;
    }
    if (typeof record.picksCount === 'number' && record.picksCount <= 0) return false;
    if (Array.isArray(record.picks) && record.picks.length === 0) return false;

    const clvVal = typeof record.clv === 'number'
        ? record.clv
        : (typeof record.closingLineValue === 'number' ? record.closingLineValue : null);
    if (record.outcome === 'loss' || record.outcome === 'lost') {
        return clvVal === null || clvVal <= 0;
    }
    if (record.vetoFlag === true) return true;
    if (record.feedbackProcessed === true) {
        if (typeof record.brierScore === 'number' && record.brierScore >= 0.28) return true;
        if (typeof record.qualityRating === 'number' && record.qualityRating <= 0.25) return true;
    }
    return false;
}

export function isSafeExemplarRecord(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    if (isZeroBetPassRecord(record)) return false;
    if (
        containsLegacyContractBoilerplate(record.content) ||
        containsLegacyContractBoilerplate(record.resultSummary) ||
        containsLegacyContractBoilerplate(record.feedback) ||
        containsLegacyContractBoilerplate(record.lesson) ||
        containsLegacyContractBoilerplate(record.task)
    ) {
        return false;
    }
    if (record.outcome === 'loss' || record.outcome === 'push') return false;

    const isSportsJudgment =
        record.originApp === 'duelodds' ||
        record.appId === 'duelodds' ||
        record.memoryType === 'judgment' ||
        record.memory_type === 'judgment' ||
        typeof record.picksCount === 'number';
    if (isSportsJudgment) {
        const isValidatedWinOrLesson =
            record.outcome === 'win' ||
            record.memoryType === 'graded_lesson' ||
            record.memoryType === 'fact' ||
            (record.feedbackProcessed === true && record.outcome !== 'loss' && record.outcome !== 'push');
        if (!isValidatedWinOrLesson) return false;
    }

    return true;
}

export function isSafeRetrievedBaseline(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    if (isZeroBetPassRecord(record)) return false;
    if (
        containsLegacyContractBoilerplate(record.rule) ||
        containsLegacyContractBoilerplate(record.reason) ||
        containsLegacyContractBoilerplate(record.content) ||
        containsLegacyContractBoilerplate(record.feedback) ||
        containsLegacyContractBoilerplate(record.task)
    ) {
        return false;
    }
    return true;
}

export function truncateMemorySnippet(
    text: string,
    maxChars: number = MAX_MEMORY_SNIPPET_CHARS
): string {
    if (!text || typeof text !== 'string') return '';
    const cleaned = stripContractBoilerplate(text);
    return truncateCleanText(cleaned, maxChars);
}

export function capCortexMemoryBlock(
    text: string,
    maxChars: number = MAX_CORTEX_MEMORY_BLOCK_CHARS
): string {
    if (!text || typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;

    const slice = trimmed.slice(0, maxChars - 3);
    const lastNewline = slice.lastIndexOf('\n');
    if (lastNewline >= (maxChars - 3) * 0.45) {
        return `${slice.slice(0, lastNewline).trimEnd()}...`;
    }
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= (maxChars - 3) * 0.45) {
        return `${slice.slice(0, lastSpace).trimEnd()}...`;
    }
    return `${slice.trimEnd()}...`;
}

export function sanitizeMemoryWrite(
    content: string,
    metadata: Record<string, any> = {}
): {
    content: string;
    metadata: Record<string, any>;
    blocked: boolean;
} {
    if (isZeroBetPassRecord({ content, ...metadata })) {
        return {
            content: '',
            metadata: { ...metadata },
            blocked: true
        };
    }

    const rawTask = typeof metadata.task === 'string' ? metadata.task : '';
    const cleanUserPrompt = extractCleanUserPrompt(
        rawTask || content,
        typeof metadata.userPrompt === 'string'
            ? metadata.userPrompt
            : typeof metadata.userQuestion === 'string'
              ? metadata.userQuestion
              : undefined,
        MAX_USER_PROMPT_CHARS
    );

    const rawFeedback =
        typeof metadata.lesson === 'string'
            ? metadata.lesson
            : typeof metadata.feedback === 'string'
              ? metadata.feedback
              : '';
    const cleanLesson = stripContractBoilerplate(rawFeedback, MAX_LESSON_FEEDBACK_CHARS);

    const isStructuredVerdict =
        /\bVerdict:\s*LikelyWinner=/i.test(content) && !containsLegacyContractBoilerplate(content);

    let sanitizedContent: string;
    let cleanResultSummary =
        typeof metadata.resultSummary === 'string'
            ? stripContractBoilerplate(metadata.resultSummary, MAX_RESULT_SUMMARY_CHARS)
            : '';

    if (isStructuredVerdict) {
        sanitizedContent = stripContractBoilerplate(content);
        if (!cleanResultSummary) {
            const verdictMatch = sanitizedContent.match(/Verdict:\s*([^\n]+)/i);
            cleanResultSummary = truncateCleanText(
                verdictMatch ? verdictMatch[1] : sanitizedContent,
                MAX_RESULT_SUMMARY_CHARS
            );
        }
    } else {
        const resultMatch = content.match(/(?:^|\n)Result:\s*([^\n]+)/i);
        const derivedResult = cleanResultSummary ||
            stripContractBoilerplate(
                resultMatch ? resultMatch[1] : content,
                MAX_RESULT_SUMMARY_CHARS
            );
        cleanResultSummary = derivedResult;

        const parts: string[] = [];
        if (cleanUserPrompt) {
            parts.push(`Prompt: ${cleanUserPrompt}`);
        }
        if (cleanResultSummary) {
            parts.push(`Result: ${cleanResultSummary}`);
        }
        if (cleanLesson && cleanLesson !== 'None') {
            parts.push(`Lesson: ${cleanLesson}`);
        }

        const joined = parts.join('\n').trim();
        sanitizedContent = truncateCleanText(joined || stripContractBoilerplate(content, 420), 480);
    }

    const sanitizedMeta: Record<string, any> = {
        ...metadata,
        ...(cleanUserPrompt ? { userPrompt: cleanUserPrompt, task: cleanUserPrompt } : {}),
        ...(cleanResultSummary ? { resultSummary: cleanResultSummary } : {}),
        ...(cleanLesson ? { lesson: cleanLesson, feedback: cleanLesson } : {})
    };
    if (!cleanUserPrompt && 'task' in sanitizedMeta) {
        delete sanitizedMeta.task;
    }

    return {
        content: sanitizedContent,
        metadata: sanitizedMeta,
        blocked: sanitizedContent.length === 0
    };
}
