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
                const candidateInsights = rep.insights || [];
                for (const ins of candidateInsights.slice(0, 3)) {
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
