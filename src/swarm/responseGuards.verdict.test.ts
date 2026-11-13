import { describe, it, expect } from 'vitest';
import { guardVerificationResult } from './parser/responseGuards.ts';

describe('guardVerificationResult verdict parsing', () => {
    it('accepts boolean and string verdict forms', () => {
        expect(guardVerificationResult({ pass: true })).toEqual({ pass: true, feedback: '' });
        expect(guardVerificationResult({ pass: 'true' })).toEqual({ pass: true, feedback: '' });
        expect(guardVerificationResult({ pass: 'FALSE' })).toEqual({ pass: false, feedback: '' });
        expect(guardVerificationResult({ verdict: 'pass' })).toEqual({ pass: true, feedback: '' });
        expect(guardVerificationResult({ verdict: 'reject' })).toEqual({ pass: false, feedback: '' });
        expect(guardVerificationResult({ verification: { pass: true }, feedback: 'ok' })).toEqual({ pass: true, feedback: 'ok' });
        expect(guardVerificationResult({ result: { approved: 'true' }, feedback: 'approved' })).toEqual({ pass: true, feedback: 'approved' });
    });

    it('treats explicit verifiable:false as a real fail without a parseFailed flag', () => {
        const result = guardVerificationResult({ verifiable: false, issues: ['No analysis text provided to audit.'], feedback: 'bad' });
        expect(result.pass).toBe(false);
        expect(result.feedback).toBe('No analysis text provided to audit.');
        expect(result.parseFailed).toBeUndefined();
    });

    it('rejects unsupported verdict shapes', () => {
        expect(guardVerificationResult({ verifiable: true })).toEqual({ pass: false, feedback: 'Critic output missing pass field.', parseFailed: true });
        expect(guardVerificationResult({ scorecards: [{ verdict: 'pass' }] })).toEqual({ pass: false, feedback: '', parseFailed: true });
        expect(guardVerificationResult({ a: { b: { pass: true } } })).toEqual({ pass: false, feedback: 'Critic output missing pass field.', parseFailed: true });
        expect(guardVerificationResult({ pass: 'maybe' })).toEqual({ pass: false, feedback: 'Critic output had an invalid pass value.', parseFailed: true });
        expect(guardVerificationResult({})).toEqual({ pass: false, feedback: 'Critic returned an empty object.', parseFailed: true });
    });
});
