import { describe, it, expect } from 'vitest';
import {
    parseJsonSafe,
    repairJson,
    repairAndValidate,
    guardAnalystResponse,
    guardManagerResponse,
    guardVerificationResult
} from './parser.ts';
import { z } from 'zod';

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

describe('repairJson', () => {
    it('returns empty object for empty or non-string input', () => {
        expect(repairJson('')).toBe('{}');
        expect(repairJson(null as any)).toBe('{}');
        expect(repairJson(undefined as any)).toBe('{}');
    });

    it('strips reasoning tags and markdown fences', () => {
        const input = `<think>
This is some thinking...
</think>
\`\`\`json
{"a": 1}
\`\`\`
`;
        expect(repairJson(input)).toBe('{"a": 1}');
    });

    it('handles unclosed think tags', () => {
        const input = `<think>
I should return a JSON
{"b": 2}`;
        expect(repairJson(input)).toBe('{"b": 2}');
    });

    it('repairs unquoted keys, python literals, and single quotes', () => {
        const input = `{ name: 'John', active: True, val: None }`;
        expect(repairJson(input)).toBe('{ "name": "John", "active": true, "val": null }');
    });

    it('strips comments', () => {
        const input = `{
            // single line comment
            "a": 1,
            /* multi
               line
               comment */
            "b": 2
        }`;
        expect(repairJson(input).replace(/\s+/g, '')).toBe('{"a":1,"b":2}');
    });

    it('repairs truncated JSON', () => {
        expect(repairJson('{"a": {"b": 1')).toBe('{"a": {"b": 1}}');
        expect(repairJson('{"a": 1, ')).toBe('{"a": 1}');
        expect(repairJson('{"a": "string without en')).toBe('{"a": "string without en"}');
        expect(repairJson('[{"a": 1}, {"b": 2')).toBe('[{"a": 1}, {"b": 2}]');
        expect(repairJson('{"key":')).toBe('{"key": null}');
    });
});

describe('repairAndValidate', () => {
    const TestSchema = z.object({
        name: z.string(),
        age: z.number(),
        insights: z.array(z.string()).optional()
    });

    it('returns success on valid input', () => {
        const input = { name: 'John', age: 30 };
        const result = repairAndValidate(input, TestSchema);
        expect(result.success).toBe(true);
        expect(result.data).toEqual(input);
        expect(result.repaired).toBe(false);
    });

    it('auto-coerces string with newlines to array for specific fields', () => {
        const input = { name: 'John', age: 30, insights: '- Insight 1\n* Insight 2' };
        const result = repairAndValidate(input, TestSchema);
        expect(result.success).toBe(true);
        expect(result.data.insights).toEqual(['Insight 1', 'Insight 2']);
        expect(result.repaired).toBe(true);
    });

    it('returns fallback and lists errors on failure', () => {
        const input = { name: 'John' }; // missing age
        const fallbackFactory = (raw: any, errors: string[]) => ({
            name: raw.name || 'Unknown',
            age: 0,
            insights: errors
        });
        const result = repairAndValidate(input, TestSchema, fallbackFactory);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({
            name: 'John',
            age: 0,
            insights: ['age: Invalid input: expected number, received undefined']
        });
        expect(result.repaired).toBe(true);
    });

    it('returns failure when no fallback is provided', () => {
        const input = { name: 'John' }; // missing age
        const result = repairAndValidate(input, TestSchema);
        expect(result.success).toBe(false);
        expect(result.errors).toContain('age: Invalid input: expected number, received undefined');
        expect(result.repaired).toBe(true);
    });
});

describe('guardAnalystResponse', () => {
    it('parses a standard valid response', () => {
        const input = {
            insights: ['A', 'B'],
            anomalies: ['C'],
            summary: 'Good'
        };
        const result = guardAnalystResponse(input);
        expect(result).toEqual(input);
    });

    it('coerces strings into arrays', () => {
        const input = {
            insights: 'Just one insight',
            anomalies: 'Just one anomaly'
        };
        const result = guardAnalystResponse(input);
        expect(result.insights).toEqual(['Just one insight']);
        expect(result.anomalies).toEqual(['Just one anomaly']);
    });

    it('handles empty or missing fields and provides fallbacks', () => {
        const result = guardAnalystResponse({});
        expect(result.insights.length).toBe(1);
        expect(result.insights[0]).toContain('[Analyst]');
        expect(result.anomalies).toEqual([]);
        expect(result.summary).toContain('assessment completed');
    });
});

describe('guardManagerResponse', () => {
    it('returns valid components natively', () => {
        const input = {
            ui_title: 'Title',
            components: [
                {
                    id: '1',
                    type: 'MetricCard',
                    props: { title: 'T', value: 'V', trend: 'up' }
                }
            ]
        };
        const result = guardManagerResponse(input);
        expect(result.ui_title).toBe('Title');
        expect(result.components[0].type).toBe('MetricCard');
    });

    it('salvages poorly formatted components', () => {
        const input = {
            components: [
                {
                    type: 'MetricCard',
                    props: { title: 'T', value: 'V' } // missing id and trend
                }
            ]
        };
        const result = guardManagerResponse(input);
        expect(result.components.length).toBe(1);
        expect(result.components[0].type).toBe('MetricCard');
        expect(result.components[0].id).toBe('metric-0');
    });

    it('falls back to InsightList if no valid components exist', () => {
        const input = { insights: ['Something cool'] };
        const result = guardManagerResponse(input);
        expect(result.components.length).toBe(1);
        expect(result.components[0].type).toBe('InsightList');
        // @ts-ignore
        expect(result.components[0].props.insights[0].message).toBe('Something cool');
    });
});

describe('guardVerificationResult', () => {
    it('extracts from valid objects directly', () => {
        expect(guardVerificationResult({ pass: true, feedback: 'ok' })).toEqual({ pass: true, feedback: 'ok' });
        expect(guardVerificationResult({ passed: false, feedback: 'bad' })).toEqual({ pass: false, feedback: 'bad' });
        expect(guardVerificationResult({ approved: true })).toEqual({ pass: true, feedback: 'Approval status evaluated.' });
    });

    it('parses JSON strings', () => {
        expect(guardVerificationResult('{"pass": true, "feedback": "good"}')).toEqual({ pass: true, feedback: 'good' });
    });

    it('uses text heuristics', () => {
        expect(guardVerificationResult('The test VERIFICATION PASSED easily.')).toEqual({ pass: true, feedback: 'The test VERIFICATION PASSED easily.' });
        expect(guardVerificationResult('This CRITIQUE FAILED miserably.')).toEqual({ pass: false, feedback: 'This CRITIQUE FAILED miserably.' });
    });

    it('falls back to false for ambiguous strings', () => {
        const result = guardVerificationResult('I am not sure what to say about this.');
        expect(result.pass).toBe(false);
        expect(result.feedback).toContain('Ambiguous critic output could not be verified');
    });
});
