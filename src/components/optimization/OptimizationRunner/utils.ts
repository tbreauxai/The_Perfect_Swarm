import { CheckCircle, AlertTriangle, XCircle, Loader2, Clock } from "lucide-react";
export type ModelExecutionStatus = 'idle' | 'running' | 'success' | 'warning' | 'error' | 'valid' | 'incomplete';

/**
 * Calculates a deterministic speed score from execution duration.
 * <= 2000ms is 10, >= 10000ms is 1, scaling linearly in between.
 */
export const calculateSpeedScore = (durationMs: number): number => {
        if (durationMs <= 2000) return 10;
        if (durationMs >= 10000) return 1;
        return Math.max(1, Math.min(10, Math.round(10 - ((durationMs - 2000) / 8000) * 9)));
    };

/**
 * Evaluates whether a benchmarked model response represents a full, substantive,
 * uncorrupted analysis rather than merely the absence of a network error.
 */
export function isModelResponseValid(result?: { output?: any; error?: string } | null): boolean {
    if (!result) return false;
    if (result.error && typeof result.error === 'string' && result.error.trim().length > 0) {
        return false;
    }

    if (result.output === null || result.output === undefined) return false;
    if (typeof result.output === 'string') {
        const trimmed = result.output.trim();
        if (trimmed.length < 20) return false;
        const lower = trimmed.toLowerCase();
        if (
            lower.startsWith('error:') ||
            lower.includes('schema_validation_failed') ||
            lower.includes('execution error') ||
            lower.includes('api key not configured')
        ) {
            return false;
        }
        return true;
    }

    if (typeof result.output === 'object') {
        if (result.output.error) return false;
        const titleLower = typeof result.output.ui_title === 'string' ? result.output.ui_title.toLowerCase() : '';
        if (titleLower.includes('execution error') || titleLower === 'error') {
            return false;
        }

        // Generative UI format (ManagerResponse) with components
        if (Array.isArray(result.output.components) && result.output.components.length > 0) {
            return result.output.components.some((c: any) => {
                if (!c || typeof c !== 'object') return false;
                if (c.type === 'InsightList' && Array.isArray(c.props?.insights) && c.props.insights.length > 0) {
                    return c.props.insights.some((ins: any) => {
                        const msg = typeof ins === 'string' ? ins : ins?.message;
                        if (typeof msg !== 'string') return false;
                        const msgTrimmed = msg.trim();
                        return msgTrimmed.length > 10 && !msgTrimmed.toLowerCase().startsWith('error:');
                    });
                }
                if (c.type === 'MetricCard' && c.props?.title && c.props?.value) return true;
                if (c.type === 'DataTable' && Array.isArray(c.props?.rows) && c.props.rows.length > 0) return true;
                return false;
            });
        }

        // AnalystResponse format with insights / summary
        if (Array.isArray(result.output.insights) && result.output.insights.length > 0) {
            return result.output.insights.some((i: any) => typeof i === 'string' && i.trim().length > 10);
        }
        if (typeof result.output.summary === 'string' && result.output.summary.trim().length > 20) {
            return true;
        }

        // Generic object with message/content
        if (typeof result.output.message === 'string' && result.output.message.trim().length > 20) {
            return true;
        }
    }

    return false;
}

export function getModelExecutionStatus(result?: { output?: any; error?: string } | null): ModelExecutionStatus {
    if (!result || (result.error && typeof result.error === 'string' && result.error.trim().length > 0)) {
        return 'error';
    }

    if (isModelResponseValid(result)) {
        return 'valid';
    }

    return 'incomplete';
}

/**
 * Multi-layer robust score extractor that safely extracts intelligence, accuracy,
 * and speed scores from any response structure (flat JSON, Generative UI components, or events).
 */
export function extractGradingScores(data: any, durationMs: number): { intelligence: number | null; accuracy: number | null; speed: number } {
    console.log('EXTRACT GRADING SCORES INPUT:', data);
    const fallbackSpeed = calculateSpeedScore(durationMs);
    let intVal: number | null = null;
    let accVal: number | null = null;
    let spdVal: number | null = null;
    const parseNum = (v: any): number | null => {
                if (typeof v === 'number' && !isNaN(v)) {
                    return Math.min(10, Math.max(1, Math.round(v)));
                }
                if (typeof v === 'string') {
                    const m = v.match(/\b([1-9]|10)\b/);
                    if (m) return parseInt(m[1], 10);
                    const mFloat = v.match(/([0-9]+(?:\.[0-9]+)?)/);
                    if (mFloat) return Math.min(10, Math.max(1, Math.round(parseFloat(mFloat[1]))));
                }
                return null;
            };
    const tryInspectObject = (obj: any) => {
                if (!obj || typeof obj !== 'object') return;
                if (intVal === null && (obj.intelligence !== undefined || obj.intellect !== undefined || obj.int !== undefined)) {
                    intVal = parseNum(obj.intelligence ?? obj.intellect ?? obj.int);
                }
                if (accVal === null && (obj.accuracy !== undefined || obj.acc !== undefined)) {
                    accVal = parseNum(obj.accuracy ?? obj.acc);
                }
                if (spdVal === null && (obj.speed !== undefined || obj.spd !== undefined)) {
                    spdVal = parseNum(obj.speed ?? obj.spd);
                }
            };
    const tryScanString = (str: any) => {
                if (typeof str !== 'string' || !str.trim()) return;
                const cleaned = str.replace(/```(?:json)?\n?/gi, '').replace(/```/g, '').trim();

                // 1. Try finding JSON block
                try {
                    const matches = cleaned.match(/\{[\s\S]*?\}/g);
                    if (matches) {
                        for (const m of matches) {
                            try {
                                const parsed = JSON.parse(m);
                                tryInspectObject(parsed);
                                if (intVal !== null && accVal !== null) return;
                            } catch {}
                        }
                    }
                } catch {}

                // 2. Regex matching for "intelligence: X" etc.
                if (intVal === null) {
                    const m = cleaned.match(/\b(?:intelligence|intellect|int)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
                    if (m) intVal = parseNum(m[1]);
                }
                if (accVal === null) {
                    const m = cleaned.match(/\b(?:accuracy|acc)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
                    if (m) accVal = parseNum(m[1]);
                }
                if (spdVal === null) {
                    const m = cleaned.match(/\b(?:speed|spd)\b[^,\n\d{}]*?([0-9]+(?:\.[0-9]+)?)/i);
                    if (m) spdVal = parseNum(m[1]);
                }
            };
    tryInspectObject(data);
    tryInspectObject(data?.finalAnalysis);
    if (Array.isArray(data?.events)) {
        for (const ev of data.events) {
            tryInspectObject(ev.output);
            if (typeof ev.output === 'string') tryScanString(ev.output);
            if (intVal !== null && accVal !== null) break;
        }
    }

    if (data?.finalAnalysis && typeof data.finalAnalysis === 'object') {
        const fa = data.finalAnalysis;
        if (Array.isArray(fa.components)) {
            for (const comp of fa.components) {
                if (comp.props?.insights && Array.isArray(comp.props.insights)) {
                    for (const ins of comp.props.insights) {
                        tryScanString(typeof ins === 'string' ? ins : ins?.message);
                    }
                }
                if (comp.props?.title && comp.props?.value) {
                    const title = String(comp.props.title).toLowerCase();
                    if (title.includes('intel') && intVal === null) intVal = parseNum(comp.props.value);
                    if (title.includes('accur') && accVal === null) accVal = parseNum(comp.props.value);
                    if (title.includes('speed') && spdVal === null) spdVal = parseNum(comp.props.value);
                }
            }
        }
        if (fa.summary) tryScanString(fa.summary);
    }

    if (typeof data?.finalAnalysis === 'string') {
        tryScanString(data.finalAnalysis);
    }

    console.log('EXTRACT GRADING SCORES OUTPUT:', { intelligence: intVal, accuracy: accVal, speed: spdVal });
    return {
        intelligence: intVal,
        accuracy: accVal,
        speed: spdVal !== null ? spdVal : fallbackSpeed
    };
}
