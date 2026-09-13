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

/**
 * Built-in data filtering and querying tool.
 */
export const dataFilterTool: SwarmTool<
    { items?: any[]; data?: any[]; field?: string; filter?: { field?: string; operator?: string; value?: any }; operator?: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'in'; value?: any; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' },
    { matchedCount: number; totalCount: number; results: any[]; data: any[] }
> = {
    name: 'data_filter',
    description: 'Filters an array of JSON objects based on condition operators (==, !=, >, >=, <, <=, contains, in).',
    parameters: {
        items: {
            type: 'array',
            description: 'Array of objects to filter',
            required: true
        },
        field: {
            type: 'string',
            description: 'Field path to test (e.g. "status", "metrics.cpu")',
            required: true
        },
        operator: {
            type: 'string',
            description: 'Comparison operator: "==", "!=", ">", ">=", "<", "<=", "contains", "in" (default: "==")',
            required: false
        },
        value: {
            type: 'string',
            description: 'Value to compare against',
            required: true
        },
        limit: {
            type: 'number',
            description: 'Maximum number of items to return',
            required: false
        }
    },
    execute(rawParams: any) {
        const items = rawParams.items || rawParams.data;
        const field = rawParams.field || rawParams.filter?.field;
        const operator = rawParams.operator || rawParams.filter?.operator || '==';
        const value = rawParams.value !== undefined ? rawParams.value : rawParams.filter?.value;
        const limit = rawParams.limit;
        const sortBy = rawParams.sortBy;
        const sortOrder = rawParams.sortOrder || 'asc';

        let array = items;
        if (typeof items === 'string') {
            try {
                array = JSON.parse(items);
            } catch {
                throw new Error('data_filter: items must be an array of objects.');
            }
        }
        if (!Array.isArray(array)) {
            throw new Error('data_filter requires an array of items.');
        }

        let filtered = array.filter(item => {
            const { found, value: itemVal } = extractJsonPath(item, field);
            if (!found) return operator === '!=' || (operator === '==' && value === undefined);

            switch (operator) {
                case '==':
                    return itemVal == value;
                case '!=':
                    return itemVal != value;
                case '>':
                    return Number(itemVal) > Number(value);
                case '>=':
                    return Number(itemVal) >= Number(value);
                case '<':
                    return Number(itemVal) < Number(value);
                case '<=':
                    return Number(itemVal) <= Number(value);
                case 'contains':
                    return String(itemVal).toLowerCase().includes(String(value).toLowerCase());
                case 'in':
                    return Array.isArray(value) ? value.includes(itemVal) : String(value).split(',').map((s: string) => s.trim()).includes(String(itemVal));
                default:
                    return itemVal == value;
            }
        });

        if (sortBy) {
            filtered.sort((a, b) => {
                const valA = extractJsonPath(a, sortBy).value;
                const valB = extractJsonPath(b, sortBy).value;
                if (typeof valA === 'number' && typeof valB === 'number') {
                    return sortOrder === 'desc' ? valB - valA : valA - valB;
                }
                return sortOrder === 'desc'
                    ? String(valB).localeCompare(String(valA))
                    : String(valA).localeCompare(String(valB));
            });
        }

        const results = typeof limit === 'number' && limit > 0 ? filtered.slice(0, limit) : filtered;
        return {
            matchedCount: filtered.length,
            totalCount: array.length,
            results,
            data: results
        };
    }
};

/**
 * Computes Levenshtein edit distance between two strings.
 */
export function computeLevenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

/**
 * Built-in string similarity tool.
 */
export const stringSimilarityTool: SwarmTool<
    any,
    { similarity: number; metric: string; identical: boolean; jaccardSimilarity?: number; levenshteinSimilarity?: number }
> = {
    name: 'string_similarity',
    description: 'Calculates text similarity score (0.0 to 1.0) using Jaccard word token overlap or normalized Levenshtein distance.',
    parameters: {
        string1: {
            type: 'string',
            description: 'First string to compare (or stringA)',
            required: true
        },
        string2: {
            type: 'string',
            description: 'Second string to compare (or stringB)',
            required: true
        },
        metric: {
            type: 'string',
            description: 'Similarity metric: "jaccard", "levenshtein", or "all" (default: "jaccard")',
            required: false
        }
    },
    execute(rawParams: any) {
        const string1 = rawParams.string1 || rawParams.stringA || rawParams.a || rawParams.str1;
        const string2 = rawParams.string2 || rawParams.stringB || rawParams.b || rawParams.str2;
        const metric = rawParams.metric || 'jaccard';

        if (typeof string1 !== 'string' || typeof string2 !== 'string') {
            throw new Error('string_similarity requires two strings to compare.');
        }

        const maxLen = Math.max(string1.length, string2.length);
        const dist = maxLen === 0 ? 0 : computeLevenshteinDistance(string1, string2);
        const levSim = maxLen === 0 ? 1.0 : Number((1 - dist / maxLen).toFixed(4));

        const tokenize = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean));
        const setA = tokenize(string1);
        const setB = tokenize(string2);

        let jaccardSim = 1.0;
        if (setA.size === 0 && setB.size === 0) {
            jaccardSim = 1.0;
        } else if (setA.size === 0 || setB.size === 0) {
            jaccardSim = 0.0;
        } else {
            let intersection = 0;
            for (const token of setA) {
                if (setB.has(token)) intersection++;
            }
            const union = new Set([...setA, ...setB]).size;
            jaccardSim = Number((intersection / union).toFixed(4));
        }

        const identical = dist === 0;
        let mainSim = jaccardSim;
        if (metric === 'levenshtein') {
            mainSim = levSim;
        } else if (metric === 'all') {
            mainSim = Number(((jaccardSim + levSim) / 2).toFixed(4));
        }

        return {
            similarity: mainSim,
            metric,
            identical,
            jaccardSimilarity: jaccardSim,
            levenshteinSimilarity: levSim
        };
    }
};

/**
 * Built-in date and duration calculator tool.
 */
export const dateMathTool: SwarmTool<
    any,
    any
> = {
    name: 'date_math',
    description: 'Calculates the duration/difference between two dates or performs date arithmetic (add/subtract).',
    parameters: {
        startDate: {
            type: 'string',
            description: 'Starting date/timestamp in ISO or parseable format (or dateA)',
            required: true
        },
        endDate: {
            type: 'string',
            description: 'Ending date/timestamp (or dateB)',
            required: false
        },
        operation: {
            type: 'string',
            description: 'Operation: "diff", "add", or "subtract" (default: "diff")',
            required: false
        },
        amount: {
            type: 'number',
            description: 'Amount to add or subtract when operation is "add" or "subtract"',
            required: false
        },
        unit: {
            type: 'string',
            description: 'Unit: "seconds", "minutes", "hours", "days", "milliseconds" (default: "seconds")',
            required: false
        }
    },
    execute(rawParams: any) {
        const operation = rawParams.operation || 'diff';
        const rawStart = rawParams.startDate || rawParams.dateA || rawParams.start || rawParams.date;
        const rawEnd = rawParams.endDate || rawParams.dateB || rawParams.end;
        const unit = rawParams.unit || 'seconds';
        const amount = rawParams.amount ?? 0;

        const start = new Date(rawStart);
        if (isNaN(start.getTime())) throw new Error(`date_math: Invalid startDate '${rawStart}'`);

        if (operation === 'add' || operation === 'subtract') {
            const multiplier = operation === 'subtract' ? -1 : 1;
            let msOffset = 0;
            switch (unit) {
                case 'milliseconds':
                    msOffset = amount;
                    break;
                case 'seconds':
                    msOffset = amount * 1000;
                    break;
                case 'minutes':
                    msOffset = amount * 60000;
                    break;
                case 'hours':
                    msOffset = amount * 3600000;
                    break;
                case 'days':
                default:
                    msOffset = amount * 86400000;
                    break;
            }
            const resDate = new Date(start.getTime() + (msOffset * multiplier));
            return {
                operation,
                resultDate: resDate.toISOString(),
                startIso: start.toISOString(),
                amount,
                unit
            };
        }

        const end = rawEnd ? new Date(rawEnd) : new Date();
        if (isNaN(end.getTime())) throw new Error(`date_math: Invalid endDate '${rawEnd}'`);

        const diffMs = Math.abs(end.getTime() - start.getTime());
        let difference: number;

        switch (unit) {
            case 'milliseconds':
                difference = diffMs;
                break;
            case 'minutes':
                difference = Number((diffMs / 60000).toFixed(2));
                break;
            case 'hours':
                difference = Number((diffMs / 3600000).toFixed(2));
                break;
            case 'days':
                difference = Number((diffMs / 86400000).toFixed(2));
                break;
            case 'seconds':
            default:
                difference = Number((diffMs / 1000).toFixed(2));
                break;
        }

        return {
            difference,
            diff: difference,
            unit,
            isPast: (end.getTime() - start.getTime()) < 0,
            startIso: start.toISOString(),
            endIso: end.toISOString()
        };
    }
};

export const standardBuiltinTools: SwarmTool[] = [
    calculatorTool,
    statsSummaryTool,
    regexMatchTool,
    jsonExtractTool,
    dataFilterTool,
    stringSimilarityTool,
    dateMathTool
];
