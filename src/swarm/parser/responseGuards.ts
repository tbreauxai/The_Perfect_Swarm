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

/**
 * Domain guard for AnalystResponseSchema: guaranteed zero crashes on worker agent outputs.
 */
export function guardAnalystResponse(input: unknown, role: string = 'Analyst'): AnalystResponse {
    const { data: raw, repaired: parseRepaired, reasoningTraces } = parseJsonSafeWithStatus<any>(input, {});
    let wasRepaired = parseRepaired || raw?._repaired === true;

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
        insights = raw.insights.map((s: any) => String(s)).filter((s: string) => s.length > 0);
    } else if (typeof raw.insights === 'string' && raw.insights.trim().length > 0) {
        insights = [raw.insights.trim()];
        wasRepaired = true;
    } else if (Array.isArray(raw.findings)) {
        insights = raw.findings.map((s: any) => String(s)).filter((s: string) => s.length > 0);
        wasRepaired = true;
    }

    if (insights.length === 0) {
        const fallbackText = typeof input === 'string' ? input.slice(0, 300) : JSON.stringify(raw).slice(0, 300);
        insights = [`[${role}] ${fallbackText || 'Completed analysis'}`];
        wasRepaired = true;
    }

    let anomalies: string[] = [];
    if (Array.isArray(raw.anomalies)) {
        anomalies = raw.anomalies.map((s: any) => String(s)).filter((s: string) => s.length > 0);
    } else if (typeof raw.anomalies === 'string' && raw.anomalies.trim().length > 0 && !/^none$/i.test(raw.anomalies.trim())) {
        anomalies = [raw.anomalies.trim()];
        wasRepaired = true;
    }

    let summary = '';
    if (typeof raw.summary === 'string' && raw.summary.trim().length > 0) {
        summary = raw.summary.trim();
    } else {
        summary = `${role} analytical assessment completed (${insights.length} insight${insights.length === 1 ? '' : 's'}).`;
        wasRepaired = true;
    }

    const primaryHypothesis = typeof raw?.primaryHypothesis === 'string' && raw.primaryHypothesis.trim().length > 0
        ? raw.primaryHypothesis.trim()
        : undefined;
    const counterHypothesis = typeof raw?.counterHypothesis === 'string' && raw.counterHypothesis.trim().length > 0
        ? raw.counterHypothesis.trim()
        : undefined;

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
        ...(primaryHypothesis ? { primaryHypothesis } : {}),
        ...(counterHypothesis ? { counterHypothesis } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(wasRepaired ? { _repaired: true } : {})
    };
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
    if (parsed.success && !wasRepaired) {
        return parsed.data;
    }
    if (parsed.success && wasRepaired) {
        return {
            ...parsed.data,
            _repaired: true
        };
    }

    wasRepaired = true;

    // Synthesize valid Manager UI from whatever data is present
    const title = typeof raw.ui_title === 'string' && raw.ui_title.trim().length > 0
        ? raw.ui_title.trim()
        : defaultTitle;

    const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0
        ? raw.summary.trim()
        : undefined;

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

    // If no valid components could be salvaged, construct an InsightList component
    if (components.length === 0) {
        const insightsList = Array.isArray(raw.insights)
            ? raw.insights.map((i: any) => ({ type: 'info' as const, message: String(i) }))
            : [{ type: 'info' as const, message: raw.summary || (typeof input === 'string' ? String(input).slice(0, 500) : (input && Object.keys(input).length > 0 ? JSON.stringify(input) : 'Swarm analysis completed successfully.')) }];

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

    return {
        ui_title: title,
        ...(summary ? { summary } : {}),
        components,
        ...(finalMetadata ? { metadata: finalMetadata } : {}),
        _repaired: true
    };
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
    if (normalized === 'fail' || normalized === 'reject' || normalized === 'rejected') return false;
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

    if (Array.isArray(source.scorecards)) {
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

    const directKeys = ['pass', 'passed', 'approved'] as const;
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

    const parsed = parseJsonSafe<any>(text, null);
    if (parsed && typeof parsed === 'object') {
        const verdict = readVerdict(parsed);
        return {
            pass: verdict.pass === true,
            feedback: verdict.feedback || '',
            ...(verdict.parseFailed ? { parseFailed: true } : {})
        };
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
