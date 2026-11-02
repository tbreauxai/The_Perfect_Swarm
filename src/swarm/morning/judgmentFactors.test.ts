import { describe, it, expect } from "vitest";
import {
  parseJudgmentV2,
  parseDeriveAndValidateJudgmentV2,
  validateJudgmentV2,
  type JudgmentV2,
} from "./judgment.ts";

const IDS = { eventId: "evt-1", sport: "americanfootball_nfl" };
const base = {
  side: "home",
  projMargin: 3.5,
  projTotal: 44.5,
  totalLean: "under",
  confidence: 0.6,
  reasons: ["Wind 20 mph"],
};
const wind = { id: "wind_high", evidence: { kind: "espn_field", ref: "weather.windSpeed" } };
const ON = { factors: true };

describe("JUDGMENT_FACTORS off (default): unchanged", () => {
  it("a judgment without factors parses exactly as before", () => {
    const r = parseJudgmentV2(base, IDS);
    expect(r.ok).toBe(true);
    expect((r as any).judgment.factors).toBeUndefined();
  });
  it("a factors key is still rejected as schema", () => {
    const r = parseJudgmentV2({ ...base, factors: [wind] }, IDS);
    expect(r).toMatchObject({ ok: false, reason: "schema" });
  });
});

describe("JUDGMENT_FACTORS on: schema", () => {
  it("accepts known ids with evidence", () => {
    const r = parseJudgmentV2({ ...base, factors: [wind] }, IDS, ON);
    expect(r.ok).toBe(true);
    expect((r as any).judgment.factors).toEqual([wind]);
  });
  it("absent factors is fine", () => {
    expect(parseJudgmentV2(base, IDS, ON).ok).toBe(true);
  });
  it.each([
    ["unknown id", [{ id: "vibes", evidence: { kind: "espn_field", ref: "x" } }]],
    ["missing evidence", [{ id: "wind_high" }]],
    ["empty ref", [{ id: "wind_high", evidence: { kind: "espn_field", ref: "" } }]],
    ["bad kind", [{ id: "wind_high", evidence: { kind: "tweet", ref: "x" } }]],
    ["a magnitude", [{ ...wind, delta: 0.2 }]],
    ["a direction", [{ ...wind, direction: "under" }]],
    ["more than 4", Array(5).fill(wind)],
  ])("rejects %s", (_n, factors) => {
    expect(parseJudgmentV2({ ...base, factors }, IDS, ON)).toMatchObject({ ok: false, reason: "schema" });
  });
});

describe("JUDGMENT_FACTORS on: validator (reject, never clamp)", () => {
  const j = (sport: string, factors: any[]): JudgmentV2 =>
    ({ schemaVersion: 2, eventId: "e", sport, ...base, factors }) as JudgmentV2;

  it("rejects a factor for the wrong sport", () => {
    expect(validateJudgmentV2(j("basketball_nba", [wind]))).toMatchObject({ ok: false, reason: "factor_invalid" });
  });
  it("rejects duplicates", () => {
    expect(validateJudgmentV2(j("americanfootball_nfl", [wind, wind]))).toMatchObject({
      ok: false,
      reason: "factor_invalid",
    });
  });
  it("rejects a url off the allow-list and accepts one on it", () => {
    const bad = { id: "wind_high", evidence: { kind: "url", ref: "https://example.com/w" } };
    const good = { id: "wind_high", evidence: { kind: "url", ref: "https://api.weather.gov/gridpoints/EAX/1,2" } };
    expect(validateJudgmentV2(j("americanfootball_nfl", [bad]))).toMatchObject({ ok: false, reason: "factor_invalid" });
    expect(validateJudgmentV2(j("americanfootball_nfl", [good])).ok).toBe(true);
  });
  it("swarm runtime path passes the flag through", () => {
    const raw = JSON.stringify({ ...base, factors: [wind] });
    expect(parseDeriveAndValidateJudgmentV2(raw, IDS, { spread: -3, total: 47 }).ok).toBe(false);
    const on = parseDeriveAndValidateJudgmentV2(raw, IDS, { spread: -3, total: 47 }, ON);
    expect(on.ok).toBe(true);
    expect((on as any).judgment.factors).toEqual([wind]);
  });
});
