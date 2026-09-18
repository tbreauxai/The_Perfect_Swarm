import type { ZodType } from 'zod';
import { 
    AnalystResponseSchema, 
    ManagerResponseSchema, 
    normalizeTrend,
    normalizeInsightType,
    type AnalystResponse, 
    type ManagerResponse 
} from './schemas.ts';
import type { VerificationResult } from './types.ts';

export interface ValidationOutcome<T> {
    success: boolean;
    data: T;
    repaired: boolean;
    errors?: string[];
}

/**
 * Resilient Zero-Drift AI JSON Repair Engine.
 * Transforms malformed, fenced, commented, unquoted, single-quoted, or truncated LLM outputs
 * into strictly valid JSON without any external runtime dependencies.
 */
export function repairJson(raw: string): string {
    if (!raw || typeof raw !== 'string') return '{}';

    // 1. Strip reasoning tags (DeepSeek R1, Llama 3.3, Qwen)
    let text = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/\[THOUGHT\][\s\S]*?\[\/THOUGHT\]/gi, '')
        .replace(/```(?:tool_call)[\s\S]*?```/gi, '');

    // Handle unclosed <think> tag if model was truncated mid-reasoning
    const thinkIdx = text.toLowerCase().indexOf('<think>');
    if (thinkIdx !== -1) {
        const jsonStart = text.slice(thinkIdx).search(/[{\[]/);
        if (jsonStart !== -1) {
            text = text.substring(0, thinkIdx) + text.substring(thinkIdx + jsonStart);
        } else {
            text = text.substring(0, thinkIdx);
        }
    }
    text = text.trim();

    // 2. Strip markdown fences
    text = text.replace(/^```(?:json|javascript|js)?\s*/i, '');
    text = text.replace(/\s*```$/i, '');

    // 3. Locate root JSON container start ({ or [)
    const firstObj = text.indexOf('{');
    const firstArr = text.indexOf('[');
    let startIdx = -1;

    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
        startIdx = firstObj;
    } else if (firstArr !== -1) {
        startIdx = firstArr;
    }

    if (startIdx !== -1) {
        text = text.substring(startIdx);
    } else {
        return '{}';
    }

    // 4. Tokenizer & State Machine to sanitize comments, quotes, unquoted keys, and auto-close
    let out = '';
    let inString = false;
    let stringQuote = '';
    let isEscaped = false;
    const stack: string[] = [];

    let i = 0;
    while (i < text.length) {
        const char = text[i];
        const nextChar = text[i + 1] || '';

        if (inString) {
            if (isEscaped) {
                out += char;
                isEscaped = false;
            } else if (char === '\\') {
                out += char;
                isEscaped = true;
            } else if (char === stringQuote) {
                // End of string
                out += '"'; // Normalize to standard double quote
                inString = false;
                stringQuote = '';
            } else if (char === '\n') {
                out += '\\n';
            } else if (char === '\r') {
                // skip carriage return
            } else if (char === '\t') {
                out += '\\t';
            } else {
                out += char;
            }
            i++;
            continue;
        }

        // Outside string literal:
        // Handle single-line and multi-line comments
        if (char === '/' && nextChar === '/') {
            i += 2;
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (char === '/' && nextChar === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        // Handle string start (supports single or double quotes)
        if (char === '"' || char === "'") {
            inString = true;
            stringQuote = char;
            out += '"';
            i++;
            continue;
        }

        // Handle opening delimiters
        if (char === '{') {
            stack.push('}');
            out += char;
            i++;
            continue;
        }
        if (char === '[') {
            stack.push(']');
            out += char;
            i++;
            continue;
        }

        // Handle closing delimiters
        if (char === '}') {
            if (stack.length > 0 && stack[stack.length - 1] === '}') {
                stack.pop();
            }
            out += char;
            i++;
            if (stack.length === 0) {
                // Root container closed, stop appending trailing conversational prose
                break;
            }
            continue;
        }
        if (char === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === ']') {
                stack.pop();
            }
            out += char;
            i++;
            if (stack.length === 0) {
                // Root array closed, stop appending trailing conversational prose
                break;
            }
            continue;
        }

        // Handle unquoted object keys: [a-zA-Z_$][a-zA-Z0-9_$-]* followed by :
        const identifierMatch = text.substring(i).match(/^([a-zA-Z_$][a-zA-Z0-9_$-]*)\s*:/);
        if (identifierMatch) {
            const key = identifierMatch[1];
            out += `"${key}":`;
            i += identifierMatch[0].length;
            continue;
        }

        // Handle Python / JS constants outside strings
        const literalMatch = text.substring(i).match(/^(True|False|None|undefined)\b/);
        if (literalMatch) {
            const lit = literalMatch[1];
            if (lit === 'True') out += 'true';
            else if (lit === 'False') out += 'false';
            else if (lit === 'None' || lit === 'undefined') out += 'null';
            i += lit.length;
            continue;
        }

        out += char;
        i++;
    }

    // 5. Clean up EOF state & auto-close truncations
    let repaired = out.trim();

    // If still in unclosed string at EOF, close quote
    if (inString) {
        repaired += '"';
    }

    // If inside an object and ends with dangling key without value, strip dangling key
    if (stack.length > 0 && stack[stack.length - 1] === '}') {
        repaired = repaired.replace(/([,{])\s*"[^"]*"\s*$/, '$1');
    }

    // Remove trailing commas outside strings
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/,\s*$/g, '');

    // If ends with a dangling colon e.g. "key": -> append null
    if (/:\s*$/.test(repaired)) {
        repaired += ' null';
    }

    // Auto-close any remaining unclosed braces/brackets in reverse stack order
    while (stack.length > 0) {
        const closing = stack.pop()!;
        repaired = repaired.replace(/,\s*$/, '');
        repaired += closing;
    }

    return repaired;
}

/**
 * Fuzzy extractor for unstructured model outputs when all JSON attempts fail.
 */
function extractFuzzyFields(text: string): Record<string, any> | null {
    if (!text || typeof text !== 'string') return null;

    const result: Record<string, any> = {};

    // Match Summary
    const summaryMatch = text.match(/(?:summary|executive\s*summary)[:\s-]+([^\n]+)/i);
    if (summaryMatch) {
        result.summary = summaryMatch[1].trim();
    }

    // Match Insights / Findings (bulleted lines)
    const insightsMatch = text.match(/(?:insights|findings|key\s*points)[:\s-]+([\s\S]*?)(?=(?:anomalies|recommendations|summary|$))/i);
    if (insightsMatch) {
        const lines = insightsMatch[1]
            .split('\n')
            .map(l => l.replace(/^[-*•\d.]+\s*/, '').trim())
            .filter(l => l.length > 0);
        if (lines.length > 0) {
            result.insights = lines;
        }
    }

    // Match Anomalies / Warnings
    const anomaliesMatch = text.match(/(?:anomalies|issues|errors|warnings)[:\s-]+([\s\S]*?)(?=(?:recommendations|summary|$))/i);
    if (anomaliesMatch) {
        const lines = anomaliesMatch[1]
            .split('\n')
            .map(l => l.replace(/^[-*•\d.]+\s*/, '').trim())
            .filter(l => l.length > 0 && !/^none$/i.test(l));
        result.anomalies = lines;
    } else {
        result.anomalies = [];
    }

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parses JSON safely from any input (object, string, malformed string, or buffer).
 * Never throws under any circumstances.
 */
export function parseJsonSafe<T = any>(input: unknown, fallback?: T): T {
    if (typeof input === 'object' && input !== null) {
        return input as T;
    }
    if (typeof input !== 'string') {
        return (fallback !== undefined ? fallback : {}) as T;
    }

    const trimmed = input.trim();
    if (!trimmed) {
        return (fallback !== undefined ? fallback : {}) as T;
    }

    // Attempt 1: Direct JSON.parse
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        // continue
    }

    // Attempt 2: Direct outer substring slice
    try {
        const firstObj = trimmed.indexOf('{');
        const lastObj = trimmed.lastIndexOf('}');
        if (firstObj !== -1 && lastObj > firstObj) {
            return JSON.parse(trimmed.substring(firstObj, lastObj + 1)) as T;
        }
    } catch {
        // continue
    }

    // Attempt 3: Resilient JSON repair (if JSON container brackets exist)
    if (trimmed.includes('{') || trimmed.includes('[')) {
        try {
            const repaired = repairJson(trimmed);
            const parsed = JSON.parse(repaired) as T;
            if (parsed && (typeof parsed !== 'object' || Object.keys(parsed).length > 0)) {
                return parsed;
            }
        } catch {
            // continue
        }
    }

    // Attempt 4: Fuzzy regex extraction
    const fuzzy = extractFuzzyFields(trimmed);
    if (fuzzy && Object.keys(fuzzy).length > 0) {
        return fuzzy as T;
    }

    return (fallback !== undefined ? fallback : {}) as T;
}

/**
 * Generic schema guard and auto-repair validator.
 */
export function repairAndValidate<T>(
    input: unknown,
    schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: any } },
    fallbackFactory?: (raw: any, errors: string[]) => T
): ValidationOutcome<T> {
    const raw = parseJsonSafe(input);
    let repaired = false;

    // 1. Initial validation
    const firstCheck = schema.safeParse(raw);
    if (firstCheck.success) {
        return { success: true, data: firstCheck.data, repaired: false };
    }

    // 2. Intelligent Auto-Coercion
    const coerced: any = Array.isArray(raw) ? [...raw] : { ...raw };

    // Coerce single string into array if array was expected
    for (const key of Object.keys(coerced)) {
        const val = coerced[key];
        if (typeof val === 'string' && (key.endsWith('s') || key === 'insights' || key === 'anomalies' || key === 'components')) {
            if (val.includes('\n')) {
                coerced[key] = val.split('\n').map((l: string) => l.replace(/^[-*•\d.]+\s*/, '').trim()).filter((l: string) => l.length > 0);
                repaired = true;
            }
        }
    }

    const secondCheck = schema.safeParse(coerced);
    if (secondCheck.success) {
        return { success: true, data: secondCheck.data, repaired: true };
    }

    // 3. Fallback Factory
    const scAny = secondCheck as any;
    const errorList = (scAny.error?.issues || scAny.error?.errors || []).map((e: any) => `${e.path?.join('.')}: ${e.message}`);

    if (fallbackFactory) {
        return {
            success: true,
            data: fallbackFactory(raw, errorList),
            repaired: true,
            errors: errorList
        };
    }

    return {
        success: false,
        data: coerced as T,
        repaired: true,
        errors: errorList
    };
}

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
            : [{ type: 'info' as const, message: raw.summary || typeof input === 'string' ? String(input).slice(0, 200) : 'Swarm analysis completed successfully.' }];

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
