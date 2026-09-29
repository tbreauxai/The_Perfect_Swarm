import { describe, it, expect } from 'vitest';
import { sanitizeModelOutput, cleanToken } from './adapter.ts';

describe('Provider Adapter Output Sanitization', () => {
    it('cleans API tokens with various prefixes and whitespaces', () => {
        expect(cleanToken('Bearer sk-12345')).toBe('sk-12345');
        expect(cleanToken('Token ghp_xyz999 ')).toBe('ghp_xyz999');
        expect(cleanToken('  `sk-or-v1-abc`  ')).toBe('sk-or-v1-abc');
        expect(cleanToken(null)).toBe('');
    });

    it('strips <think>...</think> reasoning traces', () => {
        const raw = '<think>I should evaluate the database pool metrics first.</think>Final analysis result.';
        expect(sanitizeModelOutput(raw, false)).toBe('Final analysis result.');
    });

    it('strips <thought>...</thought> and <reasoning>...</reasoning> traces', () => {
        const raw = '<thought>Step 1: Check memory.</thought><reasoning>Step 2: Check CPU.</reasoning>Summary: System nominal.';
        expect(sanitizeModelOutput(raw, false)).toBe('Summary: System nominal.');
    });

    it('strips [THOUGHT]...[/THOUGHT] tags', () => {
        const raw = '[THOUGHT]Internal calculation: 10 + 20 = 30[/THOUGHT]The answer is 30.';
        expect(sanitizeModelOutput(raw, false)).toBe('The answer is 30.');
    });

    it('recovers from truncated unclosed reasoning tags before JSON', () => {
        const raw = '<think>Model was cut off before closing tag... {"ui_title": "Clean Analysis", "components": []}';
        const cleaned = sanitizeModelOutput(raw, true);
        expect(cleaned).toBe('{"ui_title": "Clean Analysis", "components": []}');
    });

    it('strips markdown code fences with various language specifiers', () => {
        const raw = '```json\n{"status": "ok", "value": 42}\n```';
        expect(sanitizeModelOutput(raw, true)).toBe('{"status": "ok", "value": 42}');

        const rawJavascript = '```javascript\n{"insights": ["all clear"]}\n```';
        expect(sanitizeModelOutput(rawJavascript, true)).toBe('{"insights": ["all clear"]}');
    });

    it('extracts top-level JSON array when requested', () => {
        const raw = 'Here is the array:\n```json\n[{"id": 1}, {"id": 2}]\n```\nHope that helps!';
        expect(sanitizeModelOutput(raw, true)).toBe('[{"id": 1}, {"id": 2}]');
    });
});
