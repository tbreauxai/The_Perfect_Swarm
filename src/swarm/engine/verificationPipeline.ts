import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { guardManagerResponse } from '../parser.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';
import { getManagerContextTokenCeiling } from './synthesisPipeline.ts';
import { parseGameHeaders, renderHeaders, filterPicksByCoverage } from '../context/gameHeaders.ts';
import { INJURY_ATTRIBUTION_RULE, sanitizeMisattributedPicksAndText } from '../tools/injuryAttribution.ts';

import type { SwarmEngineSettings } from '../types.ts';

export interface VerificationPipelineParams {
    task: string;
    rawInput: string;
    effectiveDynamicPrompt: string;
    effectiveCompiledReports: string;
    effectiveHistoricalContext: string;
    managerAgent: Agent;
    analysts: Agent[];
    dedicatedCriticAgent: Agent | null;
    context: SwarmContext;
    settings?: SwarmEngineSettings;
    coveredEventIds?: string[];
    toolResults?: string;
}

export interface VerificationPipelineResult {
    finalAnalysis: any;
    lifecycleResult: any;
}

export async function runDeepAnalysisVerification(
    p: VerificationPipelineParams,
    settingsOverride?: SwarmEngineSettings
): Promise<VerificationPipelineResult> {
    const {
        task,
        rawInput,
        effectiveDynamicPrompt,
        effectiveCompiledReports,
        effectiveHistoricalContext,
        managerAgent,
        analysts,
        dedicatedCriticAgent,
        context,
        settings: paramSettings
    } = p;
    const settings = settingsOverride || paramSettings;

    // Select critic: Prefer dedicated critic, then cross-provider analyst (different from manager), then first analyst
    const crossProviderAnalyst = analysts.find(a => a.provider !== managerAgent.provider);
    const criticAgent = dedicatedCriticAgent || crossProviderAnalyst || analysts[0];

    const isMorningJudge = (settings as any)?.responseSchema === 'morning_judge';
    if (isMorningJudge) {
        criticAgent.setSystemInstruction(`You are the Swarm Verification Critic for Sports Betting Pre-game Judgment. Audit the proposed prediction strictly against the raw data, odds, injuries, and specialist reports. Ensure winProbHome (0.01-0.99), fairSpread, and likelyWinner are logically sound and formatted properly. Team names in Game Slate are authoritative; never rename or flag them.\n\n${INJURY_ATTRIBUTION_RULE}`);
    } else {
        criticAgent.setSystemInstruction(`You are the Swarm Verification Critic. Audit proposed analyses strictly against the raw data, historical baselines, and analyst reports. Systematically evaluate and attempt to refute hypotheses formulated by specialists. Flag discrepancies, missed anomalies, ungrounded assumptions, or schema violations. VETO POLICY: Only fail ("pass": false) a betting proposal when a recommended pick leg itself has a fatal injury, fabricated stat/odds, missing coverage on that leg, or direct rule violation; do not veto valid proposed picks just because other unpicked games on the slate have heavy injuries or incomplete roster data. Team names in Game Slate are authoritative; never rename or flag them.\n\n${INJURY_ATTRIBUTION_RULE}`);
    }

    const lifecycle = new AnalysisLifecycle(managerAgent, criticAgent, 2);
    context.addEvent({
        agentRole: 'Analysis Lifecycle',
        action: 'Deep Analysis Verification Loop Started',
        modelName: `${managerAgent.modelName} (${managerAgent.provider}) vs ${criticAgent.modelName} (${criticAgent.provider})`,
        prompt: `Auditing synthesized proposal against raw findings with cross-provider verification (max 2 attempts)`
    });

    const parsedHeaders = parseGameHeaders(rawInput || task, (p as any)?.params?.eventIds);
    const headersText = renderHeaders(parsedHeaders, 1600);

    const lifecycleResult = await lifecycle.executeAndVerify(
        {
            task,
            dataSample: headersText,
            rawBoard: headersText,
            analystReports: effectiveCompiledReports,
            historicalBaselines: effectiveHistoricalContext,
            coveredEventIds: p.coveredEventIds,
            ...(p.toolResults ? { toolResults: p.toolResults } : {}),
            ...((p as any).appComputedCounts ? { appComputedCounts: (p as any).appComputedCounts } : {})
        },
        context,
        effectiveDynamicPrompt,
        isMorningJudge
            ? "Verify whether this judgment accurately reflects matchup statistics and odds, calculates realistic win probabilities and fair spreads, and outputs valid judge JSON without hallucinations."
            : "Verify whether this analysis faithfully represents the analyst reports and data, strictly complies with all historical baselines and past lessons without hallucinations or omissions, and does the summary arbitrate analyst disagreements with deciding evidence rather than generic filler, and systematically test and refute ungrounded hypotheses.",
        p.coveredEventIds
    );

    const finalProposal = lifecycleResult.finalProposal;
    const finalAnalysis = isMorningJudge || (finalProposal && typeof finalProposal === 'object' && ('winProbHome' in finalProposal || 'win_prob_home' in finalProposal))
        ? finalProposal
        : guardManagerResponse(finalProposal, "Executive Swarm Synthesis");

    if (finalAnalysis && typeof finalAnalysis === 'object') {
        if (lifecycleResult.success === false) {
            finalAnalysis.verified = false;
            finalAnalysis.verification = {
                success: false,
                attempts: lifecycleResult.attempts,
                rating: lifecycleResult.computedRating
            };
            finalAnalysis.picks = [];
            finalAnalysis.components = [];
            const rawSummary = typeof finalAnalysis.summary === 'string' && finalAnalysis.summary.trim()
                ? finalAnalysis.summary.trim()
                : (typeof finalAnalysis.reason === 'string' && finalAnalysis.reason.trim() ? finalAnalysis.reason.trim() : 'Verification failed.');
            finalAnalysis.summary = /^\[unverified\]/i.test(rawSummary) ? rawSummary : `[UNVERIFIED] ${rawSummary}`;
        } else {
            finalAnalysis.verified = true;
            finalAnalysis.verification = {
                success: true,
                attempts: lifecycleResult.attempts,
                rating: lifecycleResult.computedRating
            };
            if (p.toolResults) {
                sanitizeMisattributedPicksAndText(finalAnalysis, p.toolResults, headersText || rawInput || task);
            }
        }
    }

    if (p.coveredEventIds && Array.isArray(finalAnalysis?.picks)) {
        const originalCount = finalAnalysis.picks.length;
        finalAnalysis.picks = filterPicksByCoverage(finalAnalysis.picks, p.coveredEventIds, parsedHeaders);
        if (finalAnalysis.picks.length === 0 && originalCount > 0) {
            finalAnalysis.ui_title = 'Insufficient data';
            finalAnalysis.reason = 'no picks with specialist coverage';
        }
    }

    if (lifecycleResult?.computedRating && analysts.length > 0) {
        const isVerifiedSuccess = !finalAnalysis?.ui_title?.toLowerCase().includes("error");
        for (const analyst of analysts) {
            globalSpecialistProfiler.recordOutcome(analyst.role, {
                success: isVerifiedSuccess,
                qualityRating: lifecycleResult.computedRating
            });
        }
    }

    return {
        finalAnalysis,
        lifecycleResult
    };
}
