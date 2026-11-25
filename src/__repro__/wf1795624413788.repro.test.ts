import { describe, it, expect } from 'vitest';
import {
  isolatePickSideLabel,
  extractRowOptions,
  checkRowSideBinding,
  checkPickRowSideBinding,
  auditMarketCoverageAndRowBinding
} from '../swarm/tools/marketRowBinding.ts';
import { auditCriticPremiseContradictions } from '../swarm/tools/claimGrounding.ts';
import { parseGameHeaders } from '../swarm/context/gameHeaders.ts';

const SLATE_WF_788 = [
  'event_id=nhl-401892900 | sport=icehockey_nhl | St. Louis Blues @ New York Islanders | options: R1 ML St. Louis Blues(+102), R2 ML New York Islanders(-122), R5 TOT Over 6.5(-110)',
  'event_id=nba-401910032 | sport=basketball_nba | Denver Nuggets @ Chicago Bulls | options: R23 SPR Chicago Bulls +9.5(-105), R24 SPR Denver Nuggets -9.5(-115)'
].join('\n');

const EVIDENCE_WF_788 = [
  'EVENT nhl-401892900',
  '[MARKET MOVEMENT: nhl-401892900] ml_home New York Islanders -122 | ml_away St. Louis Blues +102 | Total: 6.5',
  'EVENT nba-401910032',
  '[MARKET MOVEMENT: nba-401910032] SPR Denver Nuggets -9.5(-115) | SPR Chicago Bulls +9.5(-105)'
].join('\n');

describe('wf-1795624413788: Scope row_side_mismatch strictly to pick side label', () => {
  it('isolatePickSideLabel strips rationale delimiters while preserving Over <num>, negative spreads, odds, and leading ML:/SPR: prefixes', () => {
    expect(
      isolatePickSideLabel(
        "New York Islanders ML — Islanders' home form and Blues' injury depletion favor NYI moneyline.",
        'R2'
      )
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel(
        "R2: New York Islanders ML – Islanders' home edge vs Blues injuries",
        'R2'
      )
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel(
        'New York Islanders ML - Islanders hold clear special-teams edge',
        'R2'
      )
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel('New York Islanders ML: strong home edge', 'R2')
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel('New York Islanders ML because Blues are shorthanded', 'R2')
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel('New York Islanders ML over Blues', 'R2')
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel('New York Islanders ML against St. Louis Blues', 'R2')
    ).toBe('New York Islanders ML');

    expect(
      isolatePickSideLabel('ML: New York Islanders (-122) — home ice edge', 'R2')
    ).toBe('ML: New York Islanders (-122)');

    expect(isolatePickSideLabel('Over 6.5 — high pace vs Blues', 'R5')).toBe('Over 6.5');
    expect(isolatePickSideLabel('Denver Nuggets -9.5 — Nuggets dominate Bulls', 'R24')).toBe('Denver Nuggets -9.5');
  });

  it('(false-positive regression) R2 New York Islanders ML with Blues in rationale produces zero row_side_mismatch veto', () => {
    const headers = parseGameHeaders(SLATE_WF_788);
    const rowMap = extractRowOptions([SLATE_WF_788], headers);
    const r2 = rowMap.get('R2')!;
    expect(r2).toBeDefined();

    expect(
      checkRowSideBinding(
        'R2',
        "New York Islanders ML — Islanders' home form and Blues' injury depletion favor NYI moneyline.",
        r2
      ).valid
    ).toBe(true);

    expect(
      checkRowSideBinding(
        'R2',
        "New York Islanders ML — Islanders' home form and Blues' injury de",
        r2
      ).valid
    ).toBe(true);

    expect(
      checkPickRowSideBinding(
        { row: 'R2', side: 'New York Islanders ML -122', note: 'Blues depleted on defense' },
        rowMap
      ).valid
    ).toBe(true);

    const structuredProposal = {
      summary:
        "R2: New York Islanders ML — Islanders' home form and Blues' injury depletion favor NYI moneyline.",
      insights: [
        "Play New York Islanders ML (R2) — Islanders' home form and Blues' injury depletion favor NYI moneyline."
      ],
      picks: [
        {
          row: 'R2',
          event_id: 'nhl-401892900',
          side: 'New York Islanders ML -122',
          market: 'ml',
          reason: "Islanders' home form and Blues' injury depletion favor NYI moneyline."
        }
      ]
    };

    const marketAudit = auditMarketCoverageAndRowBinding(
      structuredProposal,
      EVIDENCE_WF_788,
      SLATE_WF_788,
      headers
    );
    expect(marketAudit.pass).toBe(true);
    expect(marketAudit.flags).not.toContain('row_side_mismatch');

    const premiseAudit = auditCriticPremiseContradictions(
      structuredProposal,
      EVIDENCE_WF_788,
      SLATE_WF_788,
      { headers }
    );
    expect(premiseAudit.pass).toBe(true);
    expect(premiseAudit.flags).not.toContain('row_side_mismatch');

    const proseOnlyProposal = {
      summary:
        "R2: New York Islanders ML — Islanders' home form and Blues' injury depletion favor NYI moneyline."
    };

    const proseMarketAudit = auditMarketCoverageAndRowBinding(
      proseOnlyProposal,
      EVIDENCE_WF_788,
      SLATE_WF_788,
      headers
    );
    expect(proseMarketAudit.pass).toBe(true);
    expect(proseMarketAudit.flags).not.toContain('row_side_mismatch');

    const prosePremiseAudit = auditCriticPremiseContradictions(
      proseOnlyProposal,
      EVIDENCE_WF_788,
      SLATE_WF_788,
      { headers }
    );
    expect(prosePremiseAudit.flags).not.toContain('row_side_mismatch');
  });

  it('(true-positive guard) R2 paired with side: "St. Louis Blues ML" triggers row_side_mismatch', () => {
    const headers = parseGameHeaders(SLATE_WF_788);
    const rowMap = extractRowOptions([SLATE_WF_788], headers);
    const r2 = rowMap.get('R2')!;

    expect(checkRowSideBinding('R2', 'St. Louis Blues ML', r2).valid).toBe(false);

    const mismatchedProposal = {
      picks: [
        {
          row: 'R2',
          event_id: 'nhl-401892900',
          side: 'St. Louis Blues ML',
          market: 'ml'
        }
      ]
    };

    const marketAudit = auditMarketCoverageAndRowBinding(
      mismatchedProposal,
      EVIDENCE_WF_788,
      SLATE_WF_788,
      headers
    );
    expect(marketAudit.pass).toBe(false);
    expect(marketAudit.flags).toContain('row_side_mismatch');

    const premiseAudit = auditCriticPremiseContradictions(
      mismatchedProposal,
      EVIDENCE_WF_788,
      SLATE_WF_788,
      { headers }
    );
    expect(premiseAudit.pass).toBe(false);
    expect(premiseAudit.flags).toContain('row_side_mismatch');
  });

  it('preserves totals ("Over 6.5") and negative spreads ("Denver Nuggets -9.5") alongside rationale text', () => {
    const headers = parseGameHeaders(SLATE_WF_788);
    const rowMap = extractRowOptions([SLATE_WF_788], headers);
    const r5 = rowMap.get('R5')!;
    const r24 = rowMap.get('R24')!;

    expect(checkRowSideBinding('R5', 'Over 6.5 — high pace vs Blues', r5).valid).toBe(true);
    expect(
      checkRowSideBinding('R24', 'Denver Nuggets -9.5 — Nuggets dominate Bulls', r24).valid
    ).toBe(true);
  });
});
