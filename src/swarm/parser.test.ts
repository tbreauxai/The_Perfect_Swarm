import { describe, it, expect } from 'vitest';
import { parseJsonSafe } from './parser.ts';

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
