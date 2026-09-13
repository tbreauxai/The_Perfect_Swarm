import type { SwarmTool } from './types.ts';

/**
 * Evaluates a mathematical expression safely without eval or Function.
 */
export function safeEvaluateMath(expr: string): number {
    const sanitized = expr.replace(/\s+/g, '');
    let pos = 0;

    function parseExpression(): number {
        let val = parseTerm();
        while (pos < sanitized.length) {
            const op = sanitized[pos];
            if (op === '+') {
                pos++;
                val += parseTerm();
            } else if (op === '-') {
                pos++;
                val -= parseTerm();
            } else {
                break;
            }
        }
        return val;
    }

    function parseTerm(): number {
        let val = parseFactor();
        while (pos < sanitized.length) {
            const op = sanitized[pos];
            if (op === '*') {
                pos++;
                val *= parseFactor();
            } else if (op === '/') {
                pos++;
                const divisor = parseFactor();
                if (divisor === 0) throw new Error('Division by zero');
                val /= divisor;
            } else if (op === '%') {
                pos++;
                const divisor = parseFactor();
                if (divisor === 0) throw new Error('Modulo by zero');
                val %= divisor;
            } else {
                break;
            }
        }
        return val;
    }

    function parseFactor(): number {
        if (pos >= sanitized.length) throw new Error('Unexpected end of expression');

        if (sanitized[pos] === '+') {
            pos++;
            return parseFactor();
        }
        if (sanitized[pos] === '-') {
            pos++;
            return -parseFactor();
        }

        if (sanitized[pos] === '(') {
            pos++;
            const val = parseExpression();
            if (sanitized[pos] !== ')') throw new Error("Missing closing parenthesis ')'");
            pos++;
            return val;
        }

        const start = pos;
        while (pos < sanitized.length && /[0-9.]/.test(sanitized[pos])) {
            pos++;
        }
        if (start === pos) {
            throw new Error(`Unexpected character '${sanitized[pos]}' at index ${pos}`);
        }

        const num = parseFloat(sanitized.substring(start, pos));
        if (isNaN(num)) throw new Error(`Invalid number '${sanitized.substring(start, pos)}'`);
        return num;
    }

    const result = parseExpression();
    if (pos < sanitized.length) {
        throw new Error(`Unexpected character '${sanitized[pos]}' remaining at index ${pos}`);
    }
    return result;
}

/**
 * Built-in safe calculator tool.
 */
export const calculatorTool: SwarmTool<{ expression: string }, { expression: string; result: number }> = {
    name: 'calculator',
    description: 'Safely evaluates arithmetic expressions (+, -, *, /, %, parenthesis) without eval.',
    parameters: {
        expression: {
            type: 'string',
            description: 'The mathematical expression to evaluate (e.g. "((15 * 4) + 120) / 1.5")',
            required: true
        }
    },
    execute({ expression }) {
        if (!expression || typeof expression !== 'string') {
            throw new Error('Calculator requires a string expression parameter.');
        }
        const result = safeEvaluateMath(expression);
        return { expression, result };
    }
};

/**
 * Built-in statistics summary tool.
 */
export const statsSummaryTool: SwarmTool<
    { numbers: number[] },
    { count: number; sum: number; mean: number; median: number; min: number; max: number; variance: number; stdDev: number }
> = {
    name: 'stats_summary',
    description: 'Computes descriptive statistics (count, sum, mean, median, min, max, variance, stdDev) on a dataset.',
    parameters: {
        numbers: {
            type: 'array',
            description: 'Array of numbers to analyze',
            required: true
        }
    },
    execute({ numbers }) {
        if (!Array.isArray(numbers) || numbers.length === 0) {
            throw new Error('stats_summary requires a non-empty array of numbers.');
        }
        const valid = numbers.filter(n => typeof n === 'number' && !isNaN(n));
        if (valid.length === 0) throw new Error('No valid numbers provided in numbers array.');

        const sorted = [...valid].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((acc, val) => acc + val, 0);
        const mean = sum / count;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        let median = 0;
        const mid = Math.floor(count / 2);
        if (count % 2 === 0) {
            median = (sorted[mid - 1] + sorted[mid]) / 2;
        } else {
            median = sorted[mid];
        }

        const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
        const stdDev = Math.sqrt(variance);

        return {
            count,
            sum,
            mean: Number(mean.toFixed(4)),
            median: Number(median.toFixed(4)),
            min,
            max,
            variance: Number(variance.toFixed(4)),
            stdDev: Number(stdDev.toFixed(4))
        };
    }
};

/**
 * Built-in regular expression matching tool.
 */
export const regexMatchTool: SwarmTool<
    { pattern: string; text: string; flags?: string },
    { matched: boolean; matchCount: number; matches: string[]; groups: Record<string, string>[] }
> = {
    name: 'regex_match',
    description: 'Performs regex pattern matching and named group extraction safely on target text.',
    parameters: {
        pattern: {
            type: 'string',
            description: 'Regular expression pattern (e.g. "([A-Z]{3}-\\d{4})")',
            required: true
        },
        text: {
            type: 'string',
            description: 'Target text to test against',
            required: true
        },
        flags: {
            type: 'string',
            description: 'Regex flags, e.g. "g", "i", "m" (default: "g")',
            required: false
        }
    },
    execute({ pattern, text, flags = 'g' }) {
        if (!pattern || typeof pattern !== 'string') throw new Error('Pattern must be a string.');
        if (typeof text !== 'string') throw new Error('Text must be a string.');

        const re = new RegExp(pattern, flags);
        const matches: string[] = [];
        const groups: Record<string, string>[] = [];

        if (re.global) {
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                matches.push(m[0]);
                if (m.groups) groups.push(m.groups);
            }
        } else {
            const m = re.exec(text);
            if (m) {
                matches.push(m[0]);
                if (m.groups) groups.push(m.groups);
            }
        }

        return {
            matched: matches.length > 0,
            matchCount: matches.length,
            matches,
            groups
        };
    }
};

/**
 * Extracts values from JSON using dot/bracket path syntax.
 */
export function extractJsonPath(data: any, path: string): { found: boolean; value: any } {
    if (data === null || data === undefined) return { found: false, value: undefined };
    if (!path || path.trim() === '' || path === '.') return { found: true, value: data };

    const segments = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.');
    let curr = data;

    for (const segment of segments) {
        if (curr === null || curr === undefined) {
            return { found: false, value: undefined };
        }
        if (typeof curr === 'object' && segment in curr) {
            curr = curr[segment];
        } else {
            return { found: false, value: undefined };
        }
    }

    return { found: true, value: curr };
}

/**
 * Built-in JSON extraction tool.
 */
export const jsonExtractTool: SwarmTool<
    { data: any; path: string },
    { found: boolean; path: string; value: any }
> = {
    name: 'json_extract',
    description: 'Extracts deep properties from a JSON string or object using dot/bracket paths (e.g. "users[0].profile.email").',
    parameters: {
        data: {
            type: 'object',
            description: 'JSON object, array, or valid JSON string',
            required: true
        },
        path: {
            type: 'string',
            description: 'Dot/bracket notation path to extract (e.g. "metrics.cpu.load[0]")',
            required: true
        }
    },
    execute({ data, path }) {
        let parsed = data;
        if (typeof data === 'string') {
            try {
                parsed = JSON.parse(data);
            } catch (err: any) {
                throw new Error(`json_extract failed to parse string as JSON: ${err.message}`);
            }
        }
        const { found, value } = extractJsonPath(parsed, path);
        return { found, path, value };
    }
};

export const standardBuiltinTools: SwarmTool[] = [
    calculatorTool,
    statsSummaryTool,
    regexMatchTool,
    jsonExtractTool
];
