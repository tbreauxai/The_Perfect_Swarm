import { describe, it, expect } from 'vitest';
import { sanitizeUngroundedClaims } from './claimGrounding.ts';

describe('claimGrounding S8 strips', () => {
  it('strips combined/parlay odds claims and ungrounded offensive/defensive metrics/efficiency/rating', () => {
    const report = {
      summary: 'Magic ML is backed by clean injury news. Combined odds of +595 offer great value. Their defensive efficiency is elite.',
      insights: [
        'Parlay payout of $382 on $55 stake.',
        'Houston offensive rating leads the league.',
        'Magic have clean injury news.'
      ]
    };

    const toolText = 'EVENT nba-1 Orlando Magic @ Boston Celtics\nFUND: Magic won 115-105';
    sanitizeUngroundedClaims(report, toolText, 'event_id=nba-1 | sport=nba | Orlando Magic @ Boston Celtics');

    expect(report.summary).toContain('Magic ML is backed by clean injury news.');
    expect(report.summary).not.toContain('+595');
    expect(report.summary).not.toContain('defensive efficiency');
    expect(report.insights.join(' ')).not.toContain('$382');
    expect(report.insights.join(' ')).not.toContain('offensive rating');
    expect(report.insights.join(' ')).toContain('Magic have clean injury news.');
  });

  it('keeps offensive/defensive metrics when present in tool text', () => {
    const report = {
      summary: 'Boston defensive rating is 108.4 per tool results.'
    };
    const toolText = 'EVENT nba-1 Orlando Magic @ Boston Celtics\nFUND: Boston defensive rating 108.4';
    sanitizeUngroundedClaims(report, toolText, 'event_id=nba-1 | sport=nba | Orlando Magic @ Boston Celtics');
    expect(report.summary).toContain('defensive rating');
  });
});
