import { describe, expect, it } from 'vitest';
import {
  calibrateProbability,
  fitCalibration,
  formatCalibrationBrief,
  type ProbabilityObservation
} from './probabilityCalibration.ts';

function row(predictedProbability: number, outcome: 0 | 1, sportKey = 'baseball_mlb'): ProbabilityObservation {
  return {
    workflowId: `wf-${predictedProbability}-${outcome}-${Math.random()}`,
    appId: 'duelodds',
    predictedProbability,
    outcome,
    sportKey,
    gradedAt: '2026-10-05T00:00:00Z'
  };
}

describe('swarm probability calibration', () => {
  it('does not move a probability before 8 graded predictions', () => {
    const fit = fitCalibration([row(0.62, 0), row(0.62, 0)]);
    expect(calibrateProbability(0.62, fit)).toBeCloseTo(0.62, 2);
    expect(formatCalibrationBrief(fit, 'duelodds')).toContain('need 8');
  });

  it('shrinks an overconfident app-level probability after enough losses', () => {
    const fit = fitCalibration(Array.from({ length: 20 }, () => row(0.66, 0)));
    expect(fit.globalBias).toBeLessThan(-0.2);
    expect(calibrateProbability(0.66, fit, 'basketball_nba')).toBeLessThan(0.55);
    expect(formatCalibrationBrief(fit, 'duelodds')).toContain('overconfident');
  });
});
