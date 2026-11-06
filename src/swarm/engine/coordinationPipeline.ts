import {
    globalHypothesisLayer,
    globalMessageChannel,
    type Hypothesis
} from '../coordination.ts';
import { globalKnowledgeGraph } from '../knowledgeGraph.ts';
import { SwarmContext } from '../context.ts';
import { Agent } from '../agent.ts';

export interface InteragentPublishParams {
    analysts: Agent[];
    allAnalystReports: any[][];
    coordinationSettings?: any;
    context: SwarmContext;
}

export function publishInteragentCoordination(params: InteragentPublishParams): number {
    const { analysts, allAnalystReports, coordinationSettings, context } = params;
    let totalHypothesesProposed = 0;

    for (let a = 0; a < analysts.length; a++) {
        const analyst = analysts[a];
        const reports = allAnalystReports[a];
        if (!reports) continue;

        for (const rep of reports) {
            if (!rep) continue;
            globalMessageChannel.publish({
                senderId: analyst.role,
                topic: 'specialist_finding',
                payload: {
                    role: analyst.role,
                    summary: rep.summary,
                    insightsCount: (rep.insights || []).length,
                    anomaliesCount: (rep.anomalies || []).length
                }
            });

            if (coordinationSettings?.hypothesisValidation !== false) {
                if (rep.primaryHypothesis && typeof rep.primaryHypothesis === 'string' && rep.primaryHypothesis.trim().length > 0) {
                    globalHypothesisLayer.proposeHypothesis({
                        claim: rep.primaryHypothesis.trim(),
                        proposedBy: analyst.role,
                        confidence: 0.75,
                        evidence: [rep.summary || 'Primary analytical deduction']
                    });
                    totalHypothesesProposed++;
                }
                if (rep.counterHypothesis && typeof rep.counterHypothesis === 'string' && rep.counterHypothesis.trim().length > 0) {
                    globalHypothesisLayer.proposeHypothesis({
                        claim: `[Counter-Hypothesis]: ${rep.counterHypothesis.trim()}`,
                        proposedBy: analyst.role,
                        confidence: 0.60,
                        evidence: [rep.summary || 'Adversarial counter-deduction']
                    });
                    totalHypothesesProposed++;
                }

                const candidateInsights = rep.insights || [];
                for (const ins of candidateInsights.slice(0, 2)) {
                    const claim = typeof ins === 'string' ? ins : (ins.description || ins.title || JSON.stringify(ins));
                    if (claim && claim.length > 5) {
                        globalHypothesisLayer.proposeHypothesis({
                            claim,
                            proposedBy: analyst.role,
                            confidence: 0.70,
                            evidence: [rep.summary || 'Observed during specialist analysis']
                        });
                        totalHypothesesProposed++;
                    }
                }
            }
        }
    }

    if (totalHypothesesProposed > 0) {
        context.addEvent({
            agentRole: 'Hypothesis Decision Layer',
            action: 'Hypotheses Proposed',
            modelName: 'Local/HypothesisValidationLayer',
            prompt: `Specialists proposed ${totalHypothesesProposed} hypotheses for hierarchical arbitration`,
            output: {
                proposedCount: totalHypothesesProposed,
                pendingHypotheses: globalHypothesisLayer.getHypotheses('proposed').length
            },
            durationMs: 0
        });
    }

    return totalHypothesesProposed;
}

export interface ArbitrateCoordinationParams {
    finalAnalysis: any;
    managerRole: string;
    coordinationSettings?: any;
    context: SwarmContext;
}

export function arbitrateAndPropagateCoordination(params: ArbitrateCoordinationParams): Hypothesis[] {
    const { finalAnalysis, managerRole, coordinationSettings, context } = params;
    if (coordinationSettings?.hypothesisValidation === false) {
        return [];
    }

    const proposed = globalHypothesisLayer.getHypotheses('proposed');
    const validatedThisRun: Hypothesis[] = [];
    const isVerifiedSuccess = !finalAnalysis?.ui_title?.toLowerCase().includes("error");

    for (const h of proposed) {
        const validated = globalHypothesisLayer.validateHypothesis(h.id, {
            isValid: isVerifiedSuccess,
            validatedBy: managerRole || 'Manager Node',
            feedback: isVerifiedSuccess ? 'Corroborated by synthesized swarm findings' : 'Refuted by synthesis failure'
        });
        if (validated && validated.status === 'validated') {
            validatedThisRun.push(validated);
        }
    }

    if (validatedThisRun.length > 0) {
        context.addEvent({
            agentRole: 'Hypothesis Validation Layer',
            action: 'Hypotheses Validated & Propagated',
            modelName: 'Local/HypothesisValidationLayer',
            prompt: `Validated ${validatedThisRun.length} hypotheses and propagated findings into Shared Knowledge Graph`,
            output: {
                validatedCount: validatedThisRun.length,
                knowledgeGraphVersion: globalKnowledgeGraph.getVersion(),
                knowledgeGraphStats: globalKnowledgeGraph.getStats(),
                hypotheses: validatedThisRun.map(h => ({ id: h.id, claim: h.claim, confidence: h.confidence }))
            },
            durationMs: 0
        });
    }

    return validatedThisRun;
}

/**
 * Compiles proposed and surviving hypotheses, counter-arguments, and critic refutations
 * into a structured Debate Digest prompt block for the Manager Node.
 */
export function compileDebateDigest(criticFeedback?: any): string {
    const hypotheses = globalHypothesisLayer.getHypotheses();
    if (!hypotheses || hypotheses.length === 0) return '';

    const lines: string[] = ['[Debate Digest & Dialectic Synthesis]:'];
    for (const h of hypotheses.slice(0, 8)) {
        const isCounter = h.claim.startsWith('[Counter-Hypothesis]');
        const prefix = isCounter ? '• Counter-Argument / Falsifier' : '• Primary Claim';
        const cleanClaim = h.claim.replace(/^\[Counter-Hypothesis\]:\s*/, '');
        lines.push(`  ${prefix} (${h.proposedBy}): "${cleanClaim}" [Confidence: ${(h.confidence * 100).toFixed(0)}%, Status: ${h.status}]`);
    }

    const feedbackStr = typeof criticFeedback === 'string'
        ? criticFeedback
        : (criticFeedback?.feedback || (criticFeedback ? JSON.stringify(criticFeedback) : ''));
    if (feedbackStr && feedbackStr.trim().length > 0) {
        lines.push(`  • Critic Refutation & Stress-Test: "${feedbackStr.slice(0, 300).trim()}"`);
    }

    lines.push('Directives: Synthesize conflicting claims. Directly arbitrate between primary claims and counter-arguments; state which hypothesis survives empirical evidence.');
    return lines.join('\n');
}
