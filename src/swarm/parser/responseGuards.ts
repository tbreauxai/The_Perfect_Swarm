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
    const { data: raw, repaired: parseRepaired } = parseJsonSafeWithStatus<any>(input, {});
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

    return {
        insights,
        anomalies,
        summary,
        ...(wasRepaired ? { _repaired: true } : {})
    };
}

/**
 * Domain guard for ManagerResponseSchema: guaranteed valid Generative UI schema.
 */
export function guardManagerResponse(input: unknown, defaultTitle: string = 'Executive Swarm Synthesis'): ManagerResponse {
    const { data: raw, repaired: parseRepaired } = parseJsonSafeWithStatus<any>(input, {});
    let wasRepaired = parseRepaired || raw?._repaired === true;

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

    return {
        ui_title: title,
        ...(summary ? { summary } : {}),
        components,
        _repaired: true
    };
}

/**
 * Domain guard for Critic VerificationResult: guaranteed boolean pass/fail and feedback string.
 */
export function guardVerificationResult(input: unknown): VerificationResult {
    if (typeof input === 'object' && input !== null) {
        const obj = input as any;
        if (Object.keys(obj).length === 0) {
            return { pass: false, feedback: 'Critic returned an empty object.' };
        }
        if (typeof obj.pass === 'boolean') {
            return {
                pass: obj.pass,
                feedback: typeof obj.feedback === 'string' ? obj.feedback : String(obj.feedback || '')
            };
        }
        if (typeof obj.passed === 'boolean') {
            return {
                pass: obj.passed,
                feedback: typeof obj.feedback === 'string' ? obj.feedback : 'Verification status evaluated.'
            };
        }
        if (typeof obj.approved === 'boolean') {
            return {
                pass: obj.approved,
                feedback: typeof obj.feedback === 'string' ? obj.feedback : 'Approval status evaluated.'
            };
        }
        return {
            pass: false,
            feedback: 'Critic output missing pass field.'
        };
    }

    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const trimmed = text.trim();

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
                if (Object.keys(parsed).length === 0) {
                    return { pass: false, feedback: 'Critic returned an empty object.' };
                }
                if (typeof parsed.pass === 'boolean') {
                    return { pass: parsed.pass, feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '' };
                }
                if (typeof parsed.passed === 'boolean') {
                    return { pass: parsed.passed, feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '' };
                }
                if (typeof parsed.approved === 'boolean') {
                    return { pass: parsed.approved, feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '' };
                }
                return { pass: false, feedback: 'Critic output missing pass field.' };
            }
        } catch {
            // continue
        }
    }

    // Try parsing safely
    const parsed = parseJsonSafe<any>(text, null);
    if (parsed && typeof parsed === 'object') {
        if (typeof parsed.pass === 'boolean') {
            return {
                pass: parsed.pass,
                feedback: typeof parsed.feedback === 'string' ? parsed.feedback : ''
            };
        }
        if (typeof parsed.passed === 'boolean') {
            return {
                pass: parsed.passed,
                feedback: typeof parsed.feedback === 'string' ? parsed.feedback : ''
            };
        }
        if (typeof parsed.approved === 'boolean') {
            return {
                pass: parsed.approved,
                feedback: typeof parsed.feedback === 'string' ? parsed.feedback : ''
            };
        }
    }

    // Heuristic sentiment detection for unformatted text outputs
    const upper = text.toUpperCase();
    if (upper.includes('VERIFICATION PASSED') || upper.includes('"PASS": TRUE') || upper.includes('PASSED WITH')) {
        return { pass: true, feedback: text.trim() };
    }
    if (upper.includes('VERIFICATION FAILED') || upper.includes('"PASS": FALSE') || upper.includes('CRITIQUE FAILED')) {
        return { pass: false, feedback: text.trim() };
    }

    // Default fail-safe if critic output is completely ambiguous
    return {
        pass: false,
        feedback: `Ambiguous critic output could not be verified: ${text.slice(0, 150)}`
    };
}
