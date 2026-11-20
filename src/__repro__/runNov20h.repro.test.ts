import { describe, it, expect } from 'vitest';
import { parseGameHeaders, renderHeaders } from '../swarm/context/gameHeaders.ts';
import {
  auditPullBeforePass,
  buildToolPullLedger,
  sanitizePullBeforePassClaims
} from '../swarm/tools/pullBeforePass.ts';

describe('runNov20h repros (wf-1795215405127)', () => {
  it('N: renderHeaders greedily upgrades lines to formatLine(h,1) with ML when all-1 exceeds maxChars', () => {
    const raw = Array.from({ length: 15 }, (_, i) => {
      const idx = i + 1;
      return `event_id=nba-4019093${String(idx).padStart(2, '0')} | New Orleans Pelicans ${idx} @ Golden State Warriors ${idx} | sp -3.5 | ml -160/135 | tot 222.5`;
    }).join('\n');

    const headers = parseGameHeaders(raw);
    expect(headers).toHaveLength(15);

    const rendered = renderHeaders(headers, 1600);
    expect(rendered.length).toBeLessThanOrEqual(1600);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(15);
    // Greedy upgrade keeps ML on leading games instead of dropping all 15 to bare lines
    expect(lines[0]).toContain('ML 135 / Golden State Warriors 1 ML -160');
  });

  it('O: pullBeforePass matches and strips market/odds, odds, and betting data/movement claims', () => {
    const board = 'event_id=nba-401909306 | sport=nba | Orlando Magic @ Brooklyn Nets | options: Orlando Magic ML -210 / Brooklyn Nets ML +175';
    const headers = parseGameHeaders(board);
    const trace: any[] = [
      { tool: 'get_market_movement', eventId: 'nba-401909306', status: 'data', summary: 'ml_home=175, ml_away=-210' }
    ];

    const res1 = auditPullBeforePass(
      { summary: 'Passing on Orlando Magic @ Brooklyn Nets because there is no market/odds data.' },
      'ml_home=175, ml_away=-210',
      board,
      { headers, toolCallTrace: trace }
    );
    expect(res1.pass).toBe(false);

    const res2 = auditPullBeforePass(
      { summary: 'Brooklyn Nets lacks odds data and betting movement.' },
      'ml_home=175, ml_away=-210',
      board,
      { headers, toolCallTrace: trace }
    );
    expect(res2.pass).toBe(false);

    const report = {
      summary: 'Magic look strong, without market/odds data.'
    };
    sanitizePullBeforePassClaims(report, 'ml_home=175, ml_away=-210', board, { headers, toolCallTrace: trace });
    expect(report.summary).not.toMatch(/market\/odds data/i);
  });

  it('P: buildToolPullLedger records get_market_movement=data when header has ML options', () => {
    const board = 'event_id=nba-401909306 | Orlando Magic @ Brooklyn Nets | sp 5.5 | ml 181/-218 | tot 223.5';
    const headers = parseGameHeaders(board);
    const ledger = buildToolPullLedger('', { headers });
    const statuses = ledger.byEvent.get('nba-401909306');
    expect(statuses?.get('get_market_movement')).toBe('data');
  });
});
