import { describe, it, expect } from 'vitest';
import { extractJsonPath, computeLevenshteinDistance, safeEvaluateMath } from './builtin.ts';

import {
    calculatorTool,
    dataFilterTool,
    stringSimilarityTool,
    dateMathTool,
    varianceTool,
    standardDeviationTool,
    probabilityTool,
    trendSlopeTool,
    statsSummaryTool,
    regexMatchTool,
    jsonExtractTool
} from './builtin.ts';

describe('Builtin Tools', () => {
    describe('safeEvaluateMath', () => {
        it('evaluates basic arithmetic', () => {
            expect(safeEvaluateMath('2 + 3')).toBe(5);
            expect(safeEvaluateMath('10 - 4')).toBe(6);
            expect(safeEvaluateMath('4 * 5')).toBe(20);
            expect(safeEvaluateMath('20 / 4')).toBe(5);
            expect(safeEvaluateMath('10 % 3')).toBe(1);
        });

        it('handles precedence and parentheses', () => {
            expect(safeEvaluateMath('2 + 3 * 4')).toBe(14);
            expect(safeEvaluateMath('(2 + 3) * 4')).toBe(20);
            expect(safeEvaluateMath('10 - 2 * (3 + 1)')).toBe(2);
            expect(safeEvaluateMath('((15 * 4) + 120) / 1.5')).toBe(120);
        });

        it('handles negative numbers', () => {
            expect(safeEvaluateMath('-5 + 10')).toBe(5);
            expect(safeEvaluateMath('10 * -2')).toBe(-20);
            expect(safeEvaluateMath('-10 / -2')).toBe(5);
        });

        it('handles floats', () => {
            expect(safeEvaluateMath('2.5 * 4')).toBe(10);
            expect(safeEvaluateMath('10.5 - 2.5')).toBe(8);
        });

        it('throws on division by zero', () => {
            expect(() => safeEvaluateMath('10 / 0')).toThrow('Division by zero');
            expect(() => safeEvaluateMath('10 % 0')).toThrow('Modulo by zero');
        });

        it('throws on invalid syntax', () => {
            expect(() => safeEvaluateMath('(2 + 3')).toThrow("Missing closing parenthesis ')'");
            expect(() => safeEvaluateMath('2 + a')).toThrow("Unexpected character 'a'");
            expect(() => safeEvaluateMath('2 + ')).toThrow('Unexpected end of expression');
        });
    });

    describe('extractJsonPath', () => {
        const testData = {
            user: {
                id: 1,
                profile: {
                    name: 'Alice',
                    email: 'alice@example.com'
                },
                tags: ['admin', 'user'],
                metrics: [
                    { type: 'login', count: 10 },
                    { type: 'logout', count: 5 }
                ]
            }
        };

        it('extracts root properties', () => {
            expect(extractJsonPath(testData, 'user')).toEqual({ found: true, value: testData.user });
        });

        it('extracts nested properties with dot notation', () => {
            expect(extractJsonPath(testData, 'user.profile.name')).toEqual({ found: true, value: 'Alice' });
        });

        it('extracts array elements with bracket notation', () => {
            expect(extractJsonPath(testData, 'user.tags[0]')).toEqual({ found: true, value: 'admin' });
            expect(extractJsonPath(testData, 'user.metrics[1].type')).toEqual({ found: true, value: 'logout' });
        });

        it('handles missing paths', () => {
            expect(extractJsonPath(testData, 'user.missing')).toEqual({ found: false, value: undefined });
            expect(extractJsonPath(testData, 'user.tags[5]')).toEqual({ found: false, value: undefined });
            expect(extractJsonPath(testData, 'invalid.path')).toEqual({ found: false, value: undefined });
        });

        it('handles root or empty paths', () => {
            expect(extractJsonPath(testData, '')).toEqual({ found: true, value: testData });
            expect(extractJsonPath(testData, '.')).toEqual({ found: true, value: testData });
        });

        it('handles null or undefined data', () => {
            expect(extractJsonPath(null, 'path')).toEqual({ found: false, value: undefined });
            expect(extractJsonPath(undefined, 'path')).toEqual({ found: false, value: undefined });
        });
    });

    describe('computeLevenshteinDistance', () => {
        it('calculates distance correctly', () => {
            expect(computeLevenshteinDistance('kitten', 'sitting')).toBe(3);
            expect(computeLevenshteinDistance('flaw', 'lawn')).toBe(2);
            expect(computeLevenshteinDistance('hello', 'hello')).toBe(0);
            expect(computeLevenshteinDistance('', '')).toBe(0);
            expect(computeLevenshteinDistance('a', '')).toBe(1);
            expect(computeLevenshteinDistance('', 'a')).toBe(1);
        });
    });

    describe('calculatorTool', () => {
        it('executes valid expressions', async () => {
            const res = await calculatorTool.execute({ expression: '2 * (3 + 4)' });
            expect(res).toEqual({ expression: '2 * (3 + 4)', result: 14 });
        });

        it('throws on invalid inputs', async () => {
            expect(() => calculatorTool.execute({ expression: '' } as any)).toThrow('Calculator requires a string expression parameter.');
            expect(() => calculatorTool.execute({} as any)).toThrow('Calculator requires a string expression parameter.');
        });
    });

    describe('statsSummaryTool', () => {
        it('computes summary statistics correctly', async () => {
            const res = await statsSummaryTool.execute({ numbers: [1, 2, 3, 4, 5] });
            expect(res).toEqual({
                count: 5,
                sum: 15,
                mean: 3,
                median: 3,
                min: 1,
                max: 5,
                variance: 2,
                stdDev: Number(Math.sqrt(2).toFixed(4))
            });
        });

        it('computes median for even number of elements', async () => {
            const res = await statsSummaryTool.execute({ numbers: [1, 2, 3, 4] });
            expect(res.median).toBe(2.5);
        });

        it('handles invalid numbers gracefully by filtering them out', async () => {
            const res = await statsSummaryTool.execute({ numbers: [1, 'a' as any, 3, NaN] });
            expect(res.count).toBe(2);
            expect(res.sum).toBe(4);
        });

        it('throws on empty or invalid arrays', async () => {
            expect(() => statsSummaryTool.execute({ numbers: [] })).toThrow('stats_summary requires a non-empty array of numbers.');
            expect(() => statsSummaryTool.execute({ numbers: ['a', 'b'] as any })).toThrow('No valid numbers provided in numbers array.');
            expect(() => statsSummaryTool.execute({} as any)).toThrow('stats_summary requires a non-empty array of numbers.');
        });
    });

    describe('regexMatchTool', () => {
        it('matches patterns globally by default', async () => {
            const res = await regexMatchTool.execute({ pattern: '\\d+', text: 'a12b34c56' });
            expect(res.matched).toBe(true);
            expect(res.matchCount).toBe(3);
            expect(res.matches).toEqual(['12', '34', '56']);
            expect(res.groups).toEqual([]);
        });

        it('matches patterns without global flag', async () => {
            const res = await regexMatchTool.execute({ pattern: '\\d+', text: 'a12b34c56', flags: '' });
            expect(res.matchCount).toBe(1);
            expect(res.matches).toEqual(['12']);
        });

        it('extracts named groups', async () => {
            const res = await regexMatchTool.execute({ pattern: '(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})', text: '2023-10-25' });
            expect(res.matched).toBe(true);
            expect(res.groups).toHaveLength(1);
            expect(res.groups[0]).toEqual({ year: '2023', month: '10', day: '25' });
        });

        it('throws on invalid inputs', async () => {
            expect(() => regexMatchTool.execute({ pattern: '', text: 'abc' })).toThrow('Pattern must be a string.');
            expect(() => regexMatchTool.execute({ pattern: 'a', text: 123 as any })).toThrow('Text must be a string.');
        });
    });

    describe('jsonExtractTool', () => {
        it('extracts from objects', async () => {
            const data = { a: { b: { c: 1 } } };
            const res = await jsonExtractTool.execute({ data, path: 'a.b.c' });
            expect(res).toEqual({ found: true, path: 'a.b.c', value: 1 });
        });

        it('extracts from strings', async () => {
            const dataStr = '{"a": {"b": {"c": 1}}}';
            const res = await jsonExtractTool.execute({ data: dataStr, path: 'a.b.c' });
            expect(res).toEqual({ found: true, path: 'a.b.c', value: 1 });
        });

        it('throws on invalid JSON strings', async () => {
            expect(() => jsonExtractTool.execute({ data: 'invalid json', path: 'a' })).toThrow(/json_extract failed to parse string as JSON/);
        });
    });

    describe('dataFilterTool', () => {
        const data = [
            { id: 1, name: 'Alice', age: 30, active: true },
            { id: 2, name: 'Bob', age: 25, active: false },
            { id: 3, name: 'Charlie', age: 35, active: true }
        ];

        it('filters by equality', async () => {
            const res = await dataFilterTool.execute({ items: data, field: 'active', operator: '==', value: true });
            expect(res.matchedCount).toBe(2);
            expect(res.results.map((r: any) => r.name)).toEqual(['Alice', 'Charlie']);
        });

        it('filters by greater than', async () => {
            const res = await dataFilterTool.execute({ items: data, field: 'age', operator: '>', value: 25 });
            expect(res.matchedCount).toBe(2);
        });

        it('filters by contains', async () => {
            const res = await dataFilterTool.execute({ items: data, field: 'name', operator: 'contains', value: 'li' });
            expect(res.matchedCount).toBe(2); // Alice, Charlie
        });

        it('filters by in (array)', async () => {
            const res = await dataFilterTool.execute({ items: data, field: 'name', operator: 'in', value: ['Alice', 'Bob'] });
            expect(res.matchedCount).toBe(2);
        });

        it('filters by in (string comma separated)', async () => {
            const res = await dataFilterTool.execute({ items: data, field: 'name', operator: 'in', value: 'Alice, Bob' });
            expect(res.matchedCount).toBe(2);
        });

        it('sorts and limits results', async () => {
            const res = await dataFilterTool.execute({ items: data, field: 'age', operator: '>', value: 0, sortBy: 'age', sortOrder: 'desc', limit: 2 });
            expect(res.matchedCount).toBe(3);
            expect(res.results).toHaveLength(2);
            expect(res.results[0].name).toBe('Charlie'); // age 35
            expect(res.results[1].name).toBe('Alice'); // age 30
        });

        it('handles stringified JSON arrays', async () => {
            const res = await dataFilterTool.execute({ items: JSON.stringify(data) as any, field: 'id', operator: '==', value: 1 });
            expect(res.matchedCount).toBe(1);
        });

        it('throws on invalid data', async () => {
            expect(() => dataFilterTool.execute({ items: 'not an array' as any, field: 'id', value: 1 })).toThrow('data_filter: items must be an array of objects.');
            expect(() => dataFilterTool.execute({ items: {} as any, field: 'id', value: 1 })).toThrow('data_filter requires an array of items.');
        });
    });

    describe('stringSimilarityTool', async () => {
        it('calculates identical strings similarity', async () => {
            const res = await stringSimilarityTool.execute({ string1: 'test', string2: 'test', metric: 'all' });
            expect(res.identical).toBe(true);
            expect(res.similarity).toBe(1.0);
            expect(res.jaccardSimilarity).toBe(1.0);
            expect(res.levenshteinSimilarity).toBe(1.0);
        });

        it('calculates similarity for different strings', async () => {
            const res = await stringSimilarityTool.execute({ string1: 'kitten', string2: 'sitting', metric: 'levenshtein' });
            expect(res.identical).toBe(false);
            expect(res.metric).toBe('levenshtein');
            // length 7, distance 3. lev = 1 - 3/7 = 0.5714
            expect(res.similarity).toBe(0.5714);
        });

        it('calculates jaccard similarity', async () => {
            const res = await stringSimilarityTool.execute({ string1: 'the quick brown fox', string2: 'the quick red fox', metric: 'jaccard' });
            // setA = {the, quick, brown, fox} (size 4)
            // setB = {the, quick, red, fox} (size 4)
            // intersection = 3, union = 5, jaccard = 3/5 = 0.6
            expect(res.similarity).toBe(0.6);
        });

        it('throws on invalid inputs', async () => {
            expect(() => stringSimilarityTool.execute({ string1: 'test' })).toThrow('string_similarity requires two strings to compare.');
        });
    });

    describe('dateMathTool', async () => {
        const d1 = '2023-01-01T12:00:00Z';
        const d2 = '2023-01-02T12:00:00Z'; // 1 day later

        it('calculates date differences', async () => {
            const res = await dateMathTool.execute({ startDate: d1, endDate: d2, operation: 'diff', unit: 'days' });
            expect(res.diff).toBe(1);
            expect(res.unit).toBe('days');
            expect(res.isPast).toBe(false);
        });

        it('adds time to dates', async () => {
            const res = await dateMathTool.execute({ startDate: d1, operation: 'add', amount: 1, unit: 'days' });
            expect(res.resultDate).toBe(new Date(d2).toISOString());
        });

        it('subtracts time from dates', async () => {
            const res = await dateMathTool.execute({ startDate: d2, operation: 'subtract', amount: 1, unit: 'days' });
            expect(res.resultDate).toBe(new Date(d1).toISOString());
        });

        it('throws on invalid dates', async () => {
            expect(() => dateMathTool.execute({ startDate: 'invalid date' })).toThrow("date_math: Invalid startDate 'invalid date'");
            expect(() => dateMathTool.execute({ startDate: d1, endDate: 'invalid date' })).toThrow("date_math: Invalid endDate 'invalid date'");
        });
    });

    describe('varianceTool', async () => {
        it('calculates population variance', async () => {
            const res = await varianceTool.execute({ numbers: [1, 2, 3, 4, 5] });
            expect(res.variance).toBe(2);
        });

        it('calculates sample variance', async () => {
            const res = await varianceTool.execute({ numbers: [1, 2, 3, 4, 5], sample: true });
            expect(res.variance).toBe(2.5);
        });

        it('handles sample variance for size 1', async () => {
            const res = await varianceTool.execute({ numbers: [1], sample: true });
            expect(res.variance).toBe(0);
        });

        it('throws on invalid inputs', async () => {
            expect(() => varianceTool.execute({ numbers: [] })).toThrow('variance requires a non-empty array of numbers.');
            expect(() => varianceTool.execute({ numbers: ['a'] as any })).toThrow('No valid numbers provided.');
        });
    });

    describe('standardDeviationTool', async () => {
        it('calculates population standard deviation', async () => {
            const res = await standardDeviationTool.execute({ numbers: [1, 2, 3, 4, 5] });
            expect(res.stdDev).toBe(Number(Math.sqrt(2).toFixed(4)));
        });

        it('calculates sample standard deviation', async () => {
            const res = await standardDeviationTool.execute({ numbers: [1, 2, 3, 4, 5], sample: true });
            expect(res.stdDev).toBe(Number(Math.sqrt(2.5).toFixed(4)));
        });
    });

    describe('probabilityTool', async () => {
        it('converts decimal odds', async () => {
            const res = await probabilityTool.execute({ odds: 2.0 });
            expect(res.impliedProbability).toBe(0.5);
            expect(res.americanOdds).toBe('+100');
            expect(res.fractionalOdds).toBe('1/1');
        });

        it('converts american odds (positive)', async () => {
            const res = await probabilityTool.execute({ odds: '+150', format: 'american' });
            expect(res.decimalOdds).toBe(2.5);
            expect(res.impliedProbability).toBe(0.4);
        });

        it('converts american odds (negative)', async () => {
            const res = await probabilityTool.execute({ odds: '-200', format: 'american' });
            expect(res.decimalOdds).toBe(1.5);
            expect(res.impliedProbability).toBe(Number((1/1.5).toFixed(4)));
        });

        it('converts fractional odds', async () => {
            const res = await probabilityTool.execute({ odds: '3/1', format: 'fractional' });
            expect(res.decimalOdds).toBe(4.0);
            expect(res.impliedProbability).toBe(0.25);
        });

        it('auto-detects formats', async () => {
            expect((await probabilityTool.execute({ odds: '5/2' }) as any).format).toBeUndefined(); // format key isn't returned, but it shouldn't error
            expect((await probabilityTool.execute({ odds: '+200' }) as any).decimalOdds).toBe(3.0);
            expect((await probabilityTool.execute({ odds: 1.5 }) as any).americanOdds).toBe('-200');
        });

        it('throws on invalid inputs', async () => {
            expect(() => probabilityTool.execute({ odds: '1/0', format: 'fractional' })).toThrow('Invalid fractional odds format.');
            expect(() => probabilityTool.execute({ odds: 'abc', format: 'american' })).toThrow('Invalid american odds format.');
            expect(() => probabilityTool.execute({ odds: 0, format: 'american' })).toThrow('American odds cannot be 0.');
            expect(() => probabilityTool.execute({ odds: 0.5, format: 'decimal' })).toThrow('Invalid decimal odds format.');
        });
    });

    describe('trendSlopeTool', async () => {
        it('calculates positive trend from array of numbers', async () => {
            const res = await trendSlopeTool.execute({ data: [1, 2, 3, 4, 5] });
            expect(res.trend).toBe('positive');
            expect(res.slope).toBe(1);
        });

        it('calculates negative trend from array of numbers', async () => {
            const res = await trendSlopeTool.execute({ data: [5, 4, 3, 2, 1] });
            expect(res.trend).toBe('negative');
            expect(res.slope).toBe(-1);
        });

        it('calculates flat trend', async () => {
            const res = await trendSlopeTool.execute({ data: [1, 1, 1, 1, 1] });
            expect(res.trend).toBe('flat');
            expect(res.slope).toBe(0);
        });

        it('calculates trend from {x, y} objects', async () => {
            const res = await trendSlopeTool.execute({ data: [{x: 0, y: 10}, {x: 1, y: 20}, {x: 2, y: 30}] });
            expect(res.trend).toBe('positive');
            expect(res.slope).toBe(10);
        });

        it('throws on invalid inputs', async () => {
            expect(() => trendSlopeTool.execute({ data: [] })).toThrow('trend_slope requires an array with at least 2 data points.');
            expect(() => trendSlopeTool.execute({ data: [1] })).toThrow('trend_slope requires an array with at least 2 data points.');
            expect(() => trendSlopeTool.execute({ data: ['a', 'b'] as any })).toThrow('Invalid data format. Must be array of numbers or {x,y} objects.');
        });
    });
});
