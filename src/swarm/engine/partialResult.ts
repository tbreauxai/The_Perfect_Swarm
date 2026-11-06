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

/** Final analysis used when the whole manager chain failed: the best analyst output, flagged partial. */
export function buildPartialFinalAnalysis(
  best: BestAnalystOutput,
  degraded: string[],
): any {
  const rep = best.report || {};
  const insights: string[] = Array.isArray(rep.insights)
    ? rep.insights.map((i: any) => String(i))
    : [];
  const summary =
    [
      typeof rep.summary === "string" ? rep.summary : "",
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
