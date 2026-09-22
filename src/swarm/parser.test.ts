import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJsonSafe, repairAndValidate } from './parser.ts';

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
