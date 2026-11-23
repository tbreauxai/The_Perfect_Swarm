import {
    AnalystResponseSchema,
    ManagerResponseSchema,
    normalizeTrend,
    normalizeInsightType,
    type AnalystResponse,
    type ManagerResponse
} from '../schemas.ts';
import type { VerificationResult } from '../types.ts';
import { parseJsonSafe, parseJsonSafeWithStatus } from './parseJsonSafe.ts';

const POLICY_PRICE_BAND_REGEXES: RegExp[] = [
    /\bbetween\s+[+-]\d{3,4}(?!\.\d)\s+and\s+[+-]\d{3,4}(?!\.\d)\b/gi,
    /\b(?:within|inside|in)\s+(?:the\s+|a\s+)?(?:policy\s+|price\s+|odds\s+)?[+-]\d{3,4}(?!\.\d)\s*(?:to|–|—|-)\s*[+-]\d{3,4}(?!\.\d)(?:\s+(?:window|band|range|corridor|zone|limit|cap|pricing|odds|policy))?\b/gi,
    /(?<![(\dA-Za-z.-])[+-]\d{3,4}(?!\.\d)\s+to\s+[+-]\d{3,4}(?!\.\d)\s+(?:window|band|range|corridor|zone|limit|cap|pricing|odds|policy)\b/gi,
    /\b(?:steeper|heavier|juicier|worse|shorter|longer|capped|floor|ceiling|max(?:imum)?|min(?:imum)?)\s+(?:than|at|of)\s+[+-]\d{3,4}(?!\.\d)\b/gi
];

const BARE_POLICY_PRICE_BAND_REGEX =
    /(?<![(\dA-Za-z.-])-\d{3,4}(?!\.\d)\s+to\s+\+\d{3,4}(?!\.\d)\b/gi;

function protectPolicyPriceBands(
    text: string,
    includeBareOppositeSignBand: boolean
): { masked: string; tokens: string[] } {
    const tokens: string[] = [];
    const patterns = includeBareOppositeSignBand
        ? [...POLICY_PRICE_BAND_REGEXES, BARE_POLICY_PRICE_BAND_REGEX]
        : POLICY_PRICE_BAND_REGEXES;
    let masked = text;
    for (const rx of patterns) {
        masked = masked.replace(rx, (match) => {
            const idx = tokens.push(match) - 1;
            return `__POLICY_PRICE_BAND_${idx}__`;
        });
    }
    return { masked, tokens };
}

function restorePolicyPriceBands(text: string, tokens: string[]): string {
    if (tokens.length === 0) return text;
    return text.replace(/__POLICY_PRICE_BAND_(\d+)__/g, (_m, idxStr) => tokens[Number(idxStr)] ?? '');
}

/**
 * Strips approximate odds, percents, and payouts (e.g. ~65%, ~+650, ~=, "about +650")
 * from model-generated analysis/summary text without replacing them with defaults.
 */
export function stripApproximateOdds(text: string, options?: { allowExactOdds?: boolean }): string {
    if (!text || typeof text !== 'string') return text;
    const { masked, tokens } = protectPolicyPriceBands(text, true);
    let out = masked
        .replace(/(?:~=|~|≈)\s*[+-]?\d+(?:\.\d+)?%?/g, '')
        .replace(/~=/g, '')
        .replace(/\b(?:about|approx\.?|approximately|around|roughly)\s*(?:[+-]\d{3,4}|\d+(?:\.\d+)?%|\$\d+(?:\.\d+)?)/gi, '');
    if (!options?.allowExactOdds) {
        out = out
            // Never strip hyphenated game scores (e.g. 112-100, 106-104) or decimal spreads (-9.5, -10.5):
            // require non-digit/non-word/non-decimal immediately before signed 3-4 digit American odds.
            .replace(/(?:\b(?:at|@)\s+[+-]\d{3,4}(?!\.\d)\b|(?<![\dA-Za-z.-])[+-]\d{3,4}(?!\.\d)\b)/gi, '')
            .replace(/\b(?:stake|risk|wager)\s*(?:of\s*)?(?:\d+(?:\.\d+)?\s*u(?:nits?)?|\$\d+(?:\.\d+)?)\b/gi, '')
            .replace(/\b\d+(?:\.\d+)?\s*u(?:nits?)?\b/gi, '')
            .replace(/\bstake\b/gi, '')
            .replace(/\bpayout(?:\s*(?:of|:|=)?\s*\$?\d+(?:\.\d+)?)?\b/gi, '');
    }
    // Clean only inside matched parentheticals so numbered list items like "1) ... 2) DEN -9.5 (R24)"
    // are never corrupted and stripped odds never leave "( -> )" or "(, +4.1pp)" artifacts.
    out = out.replace(/\(([^()]*)\)/g, (_full, inner: string) => {
        const cleanedInner = inner
            .replace(/^\s*(?:(?:->|→|–|—|-(?!\d)|\bto\b|,|\/|;|:)\s*)+/gi, '')
            .replace(/(?:\s*(?:->|→|–|—|(?<!\d)-|\bto\b|,|\/|;|:))+\s*$/gi, '')
            .replace(/,\s*,+/g, ',')
            .replace(/\s{2,}/g, ' ')
            .trim();
        return cleanedInner ? `(${cleanedInner})` : '';
    });
    out = restorePolicyPriceBands(out, tokens);
    return out
        .replace(/,\s*,+/g, ',')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[,;\s]+|[,;\s]+$/g, '')
        .trim();
}

/**
 * Strips inline American moneyline move parentheticals/ranges like "(-111 to -126)" or
 * "(-111 -> -126, +3.6pp implied)" from Compiler picks/insights/analysis, replacing with
 * qualitative steam wording while leaving spreads (-9.5, -10.5), R# IDs, and scores (112-100) untouched.
 */
export function sanitizeMoneylinePriceMoves(text: string): string {
    if (!text || typeof text !== 'string') return text;

    const { masked, tokens } = protectPolicyPriceBands(text, true);
    const alreadyMentionsSteam = (prefix: string): boolean => /\bsteam\b/i.test(prefix.slice(-64));

    // 1. Parenthetical American ML move ranges: (-111 to -126), (-111 -> -126, +3.6pp implied), (home -111 -> -126)
    let out = masked.replace(
        /\(\s*(?:(?:home|away)\s+)?[+-]\d{3,4}(?!\.\d)\s*(?:->|→|to|–|—)\s*[+-]\d{3,4}(?!\.\d)(?:\s*,\s*([^()]+))?\s*\)/gi,
        (_full, trailingNote: string | undefined, offset: number, fullStr: string) => {
            const prefix = fullStr.slice(0, offset);
            const note = typeof trailingNote === 'string' ? trailingNote.trim() : '';
            const hasSteam = alreadyMentionsSteam(prefix);
            if (hasSteam) {
                return note ? `(${note})` : '';
            }
            return note ? `(favorable ML steam, ${note})` : '(favorable ML steam)';
        }
    );

    // 2. Non-parenthetical inline ML move ranges: "from -111 to -126" or "-111 -> -126"
    out = out.replace(
        /(?:\bfrom\s+)?(?<![\dA-Za-z.-])[+-]\d{3,4}(?!\.\d)\s*(?:->|→|to)\s*[+-]\d{3,4}(?!\.\d)\b/gi,
        (_full, offset: number, fullStr: string) => {
            const prefix = fullStr.slice(0, offset);
            return alreadyMentionsSteam(prefix) ? '' : 'favorable ML steam';
        }
    );

    out = restorePolicyPriceBands(out, tokens);
    return out
        .replace(/\(\s*\)/g, '')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * Normalizes a Compiler proposal object in-place (and returns it):
 * 1) Strips inline ML price-move parentheticals like (-111 to -126) across picks, insights, analysis, and summary.
 * 2) Guarantees `summary` is populated from the first abbreviation-safe sentence of `analysis` when omitted.
 */
export function sanitizeCompilerProposalOddsAndSummary<T>(proposal: T): T {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
    const obj = proposal as any;

    if (typeof obj.analysis === 'string' && obj.analysis.trim().length > 0) {
        obj.analysis = sanitizeMoneylinePriceMoves(obj.analysis);
    }
    if (typeof obj.summary === 'string' && obj.summary.trim().length > 0) {
        obj.summary = sanitizeMoneylinePriceMoves(obj.summary);
    }

    if (Array.isArray(obj.picks)) {
        for (const pk of obj.picks) {
            if (!pk || typeof pk !== 'object') continue;
            if (typeof pk.reason === 'string' && pk.reason.trim().length > 0) {
                pk.reason = sanitizeMoneylinePriceMoves(pk.reason);
            }
            if (Array.isArray(pk.reasons)) {
                pk.reasons = pk.reasons
                    .map((r: any) => (typeof r === 'string' ? sanitizeMoneylinePriceMoves(r) : r))
                    .filter((r: any) => (typeof r === 'string' ? r.length > 0 : Boolean(r)));
            }
            if (typeof pk.note === 'string' && pk.note.trim().length > 0) {
                pk.note = sanitizeMoneylinePriceMoves(pk.note);
            }
        }
    }

    if (Array.isArray(obj.insights)) {
        obj.insights = obj.insights.map((ins: any) => {
            if (typeof ins === 'string') return sanitizeMoneylinePriceMoves(ins);
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
                return { ...ins, message: sanitizeMoneylinePriceMoves(ins.message) };
            }
            return ins;
        });
    }

    if (Array.isArray(obj.components)) {
        for (const comp of obj.components) {
            if (comp && typeof comp === 'object' && comp.type === 'InsightList' && Array.isArray(comp.props?.insights)) {
                comp.props.insights = comp.props.insights.map((ins: any) => {
                    if (typeof ins === 'string') return sanitizeMoneylinePriceMoves(ins);
                    if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
                        return { ...ins, message: sanitizeMoneylinePriceMoves(ins.message) };
                    }
                    return ins;
                });
            }
        }
    }

    // Always guarantee `summary` is populated when `analysis` is present
    const hasSummary = typeof obj.summary === 'string' && obj.summary.trim().length > 0;
    if (!hasSummary && typeof obj.analysis === 'string' && obj.analysis.trim().length > 0) {
        obj.summary = extractFirstSentenceSafe(obj.analysis.trim(), 220);
    }

    return proposal;
}

const DOT_SENTINEL = '\uE000';
const NON_TERMINAL_ABBR_RE = /\b(St|Ft|Mt|Jr|Sr|Dr|Mr|Mrs|Ms|vs|No)\./gi;

/**
 * Splits prose into sentences without breaking on decimals (-10.5, 0.85),
 * multi-letter initials (P.J., A.J.), or sports/city/name abbreviations (St., Mt., Ft., vs.).
 */
export function splitSentencesSafe(text: string): string[] {
    if (!text || typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    const protectedText = trimmed
        // Protect decimal numbers, spreads, totals, probabilities (e.g. -10.5, +3.5, 46.5, 0.85)
        .replace(/(?<=\d)\.(?=\d)/g, DOT_SENTINEL)
        // Protect dotted initial chains (e.g. P.J., A.J., D.J., T.J., B.J., U.S.)
        .replace(/(?<![A-Za-z0-9])((?:[A-Za-z]\.){2,})/g, (m) => m.replace(/\./g, DOT_SENTINEL))
        // Protect spaced single-letter initials followed by another initial (e.g. P. J.)
        .replace(/\b([A-Za-z])\.(?=\s+[A-Za-z]\.)/g, `$1${DOT_SENTINEL}`)
        // Protect known sports/city/title/number abbreviations (St., Ft., Mt., Jr., Sr., Dr., vs., No.)
        .replace(NON_TERMINAL_ABBR_RE, `$1${DOT_SENTINEL}`);

    return protectedText
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.replace(new RegExp(DOT_SENTINEL, 'g'), '.').trim())
        .filter(Boolean);
}

/**
 * Extracts the complete opening sentence (up to ~220 chars on a clean word boundary if oversized)
 * without truncating mid-abbreviation or mid-team-name.
 */
export function extractFirstSentenceSafe(text: string, maxChars: number = 220): string {
    const sentences = splitSentencesSafe(text);
    if (sentences.length === 0) return '';
    const first = sentences[0];
    if (sentences.length === 1 || first.length <= maxChars) {
        return first;
    }
    const minCut = Math.floor(maxChars * 0.6);
    for (const sep of ['. ', '; ', ', ', ' ']) {
        const idx = first.lastIndexOf(sep, maxChars - 3);
        if (idx >= minCut) {
            return `${first.slice(0, idx).trimEnd()}...`;
        }
    }
    return `${first.slice(0, maxChars - 3).trimEnd()}...`;
}

/**
 * Domain guard for AnalystResponseSchema: guaranteed zero crashes on worker agent outputs.
 */
export function guardAnalystResponse(input: unknown, role: string = 'Analyst'): AnalystResponse & { analysis?: string; picks?: any[]; scorecards?: any[]; pass?: boolean; criticApproved?: boolean; wageringPass?: boolean; verdict?: string; flags?: string[] } {
    const { data: raw, repaired: parseRepaired, reasoningTraces } = parseJsonSafeWithStatus<any>(input, {});
    let wasRepaired = parseRepaired || raw?._repaired === true;
    let seatEmittedPricing = false;
    const stripSeatText = (value: string): string => {
        const cleaned = stripApproximateOdds(value);
        if (cleaned !== value.trim()) {
            seatEmittedPricing = true;
        }
        return cleaned;
    };
    const isCriticRole = /critic|\brisk\b/i.test(role || '');

    if (isCriticRole) {
        const metadata: Record<string, any> = {};
        if (reasoningTraces && reasoningTraces.length > 0) {
            metadata.reasoningTraces = reasoningTraces;
        }
        const resolvedCriticApproved =
            typeof raw?.criticApproved === 'boolean'
                ? raw.criticApproved
                : (typeof raw?.pass === 'boolean'
                    ? raw.pass
                    : (Array.isArray(raw?.scorecards) && raw.scorecards.length > 0 && typeof raw.scorecards[0]?.verdict === 'string'
                        ? verdictText(raw.scorecards[0].verdict)
                        : (typeof raw?.verdict === 'string' ? verdictText(raw.verdict) : null)));
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof resolvedCriticApproved === 'boolean') {
            const rawVerdict = typeof raw.verdict === 'string' && raw.verdict.trim()
                ? raw.verdict.trim()
                : (typeof raw.analysis === 'string' && raw.analysis.trim()
                    ? raw.analysis.trim()
                    : (typeof raw.summary === 'string' && raw.summary.trim()
                        ? raw.summary.trim()
                        : (typeof raw.feedback === 'string' && raw.feedback.trim()
                            ? raw.feedback.trim()
                            : (resolvedCriticApproved ? 'approve' : 'veto'))));
            const verdictStr = stripSeatText(rawVerdict);
            const feedbackStr = typeof raw.feedback === 'string' && raw.feedback.trim()
                ? stripSeatText(raw.feedback.trim())
                : undefined;
            const flagsList = Array.isArray(raw.flags)
                ? raw.flags.map((f: any) => stripSeatText(String(f))).filter((s: string) => s.length > 0)
                : [];
            if (seatEmittedPricing && !flagsList.includes('seat_emitted_pricing')) {
                flagsList.push('seat_emitted_pricing');
            }
            return {
                insights: verdictStr ? [verdictStr] : [],
                anomalies: flagsList,
                summary: verdictStr,
                pass: resolvedCriticApproved,
                criticApproved: resolvedCriticApproved,
                ...(typeof raw.wageringPass === 'boolean' ? { wageringPass: raw.wageringPass } : {}),
                ...(Array.isArray(raw.scorecards) ? { scorecards: raw.scorecards } : {}),
                verdict: verdictStr,
                ...(feedbackStr ? { feedback: feedbackStr } : {}),
                flags: flagsList,
                ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
                ...(wasRepaired ? { _repaired: true } : {})
            };
        }
        return {
            insights: [],
            anomalies: ['Critic contract violation: missing pass/criticApproved boolean'],
            summary: 'Critic contract violation: missing pass/criticApproved boolean.',
            pass: false,
            criticApproved: false,
            verdict: 'contract_violation',
            flags: ['missing_pass_field'],
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            _repaired: true,
            _placeholder: true
        };
    }

    const isPickLike = (item: any): boolean => Boolean(
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (
            typeof item.pick === 'string' ||
            typeof item.side === 'string' ||
            typeof item.selection === 'string' ||
            typeof item.team === 'string' ||
            typeof item.game === 'string' ||
            typeof item.match === 'string' ||
            typeof item.event_id === 'string' ||
            typeof item.eventId === 'string' ||
            typeof item.row === 'string'
        )
    );
    const sanitizePick = (item: any) => {
        if (item && typeof item === 'object' && (item.odds !== undefined || item.stake !== undefined)) {
            seatEmittedPricing = true;
        }
        const { odds: _odds, stake: _stake, ...rest } = item;
        if (typeof rest.pick === 'string') rest.pick = stripSeatText(rest.pick);
        if (typeof rest.side === 'string') rest.side = stripSeatText(rest.side);
        if (typeof rest.selection === 'string') rest.selection = stripSeatText(rest.selection);
        if (typeof rest.edge === 'string') rest.edge = stripSeatText(rest.edge);
        if (typeof rest.reason === 'string') rest.reason = stripSeatText(rest.reason);
        return rest;
    };

    const formatPickInsight = (p: any): string => {
        const label = p.pick || p.side || p.selection || p.team || p.row || '';
        const game = p.game || p.match || p.event_id || p.eventId || (p.row && label !== p.row ? p.row : '');
        const reasonSuffix = typeof p.reason === 'string' && p.reason.trim() && !String(label).includes(p.reason.trim())
            ? ` — ${p.reason.trim()}`
            : '';
        const rawLabel = game && label ? `${game}: ${label}${reasonSuffix}` : `${String(label || game || JSON.stringify(p))}${reasonSuffix}`;
        return stripSeatText(rawLabel);
    };

    if (Array.isArray(raw) && raw.length > 0 && raw.some(isPickLike)) {
        const sanitizedPicks = raw.filter(isPickLike).map(sanitizePick);
        const pickLabels = sanitizedPicks.map(formatPickInsight).filter(Boolean);
        const analysisText = stripSeatText(pickLabels.join('; '));
        const metadata: Record<string, any> = {};
        if (reasoningTraces && reasoningTraces.length > 0) {
            metadata.reasoningTraces = reasoningTraces;
        }
        return {
            insights: pickLabels,
            anomalies: [],
            summary: `${role} picks: ${analysisText}`,
            analysis: analysisText,
            picks: sanitizedPicks,
            scorecards: [],
            ...(seatEmittedPricing ? { flags: ['seat_emitted_pricing'] } : {}),
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            _repaired: true
        };
    }

    // Handle minified key compaction aliases if present (ins, ano, sum)
    if (raw && typeof raw === 'object') {
        if (raw.ins !== undefined && raw.insights === undefined) {
            raw.insights = raw.ins;
            wasRepaired = true;
        }
        if (raw.ano !== undefined && raw.anomalies === undefined) {
            raw.anomalies = raw.ano;
            wasRepaired = true;
        }
        if (raw.sum !== undefined && raw.summary === undefined) {
            raw.summary = raw.sum;
            wasRepaired = true;
        }
    }

    let insights: string[] = [];
    if (Array.isArray(raw.insights)) {
        insights = raw.insights.map((s: any) => stripSeatText(String(s))).filter((s: string) => s.length > 0);
    } else if (typeof raw.insights === 'string' && raw.insights.trim().length > 0) {
        const cleaned = stripSeatText(raw.insights.trim());
        if (cleaned) insights = [cleaned];
        wasRepaired = true;
    } else if (Array.isArray(raw.findings)) {
        insights = raw.findings.map((s: any) => stripSeatText(String(s))).filter((s: string) => s.length > 0);
        wasRepaired = true;
    }

    const coerceStringPick = (rawStr: string): Record<string, any> | null => {
        const cleaned = stripSeatText(rawStr).trim();
        if (!cleaned) return null;
        const eventMatch = cleaned.match(/\b([a-z][a-z0-9_-]*-\d+)\b/i);
        const rowMatch = cleaned.match(/\b(R\d+)\b/);
        let pickLabel = cleaned;
        if (eventMatch) {
            const escapedId = eventMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            pickLabel = pickLabel.replace(new RegExp(`^\\s*${escapedId}\\s*[:|\\-–—]?\\s*`, 'i'), '').trim();
        }
        if (!pickLabel) pickLabel = cleaned;
        return sanitizePick({
            ...(eventMatch ? { event_id: eventMatch[1] } : {}),
            ...(rowMatch ? { row: rowMatch[1] } : {}),
            side: pickLabel,
            pick: pickLabel
        });
    };

    let sanitizedObjectPicks = Array.isArray(raw?.picks)
        ? raw.picks
              .map((p: any) => {
                  if (p && typeof p === 'object' && !Array.isArray(p)) return sanitizePick(p);
                  if (typeof p === 'string') {
                      const coerced = coerceStringPick(p);
                      if (coerced) wasRepaired = true;
                      return coerced;
                  }
                  return null;
              })
              .filter((p: any): p is Record<string, any> => p !== null)
        : undefined;

    const rawAnalysisCandidate = [
        raw?.analysis,
        raw?.reason,
        raw?.rationale,
        raw?.conclusion,
        raw?.response,
        raw?.explanation,
        raw?.notes
    ].find((v) => typeof v === 'string' && v.trim().length > 0);

    const rawAnalysis = typeof rawAnalysisCandidate === 'string'
        ? stripSeatText(rawAnalysisCandidate.trim())
        : '';
    const rawScorecards = Array.isArray(raw?.scorecards)
        ? raw.scorecards
        : undefined;

    let isPlaceholder = raw?._placeholder === true;
    if (insights.length === 0 && (!sanitizedObjectPicks || sanitizedObjectPicks.length === 0) && isPickLike(raw)) {
        sanitizedObjectPicks = [sanitizePick(raw)];
    }
    if (insights.length === 0 && sanitizedObjectPicks && sanitizedObjectPicks.length > 0) {
        insights = sanitizedObjectPicks.map(formatPickInsight).filter(Boolean);
        if (rawAnalysis && !insights.includes(rawAnalysis)) {
            insights.unshift(rawAnalysis);
        }
        wasRepaired = true;
    }
    if (insights.length === 0 && rawAnalysis) {
        insights = [rawAnalysis];
        wasRepaired = true;
    }
    if (insights.length === 0) {
        const rawSummaryFallback = typeof raw?.summary === 'string' && raw.summary.trim()
            ? stripSeatText(raw.summary.trim())
            : '';
        const isEmptyParsedObject = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0;
        const isLiteralEmptyJson = typeof input === 'string' && /^\s*(?:\{\s*\}|\[\s*\])\s*$/.test(input);
        const plainTextFallback = !rawSummaryFallback && typeof input === 'string' && (
            !/^\s*[\[{]/.test(input) || (isEmptyParsedObject && !isLiteralEmptyJson)
        )
            ? stripSeatText(input.trim().slice(0, 300))
            : '';
        if (plainTextFallback) {
            insights = [`[${role}] prose: ${plainTextFallback}`];
        } else {
            const fallbackText = rawSummaryFallback || 'unparsed output';
            insights = [`[${role}] ${fallbackText}`];
        }
        wasRepaired = true;
        isPlaceholder = true;
    }
    if (insights.some(i => /fabricated insights for|placeholder insight/i.test(i))) {
        isPlaceholder = true;
    }

    let anomalies: string[] = [];
    if (Array.isArray(raw.anomalies)) {
        anomalies = raw.anomalies.map((s: any) => stripSeatText(String(s))).filter((s: string) => s.length > 0);
    } else if (typeof raw.anomalies === 'string' && raw.anomalies.trim().length > 0 && !/^none$/i.test(raw.anomalies.trim())) {
        const cleaned = stripSeatText(raw.anomalies.trim());
        if (cleaned) anomalies = [cleaned];
        wasRepaired = true;
    }

    let summary = '';
    if (typeof raw.summary === 'string' && raw.summary.trim().length > 0) {
        summary = stripSeatText(raw.summary.trim());
    } else if (rawAnalysis) {
        summary = rawAnalysis;
        wasRepaired = true;
    } else {
        summary = `${role} analytical assessment completed (${insights.length} insight${insights.length === 1 ? '' : 's'}).`;
        wasRepaired = true;
    }
    if (/fabricated insights for/i.test(summary)) {
        isPlaceholder = true;
    }

    const primaryHypothesis = typeof raw?.primaryHypothesis === 'string' && raw.primaryHypothesis.trim().length > 0
        ? raw.primaryHypothesis.trim()
        : undefined;
    const counterHypothesis = typeof raw?.counterHypothesis === 'string' && raw.counterHypothesis.trim().length > 0
        ? raw.counterHypothesis.trim()
        : undefined;

    let sanitizedRecommendation = raw?.recommendation;
    if (sanitizedRecommendation && typeof sanitizedRecommendation === 'object' && !Array.isArray(sanitizedRecommendation)) {
        if (sanitizedRecommendation.odds !== undefined || sanitizedRecommendation.stake !== undefined) {
            seatEmittedPricing = true;
        }
        const { odds: _recOdds, stake: _recStake, ...recRest } = sanitizedRecommendation;
        sanitizedRecommendation = recRest;
    }

    const existingFlags = Array.isArray(raw?.flags) ? raw.flags.map((f: any) => String(f)).filter(Boolean) : [];
    const flags = seatEmittedPricing
        ? Array.from(new Set([...existingFlags, 'seat_emitted_pricing']))
        : existingFlags;

    const metadata: Record<string, any> = {
        ...(raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {})
    };
    if (reasoningTraces && reasoningTraces.length > 0 && !metadata.reasoningTraces) {
        metadata.reasoningTraces = reasoningTraces;
    }

    return {
        insights,
        anomalies,
        summary,
        ...(rawAnalysis ? { analysis: rawAnalysis } : {}),
        ...(rawScorecards !== undefined ? { scorecards: rawScorecards } : {}),
        ...(primaryHypothesis ? { primaryHypothesis } : {}),
        ...(counterHypothesis ? { counterHypothesis } : {}),
        ...(raw?.verdict !== undefined ? { verdict: raw.verdict } : {}),
        ...(sanitizedRecommendation !== undefined ? { recommendation: sanitizedRecommendation } : {}),
        ...(sanitizedObjectPicks !== undefined ? { picks: sanitizedObjectPicks } : {}),
        ...(flags.length > 0 ? { flags } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(wasRepaired ? { _repaired: true } : {}),
        ...(isPlaceholder ? { _placeholder: true } : {})
    };
}

/**
 * Checks if an analyst report is purely requesting more data without actionable insights.
 */
export function isDataRequest(report: any): boolean {
    if (!report || typeof report !== 'object') return false;
    const textToScan = [
        typeof report.summary === 'string' ? report.summary : '',
        Array.isArray(report.insights) ? report.insights.join(' ') : '',
        typeof report.unstructured === 'string' ? report.unstructured : '',
        typeof report.text === 'string' ? report.text : ''
    ].join(' ');

    const isRequestPattern = /data gathering|need (more )?data|requesting .*context|insufficient/i.test(textToScan);
    if (!isRequestPattern) return false;

    // Check if it contains tool-sourced numbers
    const hasToolNumbers = /[-+]?\d+(\.\d+)?%|[-+]\d{3,}|\b\d+\.\d+\b/.test(textToScan);
    return !hasToolNumbers;
}

/**
 * Domain guard for ManagerResponseSchema: guaranteed valid Generative UI schema.
 */
export function guardManagerResponse(input: unknown, defaultTitle: string = 'Executive Swarm Synthesis'): ManagerResponse {
    const { data: raw, repaired: parseRepaired, reasoningTraces } = parseJsonSafeWithStatus<any>(input, {});
    let wasRepaired = parseRepaired || raw?._repaired === true;

    if (reasoningTraces && reasoningTraces.length > 0 && raw && typeof raw === 'object') {
        raw.metadata = {
            ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
            reasoningTraces
        };
    }

    // Handle minified key compaction aliases if present (tit, sum, cmp, met, rec, md)
    if (raw && typeof raw === 'object') {
        if (raw.tit !== undefined && raw.ui_title === undefined) {
            raw.ui_title = raw.tit;
            wasRepaired = true;
        }
        if (raw.sum !== undefined && raw.summary === undefined) {
            raw.summary = raw.sum;
            wasRepaired = true;
        }
        if (raw.cmp !== undefined && raw.components === undefined) {
            raw.components = raw.cmp;
            wasRepaired = true;
        }
        if (raw.met !== undefined && raw.metrics === undefined) {
            raw.metrics = raw.met;
            wasRepaired = true;
        }
        if (raw.rec !== undefined && raw.recommendations === undefined) {
            raw.recommendations = raw.rec;
            wasRepaired = true;
        }
        if (raw.md !== undefined && raw.metadata === undefined) {
            raw.metadata = raw.md;
            wasRepaired = true;
        }
    }

    const parsed = ManagerResponseSchema.safeParse(raw);
    if (parsed.success) {
        const rawAnalysisVal = typeof raw?.analysis === 'string' && raw.analysis.trim().length > 0
            ? sanitizeMoneylinePriceMoves(stripApproximateOdds(raw.analysis.trim(), { allowExactOdds: true }))
            : undefined;
        const explicitSummaryVal = typeof parsed.data.summary === 'string' && parsed.data.summary.trim().length > 0
            ? sanitizeMoneylinePriceMoves(stripApproximateOdds(parsed.data.summary.trim(), { allowExactOdds: true }))
            : undefined;
        const resolvedSummaryVal = explicitSummaryVal || (rawAnalysisVal ? extractFirstSentenceSafe(rawAnalysisVal, 220) : undefined);
        const cleanedData: ManagerResponse = {
            ...parsed.data,
            ...(resolvedSummaryVal ? { summary: resolvedSummaryVal } : {}),
            ...(rawAnalysisVal ? { analysis: rawAnalysisVal } : {}),
            ...(Array.isArray(raw?.picks) ? { picks: raw.picks } : {}),
            ...(Array.isArray(raw?.scorecards) ? { scorecards: raw.scorecards } : {}),
            ...(typeof raw?.pass === 'boolean' ? { pass: raw.pass } : {}),
            ...(typeof raw?.criticApproved === 'boolean' ? { criticApproved: raw.criticApproved } : {}),
            ...(typeof raw?.wageringPass === 'boolean' ? { wageringPass: raw.wageringPass } : {}),
            components: parsed.data.components.map((comp) => {
                if (comp.type === 'InsightList') {
                    return {
                        ...comp,
                        props: {
                            ...comp.props,
                            insights: comp.props.insights.map((ins) => ({
                                ...ins,
                                message: sanitizeMoneylinePriceMoves(stripApproximateOdds(ins.message, { allowExactOdds: true }))
                            }))
                        }
                    };
                }
                return comp;
            })
        } as ManagerResponse;
        sanitizeCompilerProposalOddsAndSummary(cleanedData);
        if (!wasRepaired) return cleanedData;
        return {
            ...cleanedData,
            _repaired: true
        };
    }

    const isCleanBettingContract = Boolean(
        !parseRepaired &&
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        typeof raw.analysis === 'string' &&
        raw.analysis.trim().length > 0 &&
        Array.isArray(raw.picks)
    );
    wasRepaired = !isCleanBettingContract;

    // Synthesize valid Manager UI from whatever data is present
    const title = typeof raw.ui_title === 'string' && raw.ui_title.trim().length > 0
        ? raw.ui_title.trim()
        : defaultTitle;

    const rawAnalysis = typeof raw?.analysis === 'string' && raw.analysis.trim().length > 0
        ? stripApproximateOdds(raw.analysis.trim(), { allowExactOdds: true })
        : undefined;

    const rawSummaryExplicit = typeof raw.summary === 'string' && raw.summary.trim().length > 0
        ? stripApproximateOdds(raw.summary.trim(), { allowExactOdds: true })
        : undefined;
    const summary = (() => {
        if (rawSummaryExplicit && rawSummaryExplicit !== rawAnalysis) {
            return rawSummaryExplicit;
        }
        if (rawAnalysis) {
            const sentences = splitSentencesSafe(rawAnalysis);
            if (sentences.length >= 2) {
                return extractFirstSentenceSafe(rawAnalysis, 220);
            }
            return rawAnalysis;
        }
        return rawSummaryExplicit;
    })();

    const components: ManagerResponse['components'] = [];

    // If components array exists and has valid elements, salvage them
    if (Array.isArray(raw.components)) {
        for (let idx = 0; idx < raw.components.length; idx++) {
            const comp = raw.components[idx];
            if (comp && typeof comp === 'object' && comp.type && comp.props) {
                if (comp.type === 'MetricCard' && comp.props.title && comp.props.value) {
                    components.push({
                        id: comp.id || `metric-${idx}`,
                        type: 'MetricCard',
                        props: {
                            title: String(comp.props.title),
                            value: String(comp.props.value),
                            subtitle: comp.props.subtitle ? String(comp.props.subtitle) : undefined,
                            trend: normalizeTrend(comp.props.trend)
                        }
                    });
                } else if (comp.type === 'InsightList' && comp.props.title && Array.isArray(comp.props.insights)) {
                    components.push({
                        id: comp.id || `insights-${idx}`,
                        type: 'InsightList',
                        props: {
                            title: String(comp.props.title),
                            insights: comp.props.insights.map((ins: any) => ({
                                type: normalizeInsightType(ins.type),
                                message: String(ins.message || ins)
                            }))
                        }
                    });
                } else if (comp.type === 'DataTable' && comp.props.title && Array.isArray(comp.props.columns) && Array.isArray(comp.props.rows)) {
                    components.push({
                        id: comp.id || `table-${idx}`,
                        type: 'DataTable',
                        props: {
                            title: String(comp.props.title),
                            columns: comp.props.columns,
                            rows: comp.props.rows
                        }
                    });
                }
            }
        }
    }

    // If no valid components could be salvaged, construct an InsightList component without duplicating full analysis verbatim
    if (components.length === 0) {
        const insightsList = Array.isArray(raw.insights) && raw.insights.length > 0
            ? raw.insights.map((i: any) => ({ type: 'info' as const, message: String(i) }))
            : (() => {
                if (Array.isArray(raw?.picks) && raw.picks.length > 0) {
                    const pickBullets = raw.picks
                        .map((p: any) => {
                            if (!p || typeof p !== 'object') return '';
                            const row = p.row ? `[${p.row}] ` : '';
                            const side = p.side || p.pickName || p.pick || p.selection || '';
                            const reason = p.reason || (Array.isArray(p.reasons) ? p.reasons[0] : '') || '';
                            return `${row}${side}${reason ? ` — ${reason}` : ''}`.trim();
                        })
                        .filter(Boolean);
                    if (pickBullets.length > 0) {
                        return pickBullets.map((msg: string) => ({ type: 'success' as const, message: msg }));
                    }
                }
                if (rawAnalysis) {
                    const sentences = splitSentencesSafe(rawAnalysis);
                    if (sentences.length > 1) {
                        return sentences.slice(1).map((msg) => ({ type: 'info' as const, message: msg }));
                    }
                }
                const fallbackMsg =
                    summary ||
                    rawAnalysis ||
                    (typeof input === 'string'
                        ? String(input).slice(0, 500)
                        : input && Object.keys(input).length > 0
                            ? JSON.stringify(input)
                            : 'Swarm analysis completed successfully.');
                return [{ type: 'info' as const, message: fallbackMsg }];
            })();

        components.push({
            id: 'default-insight-list',
            type: 'InsightList',
            props: {
                title: 'Synthesis Findings',
                insights: insightsList
            }
        });
    }

    const finalMetadata = raw && typeof raw === 'object' && raw.metadata && typeof raw.metadata === 'object' && Object.keys(raw.metadata).length > 0
        ? raw.metadata
        : undefined;

    const result = {
        ui_title: title,
        ...(summary ? { summary } : {}),
        ...(rawAnalysis ? { analysis: rawAnalysis } : (summary ? { analysis: summary } : {})),
        components,
        ...(finalMetadata ? { metadata: finalMetadata } : {}),
        ...(raw && Array.isArray(raw.picks) ? { picks: raw.picks } : {}),
        ...(raw && Array.isArray(raw.scorecards) ? { scorecards: raw.scorecards } : {}),
        ...(raw && typeof raw.pass === 'boolean' ? { pass: raw.pass } : {}),
        ...(raw && typeof raw.criticApproved === 'boolean' ? { criticApproved: raw.criticApproved } : {}),
        ...(raw && typeof raw.wageringPass === 'boolean' ? { wageringPass: raw.wageringPass } : {}),
        ...(raw && raw.status ? { status: raw.status } : {}),
        ...(raw && raw.reason ? { reason: raw.reason } : {}),
        ...(wasRepaired ? { _repaired: true } : {})
    } as ManagerResponse;
    return sanitizeCompilerProposalOddsAndSummary(result);
}

/**
 * Mask sensitive API keys and tokens from log output before emitting a console warning.
 */
export function redactForLog(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return text
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk-or-v1-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z-_]{20,}|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,})\b/gi, '[REDACTED]')
        .replace(/\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=_-]{32,})\b/g, '[REDACTED]');
}

function asString(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function toBooleanLike(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return null;
}

function verdictText(value: unknown): boolean | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pass' || normalized === 'approve' || normalized === 'approved' || normalized === 'accept') return true;
    if (normalized === 'fail' || normalized === 'veto' || normalized === 'vetoed' || normalized === 'reject' || normalized === 'rejected') return false;
    return null;
}

export function readVerdict(obj: unknown): { pass: boolean | null; feedback: string; parseFailed: boolean; reason?: string } {
    if (!obj || typeof obj !== 'object') {
        return { pass: null, feedback: 'Critic output missing pass field.', parseFailed: true, reason: 'not object' };
    }

    const source = obj as any;
    const issuesText = Array.isArray(source.issues) ? source.issues.map(item => String(item)).join('; ') : '';
    const feedbackText = asString(source.feedback || source.reason || issuesText || '');

    if (source.verifiable !== undefined) {
        const verifiable = toBooleanLike(source.verifiable);
        if (verifiable === false) {
            return {
                pass: false,
                feedback: issuesText || feedbackText || 'Critic could not verify the proposal.',
                parseFailed: false,
                reason: 'verifiable:false'
            };
        }
        if (verifiable === true) {
            // Verifiable means it could audit, not that it passed.
        }
    }

    const directKeys = ['criticApproved', 'pass', 'passed', 'approved'] as const;
    const hasTopLevelBooleanKey = directKeys.some((k) => k in source);
    if (Array.isArray(source.scorecards) && !hasTopLevelBooleanKey) {
        const blacklistedPass = source.scorecards.some((card: any) => card && typeof card === 'object' && verdictText(card.verdict) === true);
        if (blacklistedPass) {
            return {
                pass: false,
                feedback: feedbackText || issuesText || '',
                parseFailed: true,
                reason: 'scorecards verdict pass'
            };
        }
    }

    for (const key of directKeys) {
        if (key in source) {
            const value = source[key];
            const boolValue = toBooleanLike(value);
            if (boolValue !== null) {
                return {
                    pass: boolValue,
                    feedback: feedbackText || '',
                    parseFailed: false,
                    reason: `direct ${key}`
                };
            }
            return {
                pass: false,
                feedback: feedbackText || `Critic output had an invalid ${key} value.`,
                parseFailed: true,
                reason: `invalid ${key}`
            };
        }
    }

    if ('verdict' in source) {
        const verdictValue = verdictText(source.verdict);
        if (verdictValue !== null) {
            return {
                pass: verdictValue,
                feedback: feedbackText || '',
                parseFailed: false,
                reason: 'verdict'
            };
        }
        return {
            pass: false,
            feedback: feedbackText || 'Critic output had an invalid verdict value.',
            parseFailed: true,
            reason: 'invalid verdict'
        };
    }

    for (const key of ['verification', 'result', 'critic'] as const) {
        if (!(key in source)) continue;
        const nested = source[key];
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
            continue;
        }

        const nestedKeys = Object.keys(nested);
        if (nestedKeys.some(child => child === 'pass' || child === 'passed' || child === 'approved' || child === 'verdict')) {
            const nestedResult = readVerdict(nested);
            if (nestedResult.pass !== null) {
                return {
                    pass: nestedResult.pass,
                    feedback: feedbackText || nestedResult.feedback || '',
                    parseFailed: nestedResult.parseFailed,
                    reason: `nested ${key}`
                };
            }
        }

        const nestedDepth = nestedKeys.some(child => nested[child] && typeof nested[child] === 'object');
        if (nestedDepth) {
            return {
                pass: false,
                feedback: feedbackText || 'Critic output nested verdict too deeply.',
                parseFailed: true,
                reason: `nested ${key} depth`
            };
        }
    }

    if (source.verifiable !== undefined && toBooleanLike(source.verifiable) === true) {
        return {
            pass: false,
            feedback: 'Critic output missing pass field.',
            parseFailed: true,
            reason: 'verifiable:true without verdict'
        };
    }

    if (Object.keys(source).length === 0) {
        return {
            pass: false,
            feedback: 'Critic returned an empty object.',
            parseFailed: true,
            reason: 'empty object'
        };
    }

    return {
        pass: false,
        feedback: 'Critic output missing pass field.',
        parseFailed: true,
        reason: 'missing pass field'
    };
}

/**
 * Domain guard for Critic VerificationResult: guaranteed boolean pass/fail and feedback string.
 */
export function guardVerificationResult(input: unknown): VerificationResult {
    if (typeof input === 'object' && input !== null) {
        const verdict = readVerdict(input);
        return {
            pass: verdict.pass === true,
            feedback: verdict.feedback || '',
            ...(verdict.parseFailed ? { parseFailed: true } : {})
        };
    }

    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const trimmed = text.trim();

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                const verdict = readVerdict(parsed);
                return {
                    pass: verdict.pass === true,
                    feedback: verdict.feedback || '',
                    ...(verdict.parseFailed ? { parseFailed: true } : {})
                };
            }
        } catch {
            // continue
        }
    }

    if (text.includes('{')) {
        const parsed = parseJsonSafe<any>(text, null);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            const verdict = readVerdict(parsed);
            return {
                pass: verdict.pass === true,
                feedback: verdict.feedback || '',
                ...(verdict.parseFailed ? { parseFailed: true } : {})
            };
        }
    }

    const upper = text.toUpperCase();
    if (upper.includes('VERIFICATION PASSED') || upper.includes('"PASS": TRUE') || upper.includes('PASSED WITH')) {
        return { pass: true, feedback: text.trim() };
    }
    if (upper.includes('VERIFICATION FAILED') || upper.includes('"PASS": FALSE') || upper.includes('CRITIQUE FAILED')) {
        return { pass: false, feedback: text.trim(), parseFailed: false };
    }

    return {
        pass: false,
        feedback: `Ambiguous critic output could not be verified: ${text.slice(0, 150)}`,
        parseFailed: true
    };
}
