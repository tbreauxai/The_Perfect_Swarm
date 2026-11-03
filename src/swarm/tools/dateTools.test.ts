import { describe, it, expect } from 'vitest';
import { dateMathTool } from './dateTools.ts';

describe('dateMathTool', () => {
    it('calculates diff in seconds by default', () => {
        const start = new Date('2023-01-01T00:00:00Z');
        const end = new Date('2023-01-01T00:01:00Z');
        const result = dateMathTool.execute({ startDate: start.toISOString(), endDate: end.toISOString() });

        expect(result.diff).toBe(60);
        expect(result.unit).toBe('seconds');
        expect(result.isPast).toBe(false);
    });

    it('calculates diff in minutes', () => {
        const start = new Date('2023-01-01T00:00:00Z');
        const end = new Date('2023-01-01T02:30:00Z');
        const result = dateMathTool.execute({ startDate: start.toISOString(), endDate: end.toISOString(), unit: 'minutes' });

        expect(result.diff).toBe(150);
        expect(result.unit).toBe('minutes');
        expect(result.isPast).toBe(false);
    });

    it('calculates diff in hours', () => {
        const start = new Date('2023-01-01T00:00:00Z');
        const end = new Date('2023-01-02T12:00:00Z');
        const result = dateMathTool.execute({ startDate: start.toISOString(), endDate: end.toISOString(), unit: 'hours' });

        expect(result.diff).toBe(36);
        expect(result.unit).toBe('hours');
        expect(result.isPast).toBe(false);
    });

    it('calculates diff in days', () => {
        const start = new Date('2023-01-01T00:00:00Z');
        const end = new Date('2023-01-11T12:00:00Z');
        const result = dateMathTool.execute({ startDate: start.toISOString(), endDate: end.toISOString(), unit: 'days' });

        expect(result.diff).toBe(10.5);
        expect(result.unit).toBe('days');
        expect(result.isPast).toBe(false);
    });

    it('calculates diff in milliseconds', () => {
        const start = new Date('2023-01-01T00:00:00.000Z');
        const end = new Date('2023-01-01T00:00:01.500Z');
        const result = dateMathTool.execute({ startDate: start.toISOString(), endDate: end.toISOString(), unit: 'milliseconds' });

        expect(result.diff).toBe(1500);
        expect(result.unit).toBe('milliseconds');
        expect(result.isPast).toBe(false);
    });

    it('defaults endDate to current time if missing', () => {
        const start = new Date();
        start.setSeconds(start.getSeconds() - 60);
        const result = dateMathTool.execute({ startDate: start.toISOString() });

        expect(result.diff).toBeGreaterThan(0);
        expect(result.diff).toBeCloseTo(60, -1); // Check within ~10 seconds
        expect(result.unit).toBe('seconds');
    });

    it('sets isPast correctly if end is before start', () => {
        const start = new Date('2023-01-02T00:00:00Z');
        const end = new Date('2023-01-01T00:00:00Z');
        const result = dateMathTool.execute({ startDate: start.toISOString(), endDate: end.toISOString() });

        expect(result.diff).toBe(86400); // 1 day in seconds
        expect(result.isPast).toBe(true);
    });

    it('calculates add operation in different units', () => {
        const start = new Date('2023-01-01T00:00:00Z');

        const resDays = dateMathTool.execute({ operation: 'add', startDate: start.toISOString(), amount: 2, unit: 'days' });
        expect(resDays.resultDate).toBe(new Date('2023-01-03T00:00:00Z').toISOString());

        const resHours = dateMathTool.execute({ operation: 'add', startDate: start.toISOString(), amount: 12, unit: 'hours' });
        expect(resHours.resultDate).toBe(new Date('2023-01-01T12:00:00Z').toISOString());

        const resMins = dateMathTool.execute({ operation: 'add', startDate: start.toISOString(), amount: 90, unit: 'minutes' });
        expect(resMins.resultDate).toBe(new Date('2023-01-01T01:30:00Z').toISOString());

        const resSecs = dateMathTool.execute({ operation: 'add', startDate: start.toISOString(), amount: 45, unit: 'seconds' });
        expect(resSecs.resultDate).toBe(new Date('2023-01-01T00:00:45Z').toISOString());

        const resMs = dateMathTool.execute({ operation: 'add', startDate: start.toISOString(), amount: 500, unit: 'milliseconds' });
        expect(resMs.resultDate).toBe(new Date('2023-01-01T00:00:00.500Z').toISOString());
    });

    it('calculates subtract operation in different units', () => {
        const start = new Date('2023-01-03T12:30:45.500Z');

        const resDays = dateMathTool.execute({ operation: 'subtract', startDate: start.toISOString(), amount: 2, unit: 'days' });
        expect(resDays.resultDate).toBe(new Date('2023-01-01T12:30:45.500Z').toISOString());

        const resHours = dateMathTool.execute({ operation: 'subtract', startDate: start.toISOString(), amount: 12, unit: 'hours' });
        expect(resHours.resultDate).toBe(new Date('2023-01-03T00:30:45.500Z').toISOString());

        const resMins = dateMathTool.execute({ operation: 'subtract', startDate: start.toISOString(), amount: 30, unit: 'minutes' });
        expect(resMins.resultDate).toBe(new Date('2023-01-03T12:00:45.500Z').toISOString());

        const resSecs = dateMathTool.execute({ operation: 'subtract', startDate: start.toISOString(), amount: 45, unit: 'seconds' });
        expect(resSecs.resultDate).toBe(new Date('2023-01-03T12:30:00.500Z').toISOString());

        const resMs = dateMathTool.execute({ operation: 'subtract', startDate: start.toISOString(), amount: 500, unit: 'milliseconds' });
        expect(resMs.resultDate).toBe(new Date('2023-01-03T12:30:45.000Z').toISOString());
    });

    it('subtracts by adding negative amount', () => {
        const start = new Date('2023-01-03T12:00:00Z');
        const res = dateMathTool.execute({ operation: 'add', startDate: start.toISOString(), amount: -2, unit: 'days' });
        expect(res.resultDate).toBe(new Date('2023-01-01T12:00:00Z').toISOString());
    });

    it('handles alternative parameter names (dateA, dateB, start, end, date)', () => {
        const d1 = '2023-01-01T00:00:00Z';
        const d2 = '2023-01-01T01:00:00Z';

        // dateA and dateB
        let result = dateMathTool.execute({ dateA: d1, dateB: d2, unit: 'hours' });
        expect(result.diff).toBe(1);

        // start and end
        result = dateMathTool.execute({ start: d1, end: d2, unit: 'hours' });
        expect(result.diff).toBe(1);

        // date and endDate
        result = dateMathTool.execute({ date: d1, endDate: d2, unit: 'hours' });
        expect(result.diff).toBe(1);
    });

    it('throws error for invalid startDate', () => {
        expect(() => {
            dateMathTool.execute({ startDate: 'invalid-date' });
        }).toThrowError("date_math: Invalid startDate 'invalid-date'");
    });

    it('throws error for invalid endDate', () => {
        const start = new Date('2023-01-01T00:00:00Z');
        expect(() => {
            dateMathTool.execute({ startDate: start.toISOString(), endDate: 'not-a-date' });
        }).toThrowError("date_math: Invalid endDate 'not-a-date'");
    });
});
