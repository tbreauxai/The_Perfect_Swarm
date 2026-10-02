import type {
    PartialPrediction,
    EarlyExitOptions,
    EarlyExitDecision
} from './types.ts';

/**
 * Confidence Early-Exit Evaluator: Assesses Tier 1 fast predictions.
 * When confidence is definitive or outcome margin is decisive, bypasses heavy Tier 2 passes,
 * eliminating 60-120s of unnecessary inference latency.
 */
export class ConfidenceEarlyExitEvaluator {
    private defaultConfidenceThreshold: number;
    private defaultMarginThreshold: number;

    constructor(options: { defaultConfidenceThreshold?: number; defaultMarginThreshold?: number } = {}) {
        this.defaultConfidenceThreshold = options.defaultConfidenceThreshold ?? 0.85;
        this.defaultMarginThreshold = options.defaultMarginThreshold ?? 0.35;
    }

    public evaluate(prediction: PartialPrediction, options: EarlyExitOptions = {}): EarlyExitDecision {
        const confThreshold = options.confidenceThreshold ?? this.defaultConfidenceThreshold;
        const marginThreshold = options.marginThreshold ?? this.defaultMarginThreshold;

        const confidence = prediction.confidence ?? prediction.probability ?? 0.5;

        // Calculate margin if alternatives are provided
        let margin: number | undefined;
        if (prediction.alternatives && prediction.alternatives.length > 0) {
            const sorted = [...prediction.alternatives].sort((a, b) => b.probability - a.probability);
            if (sorted.length >= 2) {
                margin = Math.abs(sorted[0].probability - sorted[1].probability);
            }
        }

        // Rule 1: High Confidence Consensus
        if (confidence >= confThreshold) {
            return {
                canEarlyExit: true,
                confidence,
                margin,
                reason: `Confidence score (${Math.round(confidence * 100)}%) meets or exceeds early-exit threshold (${Math.round(confThreshold * 100)}%).`,
                tier: 'tier1_approx',
                bypassedRefinement: true,
                estimatedLatencySavedMs: 75000 // Estimated 75s saved by skipping Tier 2
            };
        }

        // Rule 2: Decisive Probability Margin
        if (margin !== undefined && margin >= marginThreshold) {
            return {
                canEarlyExit: true,
                confidence,
                margin,
                reason: `Decisive outcome margin (${Math.round(margin * 100)}% gap) exceeds threshold (${Math.round(marginThreshold * 100)}%).`,
                tier: 'tier1_approx',
                bypassedRefinement: true,
                estimatedLatencySavedMs: 75000
            };
        }

        // Uncertainty detected -> Proceed to Tier 2 refinement
        return {
            canEarlyExit: false,
            confidence,
            margin,
            reason: `Confidence (${Math.round(confidence * 100)}%) below threshold (${Math.round(confThreshold * 100)}%); Tier 2 refinement required.`,
            tier: 'tier2_refined',
            bypassedRefinement: false,
            estimatedLatencySavedMs: 0
        };
    }
}

export const globalConfidenceEarlyExitEvaluator = new ConfidenceEarlyExitEvaluator();
