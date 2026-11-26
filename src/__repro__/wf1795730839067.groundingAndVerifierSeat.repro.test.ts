import { describe, it, expect } from 'vitest';
import {
  auditClaimGrounding,
  auditCriticPremiseContradictions
} from '../swarm/tools/claimGrounding.ts';
import { buildCompactRunDiagnostics } from '../swarm/engine/runDiagnostics.ts';
import type { SwarmEvent } from '../swarm/types.ts';

describe('wf-1795730839067: Grounding Record-Split Matching, Negation-Aware Injury Disclaimer & Verifier Seat ID', () => {
  const slateText = [
    'R1 | Buffalo Bulls -10.5 | event_id=college-football-401856900 | Buffalo Bulls vs Northern Illinois Huskies | model_signal=lean_home',
    'R10 | Texas Tech Red Raiders -14.5 | event_id=college-football-401856879 | TCU Horned Frogs @ Texas Tech Red Raiders | model_signal=none',
    'R11 | TCU Horned Frogs +14.5 | event_id=college-football-401856879 | TCU Horned Frogs @ Texas Tech Red Raiders | model_signal=none'
  ].join('\n');

  const fundamentalsEvidence = [
    'EVENT college-football-401856900',
    '[MATCHUP FUNDAMENTALS: college-football-401856900]',
    'Home (Buffalo Bulls): Season 9-1 (4-1 Home, Diff +10.5) | L5: 4-1',
    'Away (Northern Illinois Huskies): Season 3-7 (1-4 Away, Diff -8.2)',
    'Health Balance: uncertain_questionable (Buffalo Bulls 1 OUT/2 Q vs Northern Illinois Huskies 1 OUT/1 Q)',
    'EVENT college-football-401856879',
    '[MATCHUP FUNDAMENTALS: college-football-401856879]',
    'Home (Texas Tech Red Raiders): W-L 4-1 | Season 8-2 | home_record: 4-1',
    'Away (TCU Horned Frogs): W-L 2-3 | away_record: 1-3',
    'Steam: neutral (0 pts)',
    'Health Balance: symmetric (Texas Tech Red Raiders 2 OUT/0 Q vs TCU Horned Frogs 2 OUT/0 Q)'
  ].join('\n');

  it('S1: grounds "4-1 form" against Season 9-1 (4-1 Home, Diff +10.5) and W-L 4-1, while still vetoing fabricated "7-0 form"', () => {
    const validProposal = {
      summary: 'Backing Buffalo Bulls on their 4-1 form at home and Texas Tech Red Raiders on 4-1 form.',
      picks: [
        {
          row: 'R1',
          side: 'Buffalo Bulls -10.5',
          reason: 'Buffalo Bulls bring 4-1 form (9-1 record) into this home spot.'
        },
        {
          row: 'R10',
          side: 'Texas Tech Red Raiders -14.5',
          reason: 'Texas Tech Red Raiders hold 4-1 form in recent action.'
        }
      ]
    };

    const validAudit = auditClaimGrounding(validProposal, fundamentalsEvidence, slateText);
    expect(validAudit.violations.filter((v) => /Ungrounded record\/form claim/i.test(v))).toEqual([]);
    expect(validAudit.pass).toBe(true);

    const fabricatedProposal = {
      picks: [
        {
          row: 'R1',
          side: 'Buffalo Bulls -10.5',
          reason: 'Buffalo Bulls are riding a 7-0 form streak.'
        }
      ]
    };
    const fabricatedAudit = auditClaimGrounding(fabricatedProposal, fundamentalsEvidence, slateText);
    expect(fabricatedAudit.pass).toBe(false);
    expect(fabricatedAudit.violations.some((v) => /Ungrounded record\/form claim \("7-0 form"\)/i.test(v))).toBe(true);
  });

  it('S2: does NOT fire symmetric_injury_misread on explicit uncertain_questionable/disqualifying disclaimer, while still vetoing affirmative health balance claims', () => {
    const disclaimerProposal = {
      summary: 'Health Balance is uncertain_questionable for Buffalo, treating as disqualifying for roster health edge.',
      picks: [
        {
          row: 'R1',
          side: 'Buffalo Bulls -10.5',
          reason: 'Health Balance is uncertain_questionable for Buffalo, treating as disqualifying for roster health edge.'
        }
      ]
    };

    const disclaimerAudit = auditCriticPremiseContradictions(disclaimerProposal, fundamentalsEvidence, slateText);
    expect(disclaimerAudit.flags).not.toContain('symmetric_injury_misread');
    expect(disclaimerAudit.pass).toBe(true);

    const affirmativeProposal = {
      picks: [
        {
          row: 'R11',
          side: 'TCU Horned Frogs +14.5',
          reason: 'Steam movement and health balance favor TCU in this matchup.'
        }
      ]
    };
    const affirmativeAudit = auditCriticPremiseContradictions(affirmativeProposal, fundamentalsEvidence, slateText);
    expect(affirmativeAudit.flags).toContain('symmetric_injury_misread');
    expect(affirmativeAudit.pass).toBe(false);
  });

  it('S3: separates verifier seat ID from critic so diagnostics.failovers is [] when both complete with status ok on different models', () => {
    const events: SwarmEvent[] = [
      {
        id: 'e1',
        timestamp: new Date(1000).toISOString(),
        agentRole: 'Risk Critic',
        action: 'Started execution',
        modelName: 'groq / openai/gpt-oss-120b',
        prompt: ''
      },
      {
        id: 'e2',
        timestamp: new Date(1800).toISOString(),
        agentRole: 'Risk Critic',
        action: 'Completed execution',
        modelName: 'groq / openai/gpt-oss-120b',
        prompt: '',
        durationMs: 800
      },
      {
        id: 'e3',
        timestamp: new Date(2000).toISOString(),
        agentRole: 'verifier',
        action: 'Started execution',
        modelName: 'gemini / gemini-3.5-flash-lite',
        prompt: ''
      },
      {
        id: 'e4',
        timestamp: new Date(2600).toISOString(),
        agentRole: 'verifier',
        action: 'Completed execution',
        modelName: 'gemini / gemini-3.5-flash-lite',
        prompt: '',
        durationMs: 600
      }
    ];

    const diag = buildCompactRunDiagnostics({ events, totalMs: 2600 });
    expect(diag.failovers).toEqual([]);
    const criticTiming = diag.seatTimings.find((s) => s.seat === 'critic');
    const verifierTiming = diag.seatTimings.find((s) => s.seat === 'verifier');
    expect(criticTiming?.status).toBe('ok');
    expect(criticTiming?.model).toBe('openai/gpt-oss-120b');
    expect(verifierTiming?.status).toBe('ok');
    expect(verifierTiming?.model).toBe('gemini-3.5-flash-lite');
  });
});
