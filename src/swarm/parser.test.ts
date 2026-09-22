import { describe, it, expect } from 'vitest';
import { parseJsonSafe, guardManagerResponse } from './parser.ts';

describe('parseJsonSafe', () => {
    it('returns the object directly if the input is an object', () => {
        const input = { a: 1, b: 'two' };
        expect(parseJsonSafe(input)).toEqual(input);
    });

    it('returns fallback or empty object if input is not a string or object', () => {
        expect(parseJsonSafe(42)).toEqual({});
        expect(parseJsonSafe(true)).toEqual({});
        expect(parseJsonSafe(null)).toEqual({});
        expect(parseJsonSafe(undefined)).toEqual({});

        expect(parseJsonSafe(42, { fallback: true })).toEqual({ fallback: true });
        expect(parseJsonSafe(null, { default: 'val' })).toEqual({ default: 'val' });
    });

    it('returns fallback or empty object if string is empty or whitespace', () => {
        expect(parseJsonSafe('')).toEqual({});
        expect(parseJsonSafe('   ')).toEqual({});

        expect(parseJsonSafe('', { empty: true })).toEqual({ empty: true });
    });

    it('parses valid JSON string', () => {
        expect(parseJsonSafe('{"hello": "world"}')).toEqual({ hello: 'world' });
        expect(parseJsonSafe('[1, 2, 3]')).toEqual([1, 2, 3]);
        expect(parseJsonSafe('"string"')).toEqual('string');
        expect(parseJsonSafe('42')).toEqual(42);
        expect(parseJsonSafe('true')).toEqual(true);
        expect(parseJsonSafe('null')).toEqual(null);
    });

    it('parses JSON string with extra text around it', () => {
        const input = `
Some text before the json
{
    "key": "value"
}
Some text after the json
        `;
        expect(parseJsonSafe(input)).toEqual({ key: 'value' });
    });

    it('parses JSON inside markdown fences', () => {
        const input = `
\`\`\`json
{
    "status": "success",
    "data": [1, 2]
}
\`\`\`
`;
        expect(parseJsonSafe(input)).toEqual({ status: 'success', data: [1, 2] });
    });

    it('parses JSON string with trailing commas', () => {
        const input = `
        {
            "a": 1,
            "b": 2,
        }
        `;
        expect(parseJsonSafe(input)).toEqual({ a: 1, b: 2 });
    });

    it('parses JSON with unquoted keys', () => {
        const input = `{ name: "John", age: 30 }`;
        expect(parseJsonSafe(input)).toEqual({ name: 'John', age: 30 });
    });

    it('parses JSON with single quotes', () => {
        const input = `{ 'key': 'value', 'number': 42 }`;
        expect(parseJsonSafe(input)).toEqual({ key: 'value', number: 42 });
    });

    it('parses Python literal syntax (True/False/None)', () => {
        const input = `{ "active": True, "payload": None, "deleted": False }`;
        expect(parseJsonSafe(input)).toEqual({ active: true, payload: null, deleted: false });
    });

    it('falls back to fuzzy regex extraction if standard parsing and repairing fail', () => {
        const input = `
summary: this is great
insights:
- a
- b
anomalies: none
        `;
        const result = parseJsonSafe(input);
        expect(result).toHaveProperty('summary', 'this is great');
        expect(result).toHaveProperty('insights', ['a', 'b']);
        expect(result).toHaveProperty('anomalies', []);
    });

    it('returns fallback when everything fails', () => {
        const input = `This is just a random string with no recognizable json or key value pairs`;
        expect(parseJsonSafe(input)).toEqual({ anomalies: [] }); // extractFuzzyFields returns { anomalies: [] } when nothing matches
        expect(parseJsonSafe(input, { failed: true })).toEqual({ anomalies: [] });
    });
});

describe('guardManagerResponse', () => {
    it('passes a fully valid ManagerResponse directly through', () => {
        const validResponse = {
            ui_title: 'Valid Response',
            components: [
                {
                    id: 'metric-1',
                    type: 'MetricCard',
                    props: {
                        title: 'Total Users',
                        value: '10,000',
                        trend: 'up'
                    }
                }
            ]
        };
        const result = guardManagerResponse(validResponse);
        expect(result).toEqual(validResponse);
    });

    it('salvages valid components from an invalid ManagerResponse', () => {
        const invalidResponse = {
            ui_title: 'Partially Invalid Response',
            components: [
                {
                    type: 'MetricCard', // Missing ID
                    props: {
                        title: 'Total Revenue',
                        value: '$50,000',
                        trend: 'invalid_trend' // Will be normalized
                    }
                },
                {
                    type: 'InvalidComponent',
                    props: {}
                }
            ]
        };
        const result = guardManagerResponse(invalidResponse);
        expect(result.ui_title).toBe('Partially Invalid Response');
        expect(result.components).toHaveLength(1);
        expect(result.components[0].type).toBe('MetricCard');
        expect(result.components[0].id).toBe('metric-0'); // Auto-generated ID

        // Assert props correctly, especially trend normalization
        const props = result.components[0].props as any;
        expect(props.title).toBe('Total Revenue');
        expect(props.value).toBe('$50,000');
        expect(props.trend).toBe(undefined); // 'invalid_trend' normalizes to undefined
    });

    it('falls back to generating InsightList using insights array from raw input', () => {
        const inputWithInsights = {
            insights: ['Insight 1', 'Insight 2']
        };
        const result = guardManagerResponse(inputWithInsights);
        expect(result.ui_title).toBe('Executive Swarm Synthesis');
        expect(result.components).toHaveLength(1);
        expect(result.components[0].type).toBe('InsightList');

        const props = result.components[0].props as any;
        expect(props.title).toBe('Synthesis Findings');
        expect(props.insights).toHaveLength(2);
        expect(props.insights[0].message).toBe('Insight 1');
        expect(props.insights[1].message).toBe('Insight 2');
    });

    it('falls back to generating InsightList using summary from raw input', () => {
        const inputWithSummary = {
            summary: 'This is a summary.'
        };
        const result = guardManagerResponse(inputWithSummary);
        expect(result.components).toHaveLength(1);
        expect(result.components[0].type).toBe('InsightList');

        const props = result.components[0].props as any;
        expect(props.insights).toHaveLength(1);
        expect(props.insights[0].message).toBe('This is a summary.');
    });

    it('gracefully generates a fallback for completely random strings', () => {
        const randomString = "This is a random string with no structure.";
        const result = guardManagerResponse(randomString);
        expect(result.components).toHaveLength(1);
        expect(result.components[0].type).toBe('InsightList');

        const props = result.components[0].props as any;
        expect(props.insights).toHaveLength(1);
        expect(props.insights[0].message).toBe(randomString); // The string itself is used as the message up to 200 chars
    });
});
