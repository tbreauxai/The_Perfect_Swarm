import { describe, it, expect } from "vitest";
import {
  parseDeriveAndValidateJudgmentV2,
  parseAndValidateJudgmentV2,
  judgmentLeanBand,
  JUDGMENT_DEAD_BAND,
} from "../morning/judgment.ts";

/** Swarm-only tests: the shared judgment.v2.fixtures.json (canonical DuelOdds rules) is unchanged. */
const ids = { eventId: "e1", sport: "basketball_nba" };
const nba = (o: Record<string, unknown>) => ({
  side: "home",
  projMargin: 6,
  projTotal: 230,
  totalLean: "pass",
  confidence: 0.6,
  reasons: ["pace"],
  ...o,
});
const run = (
  o: Record<string, unknown>,
  market: Record<string, number | null>,
) => parseDeriveAndValidateJudgmentV2(nba(o), ids, market) as any;

describe("v2 total-lean fix: derive totalLean instead of rejecting", () => {
  it("a live-style mismatch (lean 'pass', projTotal 6.5 over) is corrected, not rejected", () => {
    const r = run({}, { spread: -3, total: 223.5 });
    expect(r.ok).toBe(true);
    expect(r.judgment).toMatchObject({ side: "home", totalLean: "over" });
    expect(r.corrections).toEqual([
      { field: "totalLean", model: "pass", derived: "over" },
    ]);
    // the canonical strict check still calls it a mismatch (mirror + shared fixtures unchanged)
    expect(
      parseAndValidateJudgmentV2(nba({}), ids, { spread: -3, total: 223.5 }),
    ).toMatchObject({
      ok: false,
      reason: "total_lean_mismatch",
    });
  });

  it("under, inside-band pass, and no market total keeps the model lean", () => {
    expect(
      run({ totalLean: "over" }, { spread: -3, total: 236 }).judgment.totalLean,
    ).toBe("under");
    expect(
      run({ projTotal: 224.5, totalLean: "over" }, { spread: -3, total: 223.5 })
        .judgment.totalLean,
    ).toBe("pass");
    expect(run({ totalLean: "under" }, { spread: -3 }).judgment.totalLean).toBe(
      "under",
    );
  });
});

describe("v2 side = ATS cover vs the home spread (cover = projMargin + spread, NBA band 1.5)", () => {
  it("margin positive but not covering → away (home -9, projMargin +6: cover -3)", () => {
    const r = run({ totalLean: "over" }, { spread: -9, total: 223.5 });
    expect(r.judgment.side).toBe("away");
    expect(r.sideBasis).toBe("spread");
    expect(r.corrections).toEqual([
      { field: "side", model: "home", derived: "away" },
    ]);
  });

  it("covering → home (home -3, projMargin +6: cover +3; model said away)", () => {
    const r = run(
      { side: "away", totalLean: "over" },
      { spread: -3, total: 223.5 },
    );
    expect(r.judgment.side).toBe("home");
  });

  it("inside the band → pass (home -5, projMargin +6: |cover| 1 < 1.5)", () => {
    expect(
      run({ totalLean: "over" }, { spread: -5, total: 223.5 }).judgment.side,
    ).toBe("pass");
  });

  it("home underdog: +4 spread, projMargin -2 → home covers (+2)", () => {
    expect(
      run(
        { side: "away", projMargin: -2, totalLean: "over" },
        { spread: 4, total: 223.5 },
      ).judgment.side,
    ).toBe("home");
  });

  it("no spread (moneyline only) → margin-sign fallback, flagged margin_fallback", () => {
    const r = run({ side: "away", totalLean: "over" }, { total: 223.5 });
    expect(r.judgment.side).toBe("home");
    expect(r.sideBasis).toBe("margin_fallback");
    expect(run({ projMargin: 1 }, {}).judgment.side).toBe("pass");
  });
});

describe("v2 derive path still rejects bad numbers", () => {
  it("NaN / missing / non-numeric numbers are rejected (schema)", () => {
    for (const bad of [
      { projTotal: NaN },
      { projMargin: "4" },
      { projTotal: undefined },
      { projMargin: Infinity },
    ]) {
      expect(run(bad, { total: 223.5 })).toMatchObject({
        ok: false,
        reason: "schema",
      });
    }
  });

  it("out-of-range / off-market numbers are rejected", () => {
    expect(run({ projTotal: 250 }, { total: 223.5 })).toMatchObject({
      ok: false,
      reason: "total_vs_market",
    });
    expect(run({ projMargin: 20 }, { spread: -3, total: 230 })).toMatchObject({
      ok: false,
      reason: "margin_vs_market",
    });
    expect(run({ projTotal: 300 }, {})).toMatchObject({
      ok: false,
      reason: "total_range",
    });
    expect(run({ projMargin: 40 }, {})).toMatchObject({
      ok: false,
      reason: "margin_range",
    });
  });

  it("bands are sport-aware; unknown sport falls back to the dead band", () => {
    expect(judgmentLeanBand("americanfootball_nfl")).toEqual({
      margin: 1,
      total: 1.5,
    });
    expect(judgmentLeanBand("icehockey_nhl").total).toBe(0.25);
    expect(judgmentLeanBand("soccer_epl")).toEqual({
      margin: JUDGMENT_DEAD_BAND,
      total: JUDGMENT_DEAD_BAND,
    });
  });
});
