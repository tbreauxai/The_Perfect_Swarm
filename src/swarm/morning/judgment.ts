/**
 * Judgment v2 (math offload, design 2026-10-25). The LLM returns projections only (side, margin, total,
 * lean, confidence, reasons); probabilities, fair lines and EV are derived by code in DuelOdds.
 *
 * MIRROR: DuelOdds src/math/judgment.ts is canonical. This file mirrors it, and
 * judgment.v2.fixtures.json is kept byte-identical in both repos (judgment.test.ts runs it).
 * Self-contained on purpose (only zod): no imports from the rest of the swarm.
 */
import { z } from "zod";

/** JUDGMENT_SCHEMA_V2 gate. Off unless the env value is exactly "1" or "true". */
export function isJudgmentSchemaV2(
  env: Record<string, string | undefined> | undefined,
): boolean {
  const v = String(env?.JUDGMENT_SCHEMA_V2 ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true";
}

export const JudgmentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    eventId: z.string().min(1),
    sport: z.string().min(1),
    side: z.enum(["home", "away", "pass"]),
    /** home score minus away score; positive = home wins by that much */
    projMargin: z.number().finite(),
    projTotal: z.number().finite().positive(),
    totalLean: z.enum(["over", "under", "pass"]),
    /** 0..1, display/ranking only: used in no formula */
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1).max(140)).min(1).max(3),
  })
  .strict();
export type JudgmentV2 = z.infer<typeof JudgmentV2Schema>;

/** Absolute |projMargin| caps when there is no market spread. Sports not listed have no margin cap. */
export const JUDGMENT_MARGIN_LIMITS: Record<string, number> = {
  americanfootball_nfl: 35,
  americanfootball_ncaaf: 50,
  basketball_nba: 30,
  basketball_ncaab: 35,
  baseball_mlb: 8,
  icehockey_nhl: 5,
};

/** Absolute projTotal ranges when there is no market total (same values as judgePrompt JUDGE_TOTAL_RANGES). */
export const JUDGMENT_TOTAL_RANGES: Record<
  string,
  { min: number; max: number }
> = {
  americanfootball_nfl: { min: 30, max: 65 },
  americanfootball_ncaaf: { min: 30, max: 80 },
  basketball_nba: { min: 190, max: 260 },
  basketball_ncaab: { min: 110, max: 180 },
  basketball_wnba: { min: 130, max: 190 },
  baseball_mlb: { min: 5, max: 14 },
  baseball_ncaa: { min: 5, max: 18 },
  icehockey_nhl: { min: 4, max: 8 },
};

/** Max |projection - market| (reject, never clamp). marketSpread is home perspective (-3 = home favored by 3). */
export const JUDGMENT_MARKET_CAPS = { margin: 10, total: 12 };
/** |projMargin| below this means side must be 'pass'; |projTotal - marketTotal| below this means totalLean 'pass'. */
export const JUDGMENT_DEAD_BAND = 0.5;

export type JudgmentV2Failure =
  | "schema"
  | "side_mismatch"
  | "total_lean_mismatch"
  | "margin_vs_market"
  | "total_vs_market"
  | "margin_range"
  | "total_range";

export interface JudgmentMarket {
  spread?: number | null;
  total?: number | null;
}

export type JudgmentV2Result =
  | { ok: true; judgment: JudgmentV2 }
  | { ok: false; reason: JudgmentV2Failure; detail: string };

function looksLikeV2(o: any): boolean {
  return (
    !!o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    ("projMargin" in o || "projTotal" in o)
  );
}

function fromString(s: string): any {
  const t = s.trim();
  const tries: string[] = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf("{"),
    b = t.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const c of tries) {
    try {
      return JSON.parse(c);
    } catch {
      /* next */
    }
  }
  return null;
}

/** Finds the v2 object in a raw reply (string, object, or {finalAnalysis|judgment|result: ...}). */
export function extractJudgmentV2Candidate(
  raw: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (raw == null || depth > 3) return null;
  const v = typeof raw === "string" ? fromString(raw) : raw;
  if (looksLikeV2(v)) return v as Record<string, unknown>;
  if (v && typeof v === "object") {
    for (const k of ["finalAnalysis", "judgment", "result", "output"]) {
      const inner = extractJudgmentV2Candidate((v as any)[k], depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Rule a: strict schema. eventId, sport and schemaVersion are owned by code (overwritten, like a scorecard seat).
 * Any other extra key (fairLine, prob, ev, odds, stake, ...) is rejected.
 */
export function parseJudgmentV2(
  raw: unknown,
  ids: { eventId: string; sport: string },
): JudgmentV2Result {
  const cand = extractJudgmentV2Candidate(raw);
  if (!cand)
    return {
      ok: false,
      reason: "schema",
      detail: "no v2 judgment object (projMargin/projTotal) found",
    };
  const r = JudgmentV2Schema.safeParse({
    ...cand,
    schemaVersion: 2,
    eventId: ids.eventId,
    sport: ids.sport,
  });
  if (!r.success) {
    const i = r.error.issues[0];
    return {
      ok: false,
      reason: "schema",
      detail: `${i?.path?.join(".") || "(root)"}: ${i?.message ?? "invalid"}`,
    };
  }
  return { ok: true, judgment: r.data };
}

/** Rules b (consistency) and c (clamps: reject, never clamp). Rule d (market sanity) is DuelOdds-only. */
export function validateJudgmentV2(
  j: JudgmentV2,
  market?: JudgmentMarket,
): JudgmentV2Result {
  const m = j.projMargin;
  const wantSide =
    Math.abs(m) < JUDGMENT_DEAD_BAND ? "pass" : m > 0 ? "home" : "away";
  if (j.side !== wantSide) {
    return {
      ok: false,
      reason: "side_mismatch",
      detail: `side ${j.side} but projMargin ${m} means ${wantSide}`,
    };
  }
  const mt = market?.total;
  const ms = market?.spread;
  const hasTotal = typeof mt === "number" && Number.isFinite(mt);
  const hasSpread = typeof ms === "number" && Number.isFinite(ms);
  if (hasTotal) {
    const d = j.projTotal - mt;
    const wantLean =
      Math.abs(d) < JUDGMENT_DEAD_BAND ? "pass" : d > 0 ? "over" : "under";
    if (j.totalLean !== wantLean) {
      return {
        ok: false,
        reason: "total_lean_mismatch",
        detail: `totalLean ${j.totalLean} but projTotal ${j.projTotal} vs market ${mt} means ${wantLean}`,
      };
    }
    if (Math.abs(d) > JUDGMENT_MARKET_CAPS.total) {
      return {
        ok: false,
        reason: "total_vs_market",
        detail: `|projTotal ${j.projTotal} - market ${mt}| > ${JUDGMENT_MARKET_CAPS.total}`,
      };
    }
  } else {
    const range = JUDGMENT_TOTAL_RANGES[j.sport.toLowerCase().trim()];
    if (range && (j.projTotal < range.min || j.projTotal > range.max)) {
      return {
        ok: false,
        reason: "total_range",
        detail: `projTotal ${j.projTotal} outside ${range.min}-${range.max}`,
      };
    }
  }
  if (hasSpread) {
    if (Math.abs(m - -ms) > JUDGMENT_MARKET_CAPS.margin) {
      return {
        ok: false,
        reason: "margin_vs_market",
        detail: `|projMargin ${m} - market margin ${-ms}| > ${JUDGMENT_MARKET_CAPS.margin}`,
      };
    }
  } else {
    const cap = JUDGMENT_MARGIN_LIMITS[j.sport.toLowerCase().trim()];
    if (cap != null && Math.abs(m) > cap) {
      return {
        ok: false,
        reason: "margin_range",
        detail: `|projMargin ${m}| > ${cap}`,
      };
    }
  }
  return { ok: true, judgment: j };
}

/** parse (a) then validate (b, c). */
export function parseAndValidateJudgmentV2(
  raw: unknown,
  ids: { eventId: string; sport: string },
  market?: JudgmentMarket,
): JudgmentV2Result {
  const p = parseJudgmentV2(raw, ids);
  return p.ok ? validateJudgmentV2(p.judgment, market) : p;
}

export type EvColumn = "ev_home" | "ev_away" | "ev_over" | "ev_under";

/** S7: the picked side's code-derived EV column on game_judgments. 'pass' or anything else has none. */
export function sideEvColumn(side: string | null | undefined): EvColumn | null {
  switch (side) {
    case "home":
      return "ev_home";
    case "away":
      return "ev_away";
    case "over":
      return "ev_over";
    case "under":
      return "ev_under";
    default:
      return null;
  }
}
