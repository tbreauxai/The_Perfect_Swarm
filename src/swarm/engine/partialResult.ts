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
