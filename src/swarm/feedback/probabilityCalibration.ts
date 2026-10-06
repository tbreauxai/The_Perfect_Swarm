/**
 * App-scoped win-probability calibration for The Perfect Swarm.
 * Settled picks update a logit intercept. The next run for that caller
 * receives the fitted bias instead of only a win/loss reputation score.
 */

export interface ProbabilityObservation {
  workflowId: string;
  appId: string;
  predictedProbability: number;
  outcome: 0 | 0.5 | 1;
  sportKey?: string;
  market?: string;
  gradedAt: string;
}

export interface CalibrationFit {
  globalBias: number;
  sportBias: Record<string, number>;
  sampleSize: number;
  sportSamples: Record<string, number>;
  brier: number;
  meanPredicted: number;
  meanActual: number;
}

const PRIOR_PRECISION = 8;
const SPORT_MIN_SAMPLES = 12;

export function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.98, Math.max(0.02, p));
}

export function logit(p: number): number {
  const c = clampProbability(p);
  return Math.log(c / (1 - c));
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

export function fitLogitBias(rows: ProbabilityObservation[], priorPrecision = PRIOR_PRECISION): number {
  if (rows.length === 0) return 0;
  let b = 0;
  for (let iter = 0; iter < 12; iter++) {
    let grad = -priorPrecision * b;
    let hess = -priorPrecision;
    for (const row of rows) {
      const s = sigmoid(logit(row.predictedProbability) + b);
      grad += row.outcome - s;
      hess -= s * (1 - s);
    }
    if (Math.abs(hess) < 1e-8) break;
    const step = grad / hess;
    b -= step;
    if (Math.abs(step) < 1e-6) break;
  }
  return Math.max(-1.25, Math.min(1.25, b));
}

export function fitCalibration(rows: ProbabilityObservation[]): CalibrationFit {
  const globalBias = fitLogitBias(rows);
  const groups = new Map<string, ProbabilityObservation[]>();
  for (const row of rows) {
    const key = row.sportKey || 'unknown';
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const sportBias: Record<string, number> = {};
  const sportSamples: Record<string, number> = {};
  for (const [sport, group] of groups) {
    sportSamples[sport] = group.length;
    if (group.length >= SPORT_MIN_SAMPLES) sportBias[sport] = fitLogitBias(group);
  }
  let brier = 0;
  let meanPredicted = 0;
  let meanActual = 0;
  for (const row of rows) {
    const p = clampProbability(row.predictedProbability);
    brier += (p - row.outcome) ** 2;
    meanPredicted += p;
    meanActual += row.outcome;
  }
  const n = rows.length || 1;
  return {
    globalBias,
    sportBias,
    sampleSize: rows.length,
    sportSamples,
    brier: rows.length ? brier / n : 0,
    meanPredicted: rows.length ? meanPredicted / n : 0,
    meanActual: rows.length ? meanActual / n : 0
  };
}

export function calibrateProbability(raw: number, fit: CalibrationFit, sportKey?: string): number {
  if (fit.sampleSize < 8) return clampProbability(raw);
  const sportN = sportKey ? (fit.sportSamples[sportKey] || 0) : 0;
  const bias = sportKey && sportN >= SPORT_MIN_SAMPLES && fit.sportBias[sportKey] != null
    ? fit.sportBias[sportKey]
    : fit.globalBias;
  return Number(clampProbability(sigmoid(logit(raw) + bias)).toFixed(4));
}

export function formatCalibrationBrief(fit: CalibrationFit, appId: string): string {
  if (fit.sampleSize < 8) {
    return `Swarm win model for ${appId} has ${fit.sampleSize} graded predictions (need 8). Do not invent a higher win probability than the no-vig board.`;
  }
  const gap = (fit.meanActual - fit.meanPredicted) * 100;
  const direction = gap < -1 ? 'overconfident' : gap > 1 ? 'underconfident' : 'roughly calibrated';
  return [
    `Swarm-owned win calibration for ${appId} from ${fit.sampleSize} graded predictions.`,
    `Stated ${(fit.meanPredicted * 100).toFixed(1)}% vs hit ${(fit.meanActual * 100).toFixed(1)}% (${direction}, ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pp). Brier ${fit.brier.toFixed(3)}. Logit bias ${fit.globalBias.toFixed(3)}.`,
    'Start from the calibrated probability. Do not add win probability back to manufacture edge.',
    'A win/loss reputation score is not a win probability.'
  ].join('\n');
}

export function outcomeToScore(outcome: string): 0 | 0.5 | 1 | null {
  if (outcome === 'win') return 1;
  if (outcome === 'loss') return 0;
  if (outcome === 'push') return 0.5;
  return null;
}

const observationsByApp = new Map<string, ProbabilityObservation[]>();

export function recordProbabilityObservation(observation: ProbabilityObservation): void {
  const list = observationsByApp.get(observation.appId) || [];
  if (list.some(row => row.workflowId === observation.workflowId)) return;
  list.push(observation);
  observationsByApp.set(observation.appId, list.slice(-500));
}

export function observationsForApp(appId: string): ProbabilityObservation[] {
  return observationsByApp.get(appId) || [];
}

export function restoreProbabilityObservations(appId: string, rows: ProbabilityObservation[]): void {
  const merged = [...rows];
  for (const existing of observationsByApp.get(appId) || []) {
    if (!merged.some(row => row.workflowId === existing.workflowId)) merged.push(existing);
  }
  observationsByApp.set(appId, merged.slice(-500));
}

export function hydrateFromOutcomeRecords(appId: string, records: Array<Record<string, any>>): void {
  const rows: ProbabilityObservation[] = [];
  for (const record of records) {
    const predicted = Number(record.predictedProbability);
    const score = outcomeToScore(String(record.outcome || ''));
    if (!record.workflowId || !Number.isFinite(predicted) || predicted <= 0 || predicted >= 1 || score == null) continue;
    rows.push({
      workflowId: String(record.workflowId),
      appId,
      predictedProbability: predicted,
      outcome: score,
      sportKey: typeof record.sportKey === 'string' ? record.sportKey : undefined,
      market: typeof record.market === 'string' ? record.market : undefined,
      gradedAt: String(record.gradedAt || record.timestamp || '')
    });
  }
  restoreProbabilityObservations(appId, rows);
}

export function calibrationBriefForApp(appId: string): string {
  return formatCalibrationBrief(fitCalibration(observationsForApp(appId)), appId);
}

export function prependCalibrationToData(data: unknown, appId: string): string {
  const brief = calibrationBriefForApp(appId);
  const section = `=== SWARM EMPIRICAL WIN CALIBRATION ===\n${brief}`;
  const text = typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data);
  if (text.includes('=== SWARM EMPIRICAL WIN CALIBRATION ===')) return text;
  return text ? `${section}\n\n${text}` : section;
}
