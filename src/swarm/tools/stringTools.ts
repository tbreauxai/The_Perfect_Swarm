import type { SwarmTool } from './types.ts';

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
 * Computes Levenshtein edit distance between two strings.
 */
export function computeLevenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let v0 = new Int32Array(b.length + 1);
    let v1 = new Int32Array(b.length + 1);

    for (let i = 0; i <= b.length; i++) {
        v0[i] = i;
    }

    for (let i = 0; i < a.length; i++) {
        v1[0] = i + 1;

        for (let j = 0; j < b.length; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(
                v1[j] + 1,
                v0[j + 1] + 1,
                v0[j] + cost
            );
        }

        const temp = v0;
        v0 = v1;
        v1 = temp;
    }

    return v0[b.length];
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
