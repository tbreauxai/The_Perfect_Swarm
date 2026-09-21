import { describe, it, expect } from 'vitest';
import { guardAnalystResponse } from './parser.ts';

describe('parser - guardAnalystResponse', () => {
    it('should correctly parse a fully valid object input', () => {
        const input = {
            insights: ['Insight 1', 'Insight 2'],
            anomalies: ['Anomaly 1'],
            summary: 'Valid summary'
        };
        const result = guardAnalystResponse(input, 'TestRole');

        expect(result.insights).toEqual(['Insight 1', 'Insight 2']);
        expect(result.anomalies).toEqual(['Anomaly 1']);
        expect(result.summary).toBe('Valid summary');
    });

    it('should extract insights from a single string', () => {
        const input = {
            insights: 'Single insight string',
        };
        const result = guardAnalystResponse(input);

        expect(result.insights).toEqual(['Single insight string']);
    });

    it('should extract insights from findings array', () => {
        const input = {
            findings: ['Finding 1', 'Finding 2'],
        };
        const result = guardAnalystResponse(input);

        expect(result.insights).toEqual(['Finding 1', 'Finding 2']);
    });

    it('should provide fallback insight when none are provided', () => {
        const input = {
            somethingElse: 'No insights here'
        };
        const result = guardAnalystResponse(input, 'Specialist');

        expect(result.insights.length).toBe(1);
        expect(result.insights[0]).toContain('[Specialist]');
        expect(result.insights[0]).toContain('somethingElse');
    });

    it('should extract anomalies from a single string', () => {
        const input = {
            anomalies: 'Single anomaly string',
        };
        const result = guardAnalystResponse(input);

        expect(result.anomalies).toEqual(['Single anomaly string']);
    });

    it('should ignore "none" anomalies (case insensitive)', () => {
        const input1 = { anomalies: 'None' };
        const input2 = { anomalies: 'none' };

        expect(guardAnalystResponse(input1).anomalies).toEqual([]);
        expect(guardAnalystResponse(input2).anomalies).toEqual([]);
    });

    it('should generate a summary if none is provided', () => {
        const input = {
            insights: ['I1', 'I2']
        };
        const result = guardAnalystResponse(input, 'Researcher');

        expect(result.summary).toContain('Researcher analytical assessment completed');
        expect(result.summary).toContain('2 insights');
    });

    it('should correctly handle singular insight in generated summary', () => {
        const input = {
            insights: ['I1']
        };
        const result = guardAnalystResponse(input, 'Researcher');

        expect(result.summary).toContain('1 insight).');
    });

    it('should gracefully handle malformed JSON strings', () => {
        const malformedJson = '{"insights": ["Broken 1", "Broken 2"'; // missing closing brackets
        const result = guardAnalystResponse(malformedJson);

        expect(result.insights).toEqual(['Broken 1', 'Broken 2']);
    });

    it('should gracefully handle completely broken input by using fallback text', () => {
        const result = guardAnalystResponse(null);

        expect(result.insights.length).toBe(1);
        expect(result.insights[0]).toContain('[Analyst]'); // default role
    });
});
