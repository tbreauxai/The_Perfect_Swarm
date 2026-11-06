import { describe, expect, it } from 'vitest';
import {
  buildBrierTrendSeries,
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

  it('builds a chronological Brier score trend series comparing Swarm against baselines', () => {
    const baselineSeries = buildBrierTrendSeries('duelodds', []);
    expect(baselineSeries.length).toBeGreaterThanOrEqual(6);
    expect(baselineSeries[baselineSeries.length - 1].historicalBaselineBrier).toBe(0.25);

    const liveRecords = Array.from({ length: 12 }, (_, idx) => ({
      workflowId: `wf-live-${idx}`,
      appId: 'duelodds',
      domain: 'sports_nba',
      predictedConfidence: 72,
      outcome: (idx % 3 === 0 ? 'LOSS' : 'WIN') as 'WIN' | 'LOSS',
      timestamp: new Date(Date.now() - (12 - idx) * 3600_000).toISOString()
    }));

    const liveSeries = buildBrierTrendSeries('duelodds', liveRecords);
    expect(liveSeries.some((pt) => pt.isLiveObservation)).toBe(true);
    for (const point of liveSeries) {
      expect(point.swarmBrier).toBeGreaterThanOrEqual(0);
      expect(point.rawBaselineBrier).toBeGreaterThanOrEqual(0);
      expect(point.historicalBaselineBrier).toBe(0.25);
    }
  });
});

