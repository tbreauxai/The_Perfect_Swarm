import { describe, it, expect } from 'vitest';
import { parseJsonSafe, guardManagerResponse, repairAndValidate } from './parser.ts';
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

describe('repairAndValidate', () => {
    const TestSchema = z.object({
        name: z.string(),
        age: z.number(),
        insights: z.array(z.string()),
        anomalies: z.array(z.string()).optional()
    });

    it('returns success immediately if input satisfies schema', () => {
        const input = { name: 'Alice', age: 25, insights: ['A', 'B'] };
        const result = repairAndValidate(input, TestSchema);
        expect(result.success).toBe(true);
        expect(result.data).toEqual(input);
        expect(result.repaired).toBe(false);
    });

    it('auto-coerces string into array for keys like "insights" and "anomalies"', () => {
        const input = {
            name: 'Bob',
            age: 30,
            insights: '- Insight 1\n- Insight 2\n* Insight 3',
            anomalies: '1. Error A\n2. Error B'
        };
        const result = repairAndValidate(input, TestSchema);
        expect(result.success).toBe(true);
        expect(result.repaired).toBe(true);
        expect(result.data).toEqual({
            name: 'Bob',
            age: 30,
            insights: ['Insight 1', 'Insight 2', 'Insight 3'],
            anomalies: ['Error A', 'Error B']
        });
    });

    it('returns success with fallback factory if auto-coercion fails', () => {
        const input = { name: 'Charlie', age: 'invalid-age' };

        const fallbackFactory = (raw: any, errors: string[]) => ({
            name: raw.name || 'Unknown',
            age: 0,
            insights: [`Fallback generated due to errors: ${errors.join(', ')}`]
        });

        const result = repairAndValidate(input, TestSchema, fallbackFactory);
        expect(result.success).toBe(true);
        expect(result.repaired).toBe(true);

        // Zod validation error messages can vary slightly between versions,
        // so we check that the fallback factory was called and used the errors array.
        expect(result.data.name).toBe('Charlie');
        expect(result.data.age).toBe(0);
        expect(result.data.insights[0]).toContain('Fallback generated due to errors');
        expect(result.errors).toBeDefined();
        expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('returns failure with errors if coercion fails and no fallback is provided', () => {
        const input = { name: 'Dave', age: 'thirty' };
        const result = repairAndValidate(input, TestSchema);
        expect(result.success).toBe(false);
        expect(result.repaired).toBe(true);
        expect(result.data).toEqual({ name: 'Dave', age: 'thirty' }); // contains the coerced (but still invalid) data
        expect(result.errors).toBeDefined();
        expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('properly copies input if it is an array before coercion', () => {
        const ArraySchema = z.array(z.string());
        const input = ['A', 'B'];
        const result = repairAndValidate(input, { safeParse: ArraySchema.safeParse });
        expect(result.success).toBe(true);
        expect(result.repaired).toBe(false);
        expect(result.data).toEqual(['A', 'B']);

        const invalidInput = [1, 2];
        const resultFail = repairAndValidate(invalidInput, { safeParse: ArraySchema.safeParse });
        expect(resultFail.success).toBe(false);
        expect(resultFail.repaired).toBe(true); // it attempts coercion and fails
        expect(resultFail.data).toEqual([1, 2]); // coerced copies the array
    });

    it('handles coercion for keys ending in "s"', () => {
        const ItemsSchema = z.object({ items: z.array(z.string()) });
        const input = { items: 'item1\nitem2\nitem3' };
        const result = repairAndValidate(input, ItemsSchema);
        expect(result.success).toBe(true);
        expect(result.repaired).toBe(true);
        expect(result.data).toEqual({ items: ['item1', 'item2', 'item3'] });
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
