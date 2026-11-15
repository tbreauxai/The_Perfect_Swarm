import { describe, it, expect } from 'vitest';
import { guardAnalystResponse, isDataRequest } from './responseGuards.ts';

describe('Placeholder detection & isDataRequest guard', () => {
  it('flags _placeholder: true when input produces fallback text', () => {
    const res = guardAnalystResponse({}, 'Market Analyst');
    expect(res._placeholder).toBe(true);
  });

  it('flags _placeholder: true when insights mention fabricated insights', () => {
    const res = guardAnalystResponse({
      insights: ['fabricated insights for Market Analyst'],
      summary: 'Some summary'
    }, 'Market Analyst');
    expect(res._placeholder).toBe(true);
  });

  it('detects isDataRequest when reports contain data gathering phrases without numbers', () => {
    const report1 = {
      summary: 'Data gathering in progress, requesting more context for this event.',
      insights: ['need data to proceed']
    };
    expect(isDataRequest(report1)).toBe(true);

    const report2 = {
      summary: 'Insufficient data available to form an edge.',
      insights: []
    };
    expect(isDataRequest(report2)).toBe(true);
  });

  it('does not classify reports with tool-sourced metrics as data requests', () => {
    const validReport = {
      summary: 'Data gathering showed market movement with spread -3.5 (-110) and 54% win prob',
      insights: ['Fair spread is -2.5']
    };
    expect(isDataRequest(validReport)).toBe(false);
  });
});
