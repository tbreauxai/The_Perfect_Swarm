import { globalKnowledgeGraph, type SharedKnowledgeGraph } from '../knowledgeGraph.ts';
import type { Hypothesis, HypothesisStatus } from './types.ts';

/**
 * Hierarchical decision-making layer allowing lower-level agents to propose hypotheses
 * and higher-level agents/critics to arbitrate, validate, or prune them.
 */
export class HypothesisValidationLayer {
    private hypotheses: Map<string, Hypothesis> = new Map();
    private knowledgeGraph: SharedKnowledgeGraph;

    public constructor(kg: SharedKnowledgeGraph = globalKnowledgeGraph) {
        this.knowledgeGraph = kg;
    }

    public proposeHypothesis(input: {
        claim: string;
        proposedBy: string;
        confidence?: number;
        evidence?: string[];
    }): Hypothesis {
        const claimNormalized = input.claim.trim();
        // Check for redundant identical hypothesis
        for (const existing of this.hypotheses.values()) {
            if (existing.claim.toLowerCase() === claimNormalized.toLowerCase() && existing.status !== 'refuted') {
                // Merge evidence and adjust confidence
                if (input.evidence) {
                    existing.evidence = Array.from(new Set([...existing.evidence, ...input.evidence]));
                }
                existing.confidence = Math.min(1.0, (existing.confidence + (input.confidence ?? 0.5)) / 2 + 0.1);
                return existing;
            }
        }

        const id = `hypo-${Date.now()}-${crypto.randomUUID().substring(0, 8)}`;
        const hypothesis: Hypothesis = {
            id,
            claim: claimNormalized,
            proposedBy: input.proposedBy,
            confidence: input.confidence ?? 0.6,
            evidence: input.evidence || [],
            status: 'proposed',
            timestamp: Date.now()
        };

        this.hypotheses.set(id, hypothesis);
        return hypothesis;
    }

    public validateHypothesis(id: string, decision: {
        isValid: boolean;
        validatedBy: string;
        feedback?: string;
        confidenceAdjustment?: number;
    }): Hypothesis | undefined {
        const hypothesis = this.hypotheses.get(id);
        if (!hypothesis) return undefined;

        if (decision.isValid) {
            hypothesis.status = 'validated';
            hypothesis.confidence = Math.min(1.0, (hypothesis.confidence + (decision.confidenceAdjustment ?? 0.3)));
            hypothesis.validationFeedback = decision.feedback || `Validated by ${decision.validatedBy}`;

            // Propagate validated finding to the Shared Knowledge Graph!
            this.knowledgeGraph.addNode({
                id: `node-${hypothesis.id}`,
                type: 'finding',
                label: hypothesis.claim,
                confidence: hypothesis.confidence,
                properties: {
                    validatedBy: decision.validatedBy,
                    evidence: hypothesis.evidence,
                    originalHypothesisId: hypothesis.id
                }
            });
        } else {
            hypothesis.status = 'refuted';
            hypothesis.confidence = Math.max(0.0, hypothesis.confidence - 0.5);
            hypothesis.validationFeedback = decision.feedback || `Refuted by ${decision.validatedBy}`;
        }

        return hypothesis;
    }

    public pruneRedundantHypotheses(): { prunedCount: number; remainingCount: number } {
        let pruned = 0;
        for (const [id, h] of this.hypotheses.entries()) {
            if (h.status === 'refuted' || h.confidence < 0.25) {
                h.status = 'pruned';
                pruned++;
            }
        }
        return {
            prunedCount: pruned,
            remainingCount: Array.from(this.hypotheses.values()).filter(h => h.status !== 'pruned').length
        };
    }

    public getHypotheses(status?: HypothesisStatus): Hypothesis[] {
        let list = Array.from(this.hypotheses.values());
        if (status) {
            list = list.filter(h => h.status === status);
        }
        return list;
    }

    public clear(): void {
        this.hypotheses.clear();
    }
}
