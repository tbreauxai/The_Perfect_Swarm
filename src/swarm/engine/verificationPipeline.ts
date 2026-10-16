import type { Agent } from '../agent.ts';
import type { SwarmContext } from '../context.ts';
import { AnalysisLifecycle } from '../lifecycle.ts';
import { guardManagerResponse } from '../parser.ts';
import { globalSpecialistProfiler } from '../loadBalancer.ts';

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
        criticAgent.setSystemInstruction("You are the Swarm Verification Critic for Sports Betting Pre-game Judgment. Audit the proposed prediction strictly against the raw data, odds, injuries, and specialist reports. Ensure winProbHome (0.01-0.99), fairSpread, and likelyWinner are logically sound and formatted properly.");
    } else {
        criticAgent.setSystemInstruction("You are the Swarm Verification Critic. Audit proposed analyses strictly against the raw data, historical baselines, and analyst reports. Flag discrepancies, missed anomalies, or schema violations.");
    }

    const lifecycle = new AnalysisLifecycle(managerAgent, criticAgent, 2);
    context.addEvent({
        agentRole: 'Analysis Lifecycle',
        action: 'Deep Analysis Verification Loop Started',
        modelName: `${managerAgent.modelName} (${managerAgent.provider}) vs ${criticAgent.modelName} (${criticAgent.provider})`,
        prompt: `Auditing synthesized proposal against raw findings with cross-provider verification (max 2 attempts)`
    });

    const lifecycleResult = await lifecycle.executeAndVerify(
        {
            task,
            dataSample: rawInput.substring(0, 3000),
            analystReports: effectiveCompiledReports,
            historicalBaselines: effectiveHistoricalContext
        },
        context,
        effectiveDynamicPrompt,
        isMorningJudge
            ? "Verify whether this judgment accurately reflects matchup statistics and odds, calculates realistic win probabilities and fair spreads, and outputs valid judge JSON without hallucinations."
            : "Verify whether this analysis faithfully represents the analyst reports and data, strictly complies with all historical baselines and past lessons without hallucinations or omissions, and does the summary arbitrate analyst disagreements with deciding evidence rather than generic filler."
    );

    const finalProposal = lifecycleResult.finalProposal;
    const finalAnalysis = isMorningJudge || (finalProposal && typeof finalProposal === 'object' && ('winProbHome' in finalProposal || 'win_prob_home' in finalProposal))
        ? finalProposal
        : guardManagerResponse(finalProposal, "Executive Swarm Synthesis");

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
