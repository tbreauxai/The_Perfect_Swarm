import type { SwarmContext } from "../context.ts";
import { guardManagerResponse } from "../parser.ts";

/**
 * 'partial' ONLY when the final answer did not come from the manager (the whole manager chain failed and the
 * best analyst output was returned). Seats that failed with no backup are listed in `degraded` but keep 'complete'.
 */
export type SwarmRunStatus = "complete" | "partial";

const DEGRADED_KEY = "__degradedSeats";

/** Record a seat id (agent id, else role) that exhausted every fallback. A seat that recovered via a fallback is never recorded. */
export function recordDegraded(context: SwarmContext, seatId: string): void {
  const ctx = context as any;
  if (!Array.isArray(ctx[DEGRADED_KEY])) ctx[DEGRADED_KEY] = [];
  const id = String(seatId);
  if (!ctx[DEGRADED_KEY].includes(id)) ctx[DEGRADED_KEY].push(id);
}

export function getDegraded(context: SwarmContext): string[] {
  const list = (context as any)[DEGRADED_KEY];
  return Array.isArray(list) ? [...list] : [];
}

export function countAnalystOutputs(allAnalystReports: any[][]): number {
  return (allAnalystReports || []).reduce(
    (n, reps) =>
      n + (reps || []).filter((r) => r !== null && r !== undefined).length,
    0,
  );
}

export interface BestAnalystOutput {
  seatId: string;
  role: string;
  provider: string;
  report: any;
}

/** Picks the richest analyst report (most insights, then anomalies, then summary length). */
export function pickBestAnalystOutput(
  allAnalystReports: any[][],
  analysts: Array<{ role: string; provider: any; id?: string }>,
): BestAnalystOutput | null {
  let best: BestAnalystOutput | null = null;
  let bestScore = -1;
  (allAnalystReports || []).forEach((reps, idx) => {
    for (const rep of reps || []) {
      if (rep === null || rep === undefined) continue;
      const insights = Array.isArray(rep.insights) ? rep.insights.length : 0;
      const anomalies = Array.isArray(rep.anomalies) ? rep.anomalies.length : 0;
      const summaryLen =
        typeof rep.summary === "string" ? rep.summary.length : 0;
      const score =
        insights * 10 + anomalies * 5 + Math.min(summaryLen, 2000) / 100;
      if (score > bestScore) {
        bestScore = score;
        const role = analysts[idx]?.role || `Analyst ${idx + 1}`;
        best = {
          seatId: analysts[idx]?.id || role,
          role,
          provider: String(analysts[idx]?.provider ?? "unknown"),
          report: rep,
        };
      }
    }
  });
  return best;
}

export interface PartialFallbackCriticContext {
  isBettingRun?: boolean;
  criticRan?: boolean;
  criticPassed?: boolean;
  criticApproved?: boolean;
  vetoedLegs?: Array<{ eventId?: string; rowId?: string; row?: string; team?: string; reason?: string }>;
  vetoTexts?: string[];
  seatScorecards?: any[];
  allAnalystReports?: any[][];
}

function isPickVetoedByTargets(
  pick: any,
  vetoedLegs: Array<{ eventId?: string; rowId?: string; row?: string; team?: string; reason?: string }> | undefined,
): boolean {
  if (!Array.isArray(vetoedLegs) || vetoedLegs.length === 0) return false;
  const pEv = String(pick?.eventId || pick?.event_id || pick?.gameId || pick?.game_id || "").toLowerCase().trim();
  const pRow = String(pick?.row || pick?.rowId || pick?.row_id || "").toUpperCase().trim();
  const pText = (typeof pick === "string"
    ? pick
    : [pick?.row, pick?.rowId, pick?.team, pick?.pick, pick?.selection, pick?.market, pick?.label, pick?.matchup]
        .filter(Boolean)
        .join(" ")
  ).toLowerCase();
  return vetoedLegs.some((v) => {
    const vEv = String(v?.eventId || "").toLowerCase().trim();
    const vRow = String(v?.rowId || v?.row || "").toUpperCase().trim();
    const vTeam = String(v?.team || "").toLowerCase().trim();
    if (vEv && pEv && vEv === pEv) return true;
    if (vRow && (pRow === vRow || new RegExp(`\\b${vRow}\\b`, "i").test(pText))) return true;
    if (vTeam && vTeam.length >= 3 && pText.includes(vTeam)) return true;
    return false;
  });
}

function formatConcisePickLabel(pick: any): string {
  if (typeof pick === "string") return pick.trim();
  if (!pick || typeof pick !== "object") return String(pick || "").trim();
  const row = String(pick.row || pick.rowId || pick.row_id || "").toUpperCase().trim();
  const teamOrPick = String(pick.pick || pick.selection || pick.label || pick.team || "").trim();
  const market = String(pick.market || "").trim();
  const line = pick.line !== undefined && pick.line !== null && String(pick.line).trim() !== ""
    ? String(pick.line).trim()
    : "";
  const ev = String(pick.eventId || pick.event_id || "").trim();
  const parts: string[] = [];
  if (row) parts.push(`[${row}]`);
  if (teamOrPick) parts.push(teamOrPick);
  if (line && !teamOrPick.includes(line)) parts.push(line);
  if (market && !teamOrPick.toLowerCase().includes(market.toLowerCase())) parts.push(`(${market})`);
  if (parts.length === 0 && ev) parts.push(ev);
  return parts.join(" ").trim();
}

function collectApprovedFallbackPicks(
  best: BestAnalystOutput,
  criticContext: PartialFallbackCriticContext,
): any[] {
  const candidates: any[] = [];
  const pushFromReport = (rep: any) => {
    if (!rep || typeof rep !== "object") return;
    const roleLabel = String(rep.seat || rep.role || "").toLowerCase();
    if (roleLabel.includes("critic") || roleLabel.includes("risk")) return;
    if (Array.isArray(rep.picks)) candidates.push(...rep.picks);
  };
  pushFromReport(best.report);
  if (candidates.length === 0 && Array.isArray(criticContext.allAnalystReports)) {
    for (const reps of criticContext.allAnalystReports) {
      for (const r of reps || []) pushFromReport(r);
    }
  }
  const seen = new Set<string>();
  const out: any[] = [];
  for (const pk of candidates) {
    if (!pk) continue;
    if (isPickVetoedByTargets(pk, criticContext.vetoedLegs)) continue;
    const key = typeof pk === "string"
      ? pk.toLowerCase().trim()
      : `${String(pk.row || pk.rowId || pk.row_id || "").toUpperCase()}|${String(pk.eventId || pk.event_id || "").toLowerCase()}|${String(pk.pick || pk.selection || pk.team || pk.label || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pk);
  }
  return out;
}

/** Final analysis used when the whole manager chain failed: deterministic Critic-gated partial fallback. */
export function buildPartialFinalAnalysis(
  best: BestAnalystOutput,
  degraded: string[],
  criticContext?: PartialFallbackCriticContext,
): any {
  const rep = best.report || {};
  const degradedList = degraded.includes("manager") ? [...degraded] : [...degraded, "manager"];

  // S4: Betting/picks runs or runs with explicit Critic context enforce deterministic Critic gating
  const hasBettingOrCriticContext = Boolean(
    criticContext &&
      (criticContext.isBettingRun ||
        criticContext.criticRan !== undefined ||
        criticContext.criticApproved !== undefined ||
        criticContext.criticPassed !== undefined ||
        (Array.isArray(rep.picks) && rep.picks.length > 0)),
  );

  if (hasBettingOrCriticContext && criticContext) {
    const scorecards = Array.isArray(criticContext.seatScorecards)
      ? [...criticContext.seatScorecards]
      : [];
    const criticApproved =
      criticContext.criticApproved === true ||
      (criticContext.criticRan === true && criticContext.criticPassed === true);

    if (criticApproved) {
      const approvedPicks = collectApprovedFallbackPicks(best, criticContext);
      if (approvedPicks.length > 0) {
        const pickLabels = approvedPicks.map(formatConcisePickLabel).filter(Boolean);
        const legCountLabel =
          approvedPicks.length === 1
            ? "1-leg pick"
            : `${approvedPicks.length}-leg parlay`;
        const summary = `Manager synthesis unavailable (partial fallback); Risk Critic approved ${legCountLabel}: ${pickLabels.join("; ")}.`;
        const guarded: any = guardManagerResponse(
          {
            ui_title: `Partial Analysis (${legCountLabel}, Critic Approved)`,
            summary,
            components: [],
          },
          "Partial Analysis",
        );
        return {
          ...guarded,
          summary,
          analysis: summary,
          picks: approvedPicks,
          criticApproved: true,
          wageringPass: false,
          verified: false,
          partial: true,
          degraded: degradedList,
          scorecards,
          sourceAnalyst: {
            seatId: best.seatId,
            role: best.role,
            provider: best.provider,
          },
          analystReport: rep,
        };
      }
    }

    // Fail closed when Risk Critic did not run, returned pass: false, or left zero unvetoed picks
    const failClosedReason =
      criticContext.criticRan && criticContext.criticPassed === false
        ? `Manager synthesis unavailable and Risk Critic did not approve proposed picks${Array.isArray(criticContext.vetoTexts) && criticContext.vetoTexts.length > 0 ? `: ${criticContext.vetoTexts[0]}` : ""}. Failing closed with NO PLAY.`
        : "Manager synthesis unavailable without Risk Critic approval. Failing closed with NO PLAY.";
    const guarded: any = guardManagerResponse(
      {
        ui_title: "NO PLAY (Partial Fallback)",
        summary: failClosedReason,
        components: [],
      },
      "NO PLAY",
    );
    return {
      ...guarded,
      summary: failClosedReason,
      analysis: failClosedReason,
      picks: [],
      components: [],
      pass: true,
      status: "no_play",
      criticApproved: false,
      wageringPass: true,
      verified: false,
      partial: true,
      degraded: degradedList,
      scorecards,
      sourceAnalyst: {
        seatId: best.seatId,
        role: best.role,
        provider: best.provider,
      },
      analystReport: rep,
    };
  }

  // Legacy non-betting fallback path (preserves non-betting PS1 semantics without duplicating summary in Key points)
  const rawSummary = typeof rep.summary === "string" ? rep.summary.trim() : "";
  const insights: string[] = Array.isArray(rep.insights)
    ? rep.insights
        .map((i: any) => String(i).trim())
        .filter((s: string) => Boolean(s) && (!rawSummary || !rawSummary.includes(s)))
    : [];
  const summary =
    [
      rawSummary,
      insights.length > 0
        ? `Key points: ${insights.slice(0, 8).join(" | ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n") || "Partial result: only analyst output was available.";
  const guarded: any = guardManagerResponse(
    {
      ui_title: `Partial Analysis (from ${best.role})`,
      summary,
      components: [],
    },
    "Partial Analysis",
  );
  return {
    ...guarded,
    partial: true,
    degraded,
    sourceAnalyst: {
      seatId: best.seatId,
      role: best.role,
      provider: best.provider,
    },
    analystReport: rep,
  };
}

export interface EmergencySynthesisParams {
  analysts: Array<{ role: string; provider: any; id?: string; run?: (prompt: string, context: any, config?: any) => Promise<any> }>;
  allAnalystReports: any[][];
  bestAnalyst: BestAnalystOutput;
  degraded: string[];
  context: SwarmContext;
  emergencyModelAgent?: { run: (prompt: string, context: any, config?: any) => Promise<any> };
}

/**
 * Context-Aware Emergency Synthesis Fallback.
 * Dispatches a stripped emergency prompt to an available fast model with a strict 200-token cap.
 * If this fails or throws, gracefully falls back to pickBestAnalystOutput.
 */
export async function executeEmergencySynthesis(params: EmergencySynthesisParams): Promise<any> {
  const { analysts, allAnalystReports, bestAnalyst, degraded, context, emergencyModelAgent } = params;

  // 1. Gather top analyst insights
  const allInsights: string[] = [];
  for (const reps of allAnalystReports || []) {
    for (const r of reps || []) {
      if (r && Array.isArray(r.insights)) {
        for (const ins of r.insights) {
          if (typeof ins === 'string' && ins.trim()) {
            allInsights.push(ins.trim());
          }
        }
      }
    }
  }

  const topInsights = allInsights.slice(0, 5);
  const candidateAgent = emergencyModelAgent || (analysts || []).find(a => typeof a.run === 'function');

  if (candidateAgent && typeof candidateAgent.run === 'function' && topInsights.length > 0) {
    try {
      const emergencyPrompt = `EMERGENCY: Swarm manager synthesis failed. Given the following top analyst insights, generate a bare-bones 2-sentence executive summary and list key findings.\n\nTop Analyst Insights:\n${topInsights.map((ins, i) => `${i + 1}. ${ins}`).join('\n')}\n\nRespond with strict JSON matching: {"ui_title": "Emergency Executive Synthesis", "summary": "...", "components": []}`;

      const raw = await candidateAgent.run(emergencyPrompt, context, {
        maxTokens: 200,
        maxTokensCap: 200,
        responseMimeType: "application/json"
      });

      const guarded = guardManagerResponse(raw, "Emergency Executive Synthesis");
      if (guarded && guarded.summary) {
        context.addEvent({
          agentRole: 'Emergency Synthesis Fallback',
          action: 'Emergency Synthesis Completed',
          modelName: 'Local/EmergencySynthesis',
          prompt: 'Manager synthesis failed; emergency 200-token synthesis succeeded.',
          output: { summary: guarded.summary }
        });
        return {
          ...guarded,
          partial: true,
          degraded,
          emergencyFallback: true
        };
      }
    } catch {
      // Emergency synthesis threw; fall back to pickBestAnalystOutput
    }
  }

  return buildPartialFinalAnalysis(bestAnalyst, degraded);
}
