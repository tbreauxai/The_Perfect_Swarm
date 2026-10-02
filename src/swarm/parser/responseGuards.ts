import {
    AnalystResponseSchema,
    ManagerResponseSchema,
    normalizeTrend,
    normalizeInsightType,
    type AnalystResponse,
    type ManagerResponse
} from '../schemas.ts';
import type { VerificationResult } from '../types.ts';
import { parseJsonSafe } from './parseJsonSafe.ts';

/**
 * Domain guard for AnalystResponseSchema: guaranteed zero crashes on worker agent outputs.
 */
export function guardAnalystResponse(input: unknown, role: string = 'Analyst'): AnalystResponse {
    const raw = parseJsonSafe<any>(input, {});

    let insights: string[] = [];
    if (Array.isArray(raw.insights)) {
        insights = raw.insights.map((s: any) => String(s)).filter((s: string) => s.length > 0);
    } else if (typeof raw.insights === 'string' && raw.insights.trim().length > 0) {
        insights = [raw.insights.trim()];
    } else if (Array.isArray(raw.findings)) {
        insights = raw.findings.map((s: any) => String(s)).filter((s: string) => s.length > 0);
    }

    if (insights.length === 0) {
        const fallbackText = typeof input === 'string' ? input.slice(0, 300) : JSON.stringify(raw).slice(0, 300);
        insights = [`[${role}] ${fallbackText || 'Completed analysis'}`];
    }

    let anomalies: string[] = [];
    if (Array.isArray(raw.anomalies)) {
        anomalies = raw.anomalies.map((s: any) => String(s)).filter((s: string) => s.length > 0);
    } else if (typeof raw.anomalies === 'string' && raw.anomalies.trim().length > 0 && !/^none$/i.test(raw.anomalies.trim())) {
        anomalies = [raw.anomalies.trim()];
    }

    let summary = '';
    if (typeof raw.summary === 'string' && raw.summary.trim().length > 0) {
        summary = raw.summary.trim();
    } else {
        summary = `${role} analytical assessment completed (${insights.length} insight${insights.length === 1 ? '' : 's'}).`;
    }

    return {
        insights,
        anomalies,
        summary
    };
}

/**
 * Domain guard for ManagerResponseSchema: guaranteed valid Generative UI schema.
 */
export function guardManagerResponse(input: unknown, defaultTitle: string = 'Executive Swarm Synthesis'): ManagerResponse {
    const raw = parseJsonSafe<any>(input, {});

    const parsed = ManagerResponseSchema.safeParse(raw);
    if (parsed.success) {
        return parsed.data;
    }

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
        components
    };
}

/**
 * Domain guard for Critic VerificationResult: guaranteed boolean pass/fail and feedback string.
 */
export function guardVerificationResult(input: unknown): VerificationResult {
    if (typeof input === 'object' && input !== null) {
        const obj = input as any;
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
    }

    const text = typeof input === 'string' ? input : JSON.stringify(input);

    // Try parsing safely
    const parsed = parseJsonSafe<any>(text, null);
    if (parsed && typeof parsed.pass === 'boolean') {
        return {
            pass: parsed.pass,
            feedback: typeof parsed.feedback === 'string' ? parsed.feedback : ''
        };
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
