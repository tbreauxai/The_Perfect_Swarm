import { describe, it, expect } from 'vitest';
import { extractJsonPath } from './builtin';

describe('extractJsonPath', () => {
    it('returns found: false for null or undefined data', () => {
        expect(extractJsonPath(null, 'path')).toEqual({ found: false, value: undefined });
        expect(extractJsonPath(undefined, 'path')).toEqual({ found: false, value: undefined });
    });

    it('returns original data for empty path or "."', () => {
        const data = { a: 1 };
        expect(extractJsonPath(data, '')).toEqual({ found: true, value: data });
        expect(extractJsonPath(data, '   ')).toEqual({ found: true, value: data });
        expect(extractJsonPath(data, '.')).toEqual({ found: true, value: data });
    });

    it('extracts value using dot notation', () => {
        const data = { user: { address: { city: 'New York' } } };
        expect(extractJsonPath(data, 'user.address.city')).toEqual({ found: true, value: 'New York' });
    });

    it('extracts value using bracket notation', () => {
        const data = { users: [{ name: 'Alice' }, { name: 'Bob' }] };
        expect(extractJsonPath(data, 'users[0].name')).toEqual({ found: true, value: 'Alice' });
        expect(extractJsonPath(data, 'users[1].name')).toEqual({ found: true, value: 'Bob' });
    });

    it('extracts value using mixed notation starting with bracket', () => {
        const data = [{ name: 'Alice' }];
        expect(extractJsonPath(data, '[0].name')).toEqual({ found: true, value: 'Alice' });
    });

    it('returns found: false for non-existent path', () => {
        const data = { user: { name: 'Alice' } };
        expect(extractJsonPath(data, 'user.age')).toEqual({ found: false, value: undefined });
        expect(extractJsonPath(data, 'company.name')).toEqual({ found: false, value: undefined });
    });

    it('returns found: false when intermediate value is null or undefined', () => {
        const data = { user: null };
        expect(extractJsonPath(data, 'user.name')).toEqual({ found: false, value: undefined });
    });

    it('returns found: false when attempting to access property on a primitive intermediate value', () => {
        const data = { user: "Alice" };
        expect(extractJsonPath(data, 'user.name')).toEqual({ found: false, value: undefined });
    });
});
