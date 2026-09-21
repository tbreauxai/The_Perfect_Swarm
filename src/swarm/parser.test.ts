import { describe, it, expect } from 'vitest';
import { guardVerificationResult } from './parser.ts';

describe('guardVerificationResult', () => {
    it('handles direct object input with pass and feedback', () => {
        const input = { pass: true, feedback: 'Great job!' };
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: 'Great job!' });
    });

    it('handles direct object input with missing feedback', () => {
        const input = { pass: false };
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: false, feedback: '' });
    });

    it('handles direct object input with passed property', () => {
        const input = { passed: true, feedback: 'Looks good.' };
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: 'Looks good.' });
    });

    it('handles direct object input with approved property', () => {
        const input = { approved: false, feedback: 'Needs work.' };
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: false, feedback: 'Needs work.' });
    });

    it('handles direct object input with passed property but no feedback', () => {
        const input = { passed: true };
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: 'Verification status evaluated.' });
    });

    it('handles direct object input with approved property but no feedback', () => {
        const input = { approved: true };
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: 'Approval status evaluated.' });
    });

    it('handles string input that can be parsed as JSON', () => {
        const input = JSON.stringify({ pass: true, feedback: 'String JSON works.' });
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: 'String JSON works.' });
    });

    it('handles plain string input with passing sentiment (VERIFICATION PASSED)', () => {
        const input = 'This is a long review, but ultimately VERIFICATION PASSED.';
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: input });
    });

    it('handles plain string input with passing sentiment ("PASS": TRUE)', () => {
        const input = '{"PASS": TRUE}';
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: true, feedback: input });
    });

    it('handles plain string input with failing sentiment (VERIFICATION FAILED)', () => {
        const input = 'VERIFICATION FAILED because of reasons.';
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: false, feedback: input });
    });

    it('handles plain string input with failing sentiment ("PASS": FALSE)', () => {
        const input = 'Here we have "PASS": FALSE';
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: false, feedback: input });
    });

    it('handles plain string input with failing sentiment (CRITIQUE FAILED)', () => {
        const input = 'CRITIQUE FAILED: not good enough.';
        const result = guardVerificationResult(input);
        expect(result).toEqual({ pass: false, feedback: input });
    });

    it('handles ambiguous input with fallback to fail', () => {
        const input = 'I am not sure what to say about this.';
        const result = guardVerificationResult(input);
        expect(result.pass).toBe(false);
        expect(result.feedback).toContain('Ambiguous critic output could not be verified:');
        expect(result.feedback).toContain(input);
    });

    it('handles ambiguous object input with fallback to fail', () => {
        const input = { something: 'else' };
        const result = guardVerificationResult(input);
        expect(result.pass).toBe(false);
        expect(result.feedback).toContain('Ambiguous critic output could not be verified:');
    });

    it('handles null input', () => {
        const input = null;
        const result = guardVerificationResult(input);
        expect(result.pass).toBe(false);
        expect(result.feedback).toContain('Ambiguous critic output could not be verified:');
    });
});
