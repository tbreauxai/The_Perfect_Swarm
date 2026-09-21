import { describe, it, expect } from 'vitest';
import { safeEvaluateMath } from './builtin.ts';

describe('safeEvaluateMath', () => {
    it('evaluates simple arithmetic operations', () => {
        expect(safeEvaluateMath('1 + 1')).toBe(2);
        expect(safeEvaluateMath('10 - 2')).toBe(8);
        expect(safeEvaluateMath('3 * 4')).toBe(12);
        expect(safeEvaluateMath('20 / 5')).toBe(4);
        expect(safeEvaluateMath('10 % 3')).toBe(1);
    });

    it('respects operator precedence', () => {
        expect(safeEvaluateMath('2 + 3 * 4')).toBe(14);
        expect(safeEvaluateMath('2 * 3 + 4')).toBe(10);
        expect(safeEvaluateMath('10 - 4 / 2')).toBe(8);
        expect(safeEvaluateMath('10 + 5 % 3')).toBe(12);
    });

    it('evaluates expressions with parentheses', () => {
        expect(safeEvaluateMath('(2 + 3) * 4')).toBe(20);
        expect(safeEvaluateMath('2 * (3 + 4)')).toBe(14);
        expect(safeEvaluateMath('(10 - 4) / 2')).toBe(3);
        expect(safeEvaluateMath('((1 + 2) * 3) - 4')).toBe(5);
    });

    it('handles decimal numbers', () => {
        expect(safeEvaluateMath('1.5 + 2.5')).toBe(4);
        expect(safeEvaluateMath('3.14 * 2')).toBe(6.28);
        expect(safeEvaluateMath('10 / 2.5')).toBe(4);
    });

    it('handles unary operators', () => {
        expect(safeEvaluateMath('-5 + 10')).toBe(5);
        expect(safeEvaluateMath('5 * -2')).toBe(-10);
        expect(safeEvaluateMath('+5 - +2')).toBe(3);
        expect(safeEvaluateMath('-(2 + 3)')).toBe(-5);
        expect(safeEvaluateMath('-1.5 * 2')).toBe(-3);
    });

    it('ignores whitespace in expressions', () => {
        expect(safeEvaluateMath('  2  +   3  ')).toBe(5);
        expect(safeEvaluateMath('\t4\n*\r5')).toBe(20);
    });

    it('throws error for division by zero', () => {
        expect(() => safeEvaluateMath('1 / 0')).toThrowError('Division by zero');
        expect(() => safeEvaluateMath('10 / (2 - 2)')).toThrowError('Division by zero');
    });

    it('throws error for modulo by zero', () => {
        expect(() => safeEvaluateMath('1 % 0')).toThrowError('Modulo by zero');
        expect(() => safeEvaluateMath('10 % (5 - 5)')).toThrowError('Modulo by zero');
    });

    it('throws error for unexpected end of expression', () => {
        expect(() => safeEvaluateMath('1 +')).toThrowError('Unexpected end of expression');
        expect(() => safeEvaluateMath('2 * ')).toThrowError('Unexpected end of expression');
        expect(() => safeEvaluateMath('')).toThrowError('Unexpected end of expression');
    });

    it('throws error for missing closing parenthesis', () => {
        expect(() => safeEvaluateMath('(1 + 2')).toThrowError("Missing closing parenthesis ')'");
        expect(() => safeEvaluateMath('2 * (3 + 4')).toThrowError("Missing closing parenthesis ')'");
    });

    it('throws error for unexpected characters', () => {
        expect(() => safeEvaluateMath('1 + a')).toThrowError("Unexpected character 'a' at index 2");
        expect(() => safeEvaluateMath('2 * x')).toThrowError("Unexpected character 'x' at index 2");
    });

    it('throws error for unexpected remaining characters', () => {
        expect(() => safeEvaluateMath('(1+2))')).toThrowError("Unexpected character ')' remaining at index 5");
    });
});
