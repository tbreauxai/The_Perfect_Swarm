/**
 * Shared probabilistic math utilities.
 * Handles probability clamping, logit conversions, and logistic sigmoid activations.
 */

/**
 * Clamps probability strictly between `min` and `max` (defaults: 0.01 and 0.99).
 * Also converts percentage inputs (e.g. 75 -> 0.75) into unit probabilities.
 */
export function clampProbability(p: number, min: number = 0.01, max: number = 0.99): number {
    if (!Number.isFinite(p)) return 0.5;
    if (p > 1 && p <= 100) p = p / 100;
    return Math.min(max, Math.max(min, p));
}

/**
 * Computes log-odds (logit) of a probability: log(p / (1 - p)).
 */
export function logit(p: number, min: number = 0.01, max: number = 0.99): number {
    const clamped = clampProbability(p, min, max);
    return Math.log(clamped / (1 - clamped));
}

/**
 * Computes logistic sigmoid (inverse logit): 1 / (1 + exp(-z)).
 * Clamps extreme z inputs between -8 and 8 to prevent numerical instability.
 */
export function sigmoid(z: number): number {
    if (!Number.isFinite(z)) return 0.5;
    const clampedZ = Math.max(-8, Math.min(8, z));
    if (clampedZ >= 0) return 1 / (1 + Math.exp(-clampedZ));
    const ez = Math.exp(clampedZ);
    return ez / (1 + ez);
}

/**
 * Alias for sigmoid: converts log-odds back to probability.
 */
export const invLogit = sigmoid;
